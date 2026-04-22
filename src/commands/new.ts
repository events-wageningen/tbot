import { InlineKeyboard } from "grammy";
import type { Conversation, ConversationFlavor } from "@grammyjs/conversations";
import type { Context } from "grammy";
import { getSupabase, getCategories, type Category } from "../lib/supabase.js";
import { uploadImage, triggerDeploy } from "../lib/github.js";
import { toEventId } from "../lib/slugify.js";

export type BotContext = Context & ConversationFlavor;
export type BotConversation = Conversation<BotContext>;

// ── Date picker helpers ───────────────────────────────────────────────────────

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatYMD(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate(); // month is 1-based here
}

const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/**
 * Three-step date picker: year → month → day.
 * Returns YYYY-MM-DD or null on /cancel.
 */
async function askDate(
  conversation: BotConversation,
  ctx: BotContext,
  prompt: string
): Promise<string | null> {
  const thisYear = new Date().getFullYear();

  // ── Step 1: Year ──────────────────────────────────────────────────────────
  const yearKb = new InlineKeyboard()
    .text(String(thisYear), `dp:y:${thisYear}`)
    .text(String(thisYear + 1), `dp:y:${thisYear + 1}`);

  await ctx.reply(`📅 ${prompt} — pick a year:`, { reply_markup: yearKb });

  let year = 0;
  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") {
      await ctx.reply("❌ Cancelled. Use /new to start again.");
      return null;
    }
    if (upd.callbackQuery?.data?.startsWith("dp:y:")) {
      await upd.answerCallbackQuery();
      year = parseInt(upd.callbackQuery.data.replace("dp:y:", ""));
      break;
    }
  }

  // ── Step 2: Month ─────────────────────────────────────────────────────────
  const monthKb = new InlineKeyboard();
  MONTH_LABELS.forEach((label, i) => {
    monthKb.text(label, `dp:m:${i + 1}`);
    if (i % 4 === 3) monthKb.row();
  });

  await ctx.reply(`📅 ${prompt} ${year} — pick a month:`, { reply_markup: monthKb });

  let month = 0;
  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") {
      await ctx.reply("❌ Cancelled. Use /new to start again.");
      return null;
    }
    if (upd.callbackQuery?.data?.startsWith("dp:m:")) {
      await upd.answerCallbackQuery();
      month = parseInt(upd.callbackQuery.data.replace("dp:m:", ""));
      break;
    }
  }

  // ── Step 3: Day ───────────────────────────────────────────────────────────
  const totalDays = daysInMonth(year, month);
  const dayKb = new InlineKeyboard();
  for (let d = 1; d <= totalDays; d++) {
    dayKb.text(String(d), `dp:d:${d}`);
    if (d % 7 === 0) dayKb.row();
  }

  const monthName = MONTH_LABELS[month - 1];
  await ctx.reply(`📅 ${prompt} ${monthName} ${year} — pick a day:`, { reply_markup: dayKb });

  let day = 0;
  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") {
      await ctx.reply("❌ Cancelled. Use /new to start again.");
      return null;
    }
    if (upd.callbackQuery?.data?.startsWith("dp:d:")) {
      await upd.answerCallbackQuery();
      day = parseInt(upd.callbackQuery.data.replace("dp:d:", ""));
      break;
    }
  }

  const result = formatYMD(year, month, day);
  await ctx.reply(`📅 Selected: ${day} ${monthName} ${year}`);
  return result;
}

/**
 * End-date picker: offers "Same as start date" or runs the full date picker.
 */
async function askEndDate(
  conversation: BotConversation,
  ctx: BotContext,
  startDateYMD: string
): Promise<string | null> {
  const [y, m, d] = startDateYMD.split("-");
  const monthName = MONTH_LABELS[parseInt(m) - 1];
  const display = `${parseInt(d)} ${monthName} ${y}`;

  const kb = new InlineKeyboard()
    .text(`📅 Same (${display})`, "dp:end:same")
    .text("📅 Other date", "dp:end:other");

  await ctx.reply("📅 End date:", { reply_markup: kb });

  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") {
      await ctx.reply("❌ Cancelled. Use /new to start again.");
      return null;
    }
    if (upd.callbackQuery?.data === "dp:end:same") {
      await upd.answerCallbackQuery();
      await ctx.reply(`📅 End date: same as start (${display})`);
      return startDateYMD;
    }
    if (upd.callbackQuery?.data === "dp:end:other") {
      await upd.answerCallbackQuery();
      return await askDate(conversation, ctx, "End date");
    }
  }
}

/** Ask for a time via inline keyboard (common times) or free text. Returns HH:MM or null. */
async function askTime(
  conversation: BotConversation,
  ctx: BotContext,
  prompt: string
): Promise<string | null> {
  const times = [
    "08:00","09:00","10:00",
    "11:00","12:00","13:00",
    "14:00","15:00","16:00",
    "17:00","18:00","19:00",
    "20:00","21:00","22:00",
  ];
  const kb = new InlineKeyboard();
  times.forEach((t, i) => {
    kb.text(t, `time:${t}`);
    if (i % 3 === 2) kb.row();
  });
  kb.row().text("✍️ Other", "time:other");

  await ctx.reply(prompt, { reply_markup: kb });

  while (true) {
    const upd = await conversation.wait();

    if (upd.message?.text?.trim() === "/cancel") {
      await ctx.reply("❌ Cancelled. Use /new to start again.");
      return null;
    }

    if (upd.callbackQuery?.data?.startsWith("time:")) {
      await upd.answerCallbackQuery();
      const val = upd.callbackQuery.data.replace("time:", "");
      if (val !== "other") return val;

      // Ask for free-text time
      await ctx.reply("⏰ Enter time (HH:MM):");
      while (true) {
        const { message: m } = await conversation.waitFor("message:text");
        if (m.text.trim() === "/cancel") {
          await ctx.reply("❌ Cancelled. Use /new to start again.");
          return null;
        }
        const t = m.text.trim();
        if (/^\d{1,2}:\d{2}$/.test(t)) return t.padStart(5, "0");
        await ctx.reply("⚠️ Invalid format, expected HH:MM. Try again:");
      }
    }

    // User typed a time directly instead of using keyboard
    if (upd.message?.text) {
      const t = upd.message.text.trim();
      if (/^\d{1,2}:\d{2}$/.test(t)) return t.padStart(5, "0");
      await ctx.reply("⚠️ Please tap a time button or enter HH:MM:");
    }
  }
}

/** Multi-select category keyboard. Returns array of selected category IDs. */
async function askCategories(
  conversation: BotConversation,
  ctx: BotContext,
  categories: Category[]
): Promise<string[] | null> {
  const selected = new Set<string>();

  const buildKeyboard = () => {
    const kb = new InlineKeyboard();
    categories.forEach((cat, i) => {
      const on = selected.has(cat.id);
      const label = on ? `✅ ${cat.emoji} ${cat.label}` : `${cat.emoji} ${cat.label}`;
      kb.text(label, `cat:${cat.id}`);
      if (i % 2 === 1) kb.row();
    });
    if (categories.length % 2 !== 0) kb.row();
    kb.text("✅ Done", "cat:done");
    return kb;
  };

  const catMsg = await ctx.reply("🏷 Select categories (tap to toggle, then Done):", {
    reply_markup: buildKeyboard(),
  });
  const chatId = ctx.chat!.id;
  const msgId = catMsg.message_id;

  while (true) {
    const upd = await conversation.wait();

    if (upd.message?.text?.trim() === "/cancel") {
      await ctx.reply("❌ Cancelled. Use /new to start again.");
      return null;
    }

    if (!upd.callbackQuery?.data?.startsWith("cat:")) continue;

    await upd.answerCallbackQuery();
    const data = upd.callbackQuery.data;

    if (data === "cat:done") {
      if (selected.size === 0) {
        await upd.answerCallbackQuery("⚠️ Select at least one category");
        continue;
      }
      // Remove the inline keyboard from the message
      await ctx.api.editMessageReplyMarkup(chatId, msgId);
      await ctx.reply(`🏷 Selected: ${[...selected].join(", ")}`);
      return [...selected];
    }

    const catId = data.replace("cat:", "");
    if (selected.has(catId)) selected.delete(catId);
    else selected.add(catId);

    await ctx.api.editMessageReplyMarkup(chatId, msgId, {
      reply_markup: buildKeyboard(),
    });
  }
}

// ── City picker ──────────────────────────────────────────────────────────────

const CITIES = ["Wageningen", "Droevendaal", "Bennekom", "Renkum", "Ede", "Rhenen"];

async function askCity(
  conversation: BotConversation,
  ctx: BotContext
): Promise<string | null> {
  const kb = new InlineKeyboard();
  CITIES.forEach((city, i) => {
    kb.text(city, `city:${city}`);
    if (i % 2 === 1) kb.row();
  });
  if (CITIES.length % 2 !== 0) kb.row();

  await ctx.reply("🏙 City:", { reply_markup: kb });

  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") { await ctx.reply("❌ Cancelled."); return null; }
    if (upd.callbackQuery?.data?.startsWith("city:")) {
      await upd.answerCallbackQuery();
      return upd.callbackQuery.data.replace("city:", "");
    }
  }
}

// ── Map pin (optional) ──────────────────────────────────────────────────────────────

async function askMapLocation(
  conversation: BotConversation,
  ctx: BotContext
): Promise<{ lat: number; lon: number } | "__skip__" | null> {
  await ctx.reply(
    "\uD83D\uDCCD *Optional map pin*\n\n" +
    "Tap \uD83D\uDCCE \u2192 Location in Telegram, browse the map, drag the pin to the venue, and send it.\n" +
    "Tip: use the search bar in the location picker to navigate to the city first.\n\n" +
    "Type /skip to skip, or /cancel to abort.",
    { parse_mode: "Markdown" }
  );

  while (true) {
    const upd = await conversation.wait();
    const text = upd.message?.text?.trim();
    if (text === "/cancel") { await ctx.reply("\u274c Cancelled."); return null; }
    if (text === "/skip") return "__skip__";

    if (upd.message?.location) {
      const { latitude, longitude } = upd.message.location;
      const kb = new InlineKeyboard()
        .text("\u2705 Confirm", "loc:yes")
        .text("\uD83D\uDD04 Retry", "loc:retry");
      await ctx.reply(
        `\uD83D\uDCCD Pin placed at *${latitude.toFixed(6)}, ${longitude.toFixed(6)}*\n\nUse this location?`,
        { parse_mode: "Markdown", reply_markup: kb }
      );
      while (true) {
        const cbUpd = await conversation.wait();
        if (cbUpd.message?.text?.trim() === "/cancel") { await ctx.reply("\u274c Cancelled."); return null; }
        if (cbUpd.callbackQuery?.data === "loc:yes") {
          await cbUpd.answerCallbackQuery();
          return { lat: latitude, lon: longitude };
        }
        if (cbUpd.callbackQuery?.data === "loc:retry") {
          await cbUpd.answerCallbackQuery();
          await ctx.reply("OK, drop the pin again:");
          break;
        }
      }
    }
  }
}

// ── Plain text helper ─────────────────────────────────────────────────────────

async function askText(
  conversation: BotConversation,
  ctx: BotContext,
  prompt: string
): Promise<string | null> {
  await ctx.reply(prompt);
  const { message } = await conversation.waitFor("message:text");
  if (message.text.trim() === "/cancel") {
    await ctx.reply("❌ Cancelled. Use /new to start again.");
    return null;
  }
  return message.text.trim();
}

// ── Main conversation ─────────────────────────────────────────────────────────

export async function newEventConversation(
  conversation: BotConversation,
  ctx: BotContext
): Promise<void> {
  await ctx.reply(
    "📝 *New Event* — type /cancel at any time to abort.\n\nEvent name:",
    { parse_mode: "Markdown" }
  );

  // ── Name ──────────────────────────────────────────────────────────────────
  const { message: nameMsg } = await conversation.waitFor("message:text");
  if (nameMsg.text.trim() === "/cancel") { await ctx.reply("❌ Cancelled."); return; }
  const name = nameMsg.text.trim();
  if (!name) { await ctx.reply("⚠️ Name cannot be empty. Use /new to start again."); return; }

  // ── Start date / time ─────────────────────────────────────────────────────
  const startDateRaw = await askDate(conversation, ctx, "📅 Start date:");
  if (startDateRaw === null) return;

  const startTimeRaw = await askTime(conversation, ctx, "⏰ Start time:");
  if (startTimeRaw === null) return;

  const year = parseInt(startDateRaw.split("-")[0]);
  const id = toEventId(name, year);
  const startDate = `${startDateRaw}T${startTimeRaw}:00`;

  // ── End date / time ───────────────────────────────────────────────────────
  const endDateStr = await askEndDate(conversation, ctx, startDateRaw);
  if (endDateStr === null) return;

  const endTimeRaw = await askTime(conversation, ctx, "⏰ End time:");
  if (endTimeRaw === null) return;
  const endDate = `${endDateStr}T${endTimeRaw}:00`;

  // ── Venue / city ──────────────────────────────────────────────────────────
  const locationName = await askText(conversation, ctx, "📍 Venue name:");
  if (locationName === null) return;

  const locationCity = await askCity(conversation, ctx);
  if (locationCity === null) return;
  // ── Map pin (optional) ────────────────────────────────────────────────
  const mapLoc = await askMapLocation(conversation, ctx);
  if (mapLoc === null) return;
  const lat = mapLoc === "__skip__" ? null : mapLoc.lat;
  const lon = mapLoc === "__skip__" ? null : mapLoc.lon;
  // ── Categories (multi-select keyboard) ───────────────────────────────────
  const allCategories = await getCategories();
  const category = await askCategories(conversation, ctx, allCategories);
  if (category === null) return;

  // ── Price ─────────────────────────────────────────────────────────────────
  const priceKeyboard = new InlineKeyboard()
    .text("Free ✨", "price:free")
    .text("Paid 💰", "price:paid")
    .text("Donation 🙏", "price:donation");
  await ctx.reply("💰 Price:", { reply_markup: priceKeyboard });
  const priceCbCtx = await conversation.waitFor("callback_query:data");
  await priceCbCtx.answerCallbackQuery();
  const price = priceCbCtx.callbackQuery.data.replace("price:", "");

  // ── Description ───────────────────────────────────────────────────────────
  const description = await askText(conversation, ctx, "📋 Description:");
  if (description === null) return;

  // ── URL ───────────────────────────────────────────────────────────────────
  const urlRaw = await askText(conversation, ctx, "🔗 Event URL (or /skip):");
  if (urlRaw === null) return;
  const url = urlRaw === "/skip" ? "" : urlRaw;

  // ── Tags ──────────────────────────────────────────────────────────────────
  const tagsRaw = await askText(conversation, ctx, "🏷 Tags, comma-separated (or /skip):");
  if (tagsRaw === null) return;
  const tags =
    tagsRaw === "/skip"
      ? []
      : tagsRaw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);

  // ── Photo ─────────────────────────────────────────────────────────────────
  let photoBase64: string | undefined;
  await ctx.reply("🖼 Send a photo (or type /skip):");
  const photoCtx = await conversation.wait();

  if (photoCtx.message?.text?.trim() === "/cancel") {
    await ctx.reply("❌ Cancelled.");
    return;
  }
  if (photoCtx.message?.photo && photoCtx.message.photo.length > 0) {
    const largest = photoCtx.message.photo[photoCtx.message.photo.length - 1];
    const fileInfo = await photoCtx.api.getFile(largest.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileInfo.file_path}`;
    const res = await fetch(fileUrl);
    const buf = Buffer.from(await res.arrayBuffer());
    photoBase64 = buf.toString("base64");
  }

  // ── Summary + confirm ─────────────────────────────────────────────────────
  const summary = [
    `*📌 ${name}*`,
    `ID: \`${id}\``,
    `📅 ${startDateRaw} ${startTimeRaw} → ${endDateStr} ${endTimeRaw}`,
    `📍 ${locationName}, ${locationCity}` + (lat != null ? ` (📌 ${lat.toFixed(5)}, ${lon!.toFixed(5)})` : ""),
    `🏷 ${category.join(", ")}`,
    `💰 ${price}`,
    `📋 ${description.length > 100 ? description.slice(0, 100) + "…" : description}`,
    url ? `🔗 ${url}` : null,
    tags.length > 0 ? `# ${tags.join(", ")}` : null,
    photoBase64 ? "🖼 Photo: ✅" : "🖼 Photo: none",
  ]
    .filter(Boolean)
    .join("\n");

  const confirmKeyboard = new InlineKeyboard()
    .text("✅ Confirm & Save", "confirm:yes")
    .text("❌ Cancel", "confirm:no");

  await ctx.reply(`*Review your event:*\n\n${summary}`, {
    parse_mode: "Markdown",
    reply_markup: confirmKeyboard,
  });

  const confirmCtx = await conversation.waitFor("callback_query:data");
  await confirmCtx.answerCallbackQuery();

  if (confirmCtx.callbackQuery.data !== "confirm:yes") {
    await ctx.reply("❌ Cancelled.");
    return;
  }

  // ── Save to Supabase ──────────────────────────────────────────────────────
  await ctx.reply("⏳ Saving event…");

  const { error: dbError } = await getSupabase().from("events").insert({
    id,
    name,
    slug: id,
    description,
    start_date: startDate,
    end_date: endDate,
    location_name: locationName,
    location_city: locationCity,
    lat,
    lon,
    category,
    tags,
    url,
    price,
    status: "scheduled",
  });

  if (dbError) {
    await ctx.reply(`❌ Database error: ${dbError.message}`);
    return;
  }

  // ── Upload photo if provided ──────────────────────────────────────────────
  if (photoBase64) {
    try {
      await uploadImage(id, photoBase64);
    } catch (err) {
      await ctx.reply(
        `⚠️ Event saved, but image upload failed:\n${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  // ── Trigger rebuild ───────────────────────────────────────────────────────
  try {
    await triggerDeploy();
    await ctx.reply(
      `✅ *${name}* added! The website will update in ~2 minutes.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    await ctx.reply(
      `✅ Event saved! Deploy trigger failed:\n${err instanceof Error ? err.message : String(err)}\n\nTrigger manually from GitHub Actions.`
    );
  }
}

