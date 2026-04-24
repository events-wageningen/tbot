import { InlineKeyboard } from "grammy";
import type { Conversation, ConversationFlavor } from "@grammyjs/conversations";
import type { Context } from "grammy";
import { getSupabase, getCategories, getLocations, type Category, type LocationPreset } from "../lib/supabase.js";
import { uploadImage, triggerDeploy } from "../lib/github.js";
import { toEventId } from "../lib/slugify.js";

export type BotContext = Context & ConversationFlavor;
export type BotConversation = Conversation<BotContext>;

// ── Delete helper (silently ignores errors, e.g. msg already deleted) ─────────
async function del(ctx: BotContext, chatId: number, msgId: number): Promise<void> {
  try { await ctx.api.deleteMessage(chatId, msgId); } catch { /* ignore */ }
}

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
  const chatId = ctx.chat!.id;
  const thisYear = new Date().getFullYear();

  const yearKb = new InlineKeyboard()
    .text(String(thisYear), `dp:y:${thisYear}`)
    .text(String(thisYear + 1), `dp:y:${thisYear + 1}`);
  const yearMsg = await ctx.reply(`📅 ${prompt} — pick a year:`, { reply_markup: yearKb });

  let year = 0;
  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") {
      await del(ctx, chatId, yearMsg.message_id);
      await ctx.reply("❌ Cancelled. Use /new to start again.");
      return null;
    }
    if (upd.callbackQuery?.data?.startsWith("dp:y:")) {
      await upd.answerCallbackQuery();
      year = parseInt(upd.callbackQuery.data.replace("dp:y:", ""));
      await del(ctx, chatId, yearMsg.message_id);
      break;
    }
  }

  const monthKb = new InlineKeyboard();
  MONTH_LABELS.forEach((label, i) => {
    monthKb.text(label, `dp:m:${i + 1}`);
    if (i % 4 === 3) monthKb.row();
  });
  const monthMsg = await ctx.reply(`📅 ${prompt} ${year} — pick a month:`, { reply_markup: monthKb });

  let month = 0;
  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") {
      await del(ctx, chatId, monthMsg.message_id);
      await ctx.reply("❌ Cancelled. Use /new to start again.");
      return null;
    }
    if (upd.callbackQuery?.data?.startsWith("dp:m:")) {
      await upd.answerCallbackQuery();
      month = parseInt(upd.callbackQuery.data.replace("dp:m:", ""));
      await del(ctx, chatId, monthMsg.message_id);
      break;
    }
  }

  const totalDays = daysInMonth(year, month);
  const dayKb = new InlineKeyboard();
  for (let d = 1; d <= totalDays; d++) {
    dayKb.text(String(d), `dp:d:${d}`);
    if (d % 7 === 0) dayKb.row();
  }
  const monthName = MONTH_LABELS[month - 1];
  const dayMsg = await ctx.reply(`📅 ${prompt} ${monthName} ${year} — pick a day:`, { reply_markup: dayKb });

  let day = 0;
  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") {
      await del(ctx, chatId, dayMsg.message_id);
      await ctx.reply("❌ Cancelled. Use /new to start again.");
      return null;
    }
    if (upd.callbackQuery?.data?.startsWith("dp:d:")) {
      await upd.answerCallbackQuery();
      day = parseInt(upd.callbackQuery.data.replace("dp:d:", ""));
      await del(ctx, chatId, dayMsg.message_id);
      break;
    }
  }

  return formatYMD(year, month, day);
}

/**
 * End-date picker: offers "Same as start date" or runs the full date picker.
 */
async function askEndDate(
  conversation: BotConversation,
  ctx: BotContext,
  startDateYMD: string
): Promise<string | null> {
  const chatId = ctx.chat!.id;
  const [y, m, d] = startDateYMD.split("-");
  const monthName = MONTH_LABELS[parseInt(m ?? "1") - 1] ?? "Jan";
  const display = `${parseInt(d ?? "1")} ${monthName} ${y ?? ""}`;

  const kb = new InlineKeyboard()
    .text(`📅 Same (${display})`, "dp:end:same")
    .text("📅 Other date", "dp:end:other");
  const msg = await ctx.reply("📅 End date:", { reply_markup: kb });

  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") {
      await del(ctx, chatId, msg.message_id);
      await ctx.reply("❌ Cancelled. Use /new to start again.");
      return null;
    }
    if (upd.callbackQuery?.data === "dp:end:same") {
      await upd.answerCallbackQuery();
      await del(ctx, chatId, msg.message_id);
      return startDateYMD;
    }
    if (upd.callbackQuery?.data === "dp:end:other") {
      await upd.answerCallbackQuery();
      await del(ctx, chatId, msg.message_id);
      return await askDate(conversation, ctx, "End date");
    }
  }
}

async function askTime(
  conversation: BotConversation,
  ctx: BotContext,
  prompt: string
): Promise<string | null> {
  const chatId = ctx.chat!.id;
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

  const timeMsg = await ctx.reply(prompt, { reply_markup: kb });

  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") {
      await del(ctx, chatId, timeMsg.message_id);
      await ctx.reply("❌ Cancelled. Use /new to start again.");
      return null;
    }
    if (upd.callbackQuery?.data?.startsWith("time:")) {
      await upd.answerCallbackQuery();
      const val = upd.callbackQuery.data.replace("time:", "");
      if (val !== "other") {
        await del(ctx, chatId, timeMsg.message_id);
        return val;
      }
      await del(ctx, chatId, timeMsg.message_id);
      const otherMsg = await ctx.reply("⏰ Enter time (HH:MM):");
      while (true) {
        const { message: m } = await conversation.waitFor("message:text");
        if (m.text.trim() === "/cancel") {
          await del(ctx, chatId, otherMsg.message_id);
          await del(ctx, chatId, m.message_id);
          await ctx.reply("❌ Cancelled. Use /new to start again.");
          return null;
        }
        const t = m.text.trim();
        if (/^\d{1,2}:\d{2}$/.test(t)) {
          await del(ctx, chatId, otherMsg.message_id);
          await del(ctx, chatId, m.message_id);
          return t.padStart(5, "0");
        }
        await ctx.reply("⚠️ Invalid format, expected HH:MM. Try again:");
      }
    }
    if (upd.message?.text) {
      const t = upd.message.text.trim();
      if (/^\d{1,2}:\d{2}$/.test(t)) {
        await del(ctx, chatId, timeMsg.message_id);
        await del(ctx, chatId, upd.message.message_id);
        return t.padStart(5, "0");
      }
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
  const chatId = ctx.chat!.id;
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
  const msgId = catMsg.message_id;

  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") {
      await del(ctx, chatId, msgId);
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
      await del(ctx, chatId, msgId);
      return [...selected];
    }
    const catId = data.replace("cat:", "");
    if (selected.has(catId)) selected.delete(catId);
    else selected.add(catId);
    await ctx.api.editMessageReplyMarkup(chatId, msgId, { reply_markup: buildKeyboard() });
  }
}

// ── City picker ──────────────────────────────────────────────────────────────

const CITIES = ["Wageningen", "Droevendaal", "Bennekom", "Renkum", "Ede", "Rhenen"];

async function askCity(
  conversation: BotConversation,
  ctx: BotContext
): Promise<string | null> {
  const chatId = ctx.chat!.id;
  const kb = new InlineKeyboard();
  CITIES.forEach((city, i) => {
    kb.text(city, `city:${city}`);
    if (i % 2 === 1) kb.row();
  });
  if (CITIES.length % 2 !== 0) kb.row();

  const msg = await ctx.reply("🏙 City:", { reply_markup: kb });
  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") {
      await del(ctx, chatId, msg.message_id);
      await ctx.reply("❌ Cancelled.");
      return null;
    }
    if (upd.callbackQuery?.data?.startsWith("city:")) {
      await upd.answerCallbackQuery();
      await del(ctx, chatId, msg.message_id);
      return upd.callbackQuery.data.replace("city:", "");
    }
  }
}

// ── Map pin (optional) ──────────────────────────────────────────────────────────────

async function askMapLocation(
  conversation: BotConversation,
  ctx: BotContext
): Promise<{ lat: number; lon: number } | "__skip__" | null> {
  const chatId = ctx.chat!.id;

  while (true) {
    const instrMsg = await ctx.reply(
      "\uD83D\uDCCD *Optional map pin*\n\n" +
      "Tap \uD83D\uDCCE \u2192 Location in Telegram, browse the map, drag the pin to the venue, and send it.\n" +
      "Tip: use the search bar in the location picker to navigate to the city first.\n\n" +
      "Type /skip to skip, or /cancel to abort.",
      { parse_mode: "Markdown" }
    );

    let locReceived: { latitude: number; longitude: number } | null = null;
    outerLoop: while (true) {
      const upd = await conversation.wait();
      const text = upd.message?.text?.trim();
      if (text === "/cancel") {
        await del(ctx, chatId, instrMsg.message_id);
        await ctx.reply("\u274c Cancelled.");
        return null;
      }
      if (text === "/skip") {
        await del(ctx, chatId, instrMsg.message_id);
        if (upd.message) await del(ctx, chatId, upd.message.message_id);
        return "__skip__";
      }
      if (upd.message?.location) {
        await del(ctx, chatId, instrMsg.message_id);
        await del(ctx, chatId, upd.message.message_id);
        locReceived = { latitude: upd.message.location.latitude, longitude: upd.message.location.longitude };
        break outerLoop;
      }
    }

    if (!locReceived) continue;
    const { latitude, longitude } = locReceived;
    const kb = new InlineKeyboard()
      .text("\u2705 Confirm", "loc:yes")
      .text("\uD83D\uDD04 Retry", "loc:retry");
    const confirmMsg = await ctx.reply(
      `\uD83D\uDCCD Pin placed at *${latitude.toFixed(6)}, ${longitude.toFixed(6)}*\n\nUse this location?`,
      { parse_mode: "Markdown", reply_markup: kb }
    );
    while (true) {
      const cbUpd = await conversation.wait();
      if (cbUpd.message?.text?.trim() === "/cancel") {
        await del(ctx, chatId, confirmMsg.message_id);
        await ctx.reply("\u274c Cancelled.");
        return null;
      }
      if (cbUpd.callbackQuery?.data === "loc:yes") {
        await cbUpd.answerCallbackQuery();
        await del(ctx, chatId, confirmMsg.message_id);
        return { lat: latitude, lon: longitude };
      }
      if (cbUpd.callbackQuery?.data === "loc:retry") {
        await cbUpd.answerCallbackQuery();
        await del(ctx, chatId, confirmMsg.message_id);
        break; // retry outer loop
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
  const chatId = ctx.chat!.id;
  const qMsg = await ctx.reply(prompt);
  const { message } = await conversation.waitFor("message:text");
  await del(ctx, chatId, qMsg.message_id);
  await del(ctx, chatId, message.message_id);
  if (message.text.trim() === "/cancel") {
    await ctx.reply("❌ Cancelled. Use /new to start again.");
    return null;
  }
  return message.text.trim();
}

// ── Venue picker with presets ────────────────────────────────────────────────

async function askVenue(
  conversation: BotConversation,
  ctx: BotContext,
  presets: LocationPreset[]
): Promise<{ name: string; city?: string; lat: number | null; lon: number | null } | null> {
  const chatId = ctx.chat!.id;
  const kb = new InlineKeyboard();
  presets.forEach((p) => kb.text(`📍 ${p.name}`, `venue:${p.id}`).row());
  kb.text("✍️ Type venue name", "venue:__custom__");

  const msg = await ctx.reply("📍 Venue — pick a preset or type/tap to enter:", { reply_markup: kb });

  while (true) {
    const upd = await conversation.wait();
    // User typed directly
    if (upd.message?.text) {
      const text = upd.message.text.trim();
      if (text === "/cancel") {
        await del(ctx, chatId, msg.message_id);
        await del(ctx, chatId, upd.message.message_id);
        await ctx.reply("❌ Cancelled.");
        return null;
      }
      await del(ctx, chatId, msg.message_id);
      await del(ctx, chatId, upd.message.message_id);
      return { name: text, lat: null, lon: null };
    }
    if (upd.callbackQuery?.data?.startsWith("venue:")) {
      await upd.answerCallbackQuery();
      const key = upd.callbackQuery.data.replace("venue:", "");
      await del(ctx, chatId, msg.message_id);
      if (key === "__custom__") {
        const qMsg = await ctx.reply("📍 Type the venue name:");
        const { message } = await conversation.waitFor("message:text");
        await del(ctx, chatId, qMsg.message_id);
        await del(ctx, chatId, message.message_id);
        if (message.text.trim() === "/cancel") { await ctx.reply("❌ Cancelled."); return null; }
        return { name: message.text.trim(), lat: null, lon: null };
      }
      const preset = presets.find((p) => p.id === key);
      if (preset) return { name: preset.name, city: preset.city, lat: preset.lat, lon: preset.lon };
    }
  }
}

// ── HTML escape helper (for recap) ───────────────────────────────────────────
function escHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Main conversation ─────────────────────────────────────────────────────────

export async function newEventConversation(
  conversation: BotConversation,
  ctx: BotContext
): Promise<void> {
  const chatId = ctx.chat!.id;

  // ── Recap message ─────────────────────────────────────────────────────────
  type RecapEntry = { key: string; label: string; value: string };
  const recap: RecapEntry[] = [];
  let recapMsgId = 0;
  function setRecap(key: string, label: string, value: string): void {
    const existing = recap.find(r => r.key === key);
    if (existing) existing.value = value;
    else recap.push({ key, label, value });
  }
  async function updateRecap(): Promise<void> {
    const body = recap.length > 0
      ? recap.map(r => `${escHtml(r.label)}: ${escHtml(r.value)}`).join("\n")
      : "(filling in...)";
    const text = `<b>📝 You are performing a new event operation</b>\n<b>Current summary:</b>\n──────────────────\n${body}`;
    if (recapMsgId === 0) {
      const m = await ctx.reply(text, { parse_mode: "HTML" });
      recapMsgId = m.message_id;
    } else {
      try {
        await ctx.api.editMessageText(chatId, recapMsgId, text, { parse_mode: "HTML" });
      } catch { /* not modified */ }
    }
  }
  await updateRecap();

  const introMsg = await ctx.reply("✏️ Event name: (type /cancel at any time to abort)");

  // ── Name ──────────────────────────────────────────────────────────────────
  const { message: nameMsg } = await conversation.waitFor("message:text");
  await del(ctx, chatId, introMsg.message_id);
  await del(ctx, chatId, nameMsg.message_id);
  if (nameMsg.text.trim() === "/cancel") { await ctx.reply("❌ Cancelled."); return; }
  const name = nameMsg.text.trim();
  if (!name) { await ctx.reply("⚠️ Name cannot be empty. Use /new to start again."); return; }
  setRecap("name", "✏️ Name", name);
  await updateRecap();

  // ── Start date / time ─────────────────────────────────────────────────────
  let startDateRaw = await askDate(conversation, ctx, "📅 Start date:");
  if (startDateRaw === null) return;

  let startTimeRaw = await askTime(conversation, ctx, "⏰ Start time:");
  if (startTimeRaw === null) return;

  let startDate = `${startDateRaw}T${startTimeRaw}:00`;
  setRecap("start", "📅 Start", `${startDateRaw} · ${startTimeRaw}`);
  await updateRecap();

  // ── End date / time (with validation loop) ────────────────────────────────
  let endDateStr!: string;
  let endTimeRaw!: string;
  let endDate!: string;

  while (true) {
    endDateStr = await askEndDate(conversation, ctx, startDateRaw) as string;
    if (endDateStr === null) return;

    endTimeRaw = await askTime(conversation, ctx, "⏰ End time:") as string;
    if (endTimeRaw === null) return;

    endDate = `${endDateStr}T${endTimeRaw}:00`;

    if (new Date(endDate) > new Date(startDate)) break;

    const fixKb = new InlineKeyboard()
      .text("🔄 Change end date/time", "endfix:retry")
      .row()
      .text("✏️ Edit start date/time", "endfix:start");
    const warnMsg = await ctx.reply(
      "⚠️ End date and time cannot be before or the same as start date and time.\nWhat would you like to do?",
      { reply_markup: fixKb }
    );
    const fixUpd = await conversation.wait();
    await del(ctx, chatId, warnMsg.message_id);
    if (fixUpd.callbackQuery) await fixUpd.answerCallbackQuery();

    if (fixUpd.callbackQuery?.data === "endfix:start") {
      startDateRaw = await askDate(conversation, ctx, "📅 New start date:") as string;
      if (startDateRaw === null) return;
      startTimeRaw = await askTime(conversation, ctx, "⏰ New start time:") as string;
      if (startTimeRaw === null) return;
      startDate = `${startDateRaw}T${startTimeRaw}:00`;
      setRecap("start", "📅 Start", `${startDateRaw} · ${startTimeRaw}`);
    }
    // both branches loop back to re-ask end date/time
  }
  setRecap("end", "📅 End", `${endDateStr} · ${endTimeRaw}`);
  await updateRecap();

  const year = parseInt(startDateRaw.split("-")[0] ?? "2025");
  const id = toEventId(name, year);

  // ── Venue / city ──────────────────────────────────────────────────────────
  const locationPresets = await getLocations();
  const venueResult = await askVenue(conversation, ctx, locationPresets);
  if (venueResult === null) return;
  const locationName = venueResult.name;

  // Skip city prompt if the preset already provides a city
  const locationCity = venueResult.city ?? await askCity(conversation, ctx);
  if (locationCity === null) return;
  setRecap("venue", "📍 Venue", `${locationName}, ${locationCity}`);
  await updateRecap();

  // ── Map pin (skip if preset auto-filled lat/lon) ──────────────────────────
  let lat: number | null;
  let lon: number | null;
  if (venueResult.lat !== null) {
    lat = venueResult.lat;
    lon = venueResult.lon;
  } else {
    const mapLoc = await askMapLocation(conversation, ctx);
    if (mapLoc === null) return;
    lat = mapLoc === "__skip__" ? null : mapLoc.lat;
    lon = mapLoc === "__skip__" ? null : mapLoc.lon;
  }
  // ── Categories (multi-select keyboard) ───────────────────────────────────
  const allCategories = await getCategories();
  const category = await askCategories(conversation, ctx, allCategories);
  if (category === null) return;
  setRecap("cats", "🏷 Categories", category.join(", "));
  await updateRecap();

  // ── Price ─────────────────────────────────────────────────────────────────
  const priceKeyboard = new InlineKeyboard()
    .text("Free ✨", "price:free")
    .text("Paid 💰", "price:paid")
    .text("Donation 🙏", "price:donation");
  const priceMsg = await ctx.reply("💰 Price:", { reply_markup: priceKeyboard });
  const priceCbCtx = await conversation.waitFor("callback_query:data");
  await priceCbCtx.answerCallbackQuery();
  await del(ctx, chatId, priceMsg.message_id);
  const price = priceCbCtx.callbackQuery.data.replace("price:", "");
  setRecap("price", "💰 Price", price);
  await updateRecap();

  // ── Description ───────────────────────────────────────────────────────────
  const description = await askText(conversation, ctx, "📋 Description:");
  if (description === null) return;
  setRecap("desc", "📋 Description", description.length > 80 ? description.slice(0, 80) + "…" : description);
  await updateRecap();

  // ── URL ───────────────────────────────────────────────────────────────────
  const urlRaw = await askText(conversation, ctx, "🔗 Event URL (or /skip):");
  if (urlRaw === null) return;
  const url = urlRaw === "/skip" ? "" : urlRaw;
  setRecap("url", "🔗 URL", url || "—");
  await updateRecap();

  // ── Tags ──────────────────────────────────────────────────────────────────
  const tagsRaw = await askText(conversation, ctx, "🏷 Tags — comma or space separated, # optional (or /skip):");
  if (tagsRaw === null) return;
  const tags =
    tagsRaw === "/skip"
      ? []
      : tagsRaw
          .split(/[\s,]+/)
          .map((t) => t.replace(/^#+/, "").trim().toLowerCase())
          .filter(Boolean);
  setRecap("tags", "# Tags", tags.length > 0 ? tags.join(", ") : "—");
  await updateRecap();

  // ── Photo ─────────────────────────────────────────────────────────────────
  let photoBase64: string | undefined;
  const photoPromptMsg = await ctx.reply("🖼 Send a photo (or type /skip):");
  const photoCtx = await conversation.wait();
  await del(ctx, chatId, photoPromptMsg.message_id);
  if (photoCtx.message) await del(ctx, chatId, photoCtx.message.message_id);

  if (photoCtx.message?.text?.trim() === "/cancel") {
    await ctx.reply("❌ Cancelled.");
    return;
  }
  if (photoCtx.message?.photo && photoCtx.message.photo.length > 0) {
    const largest = photoCtx.message.photo[photoCtx.message.photo.length - 1]!;
    const fileInfo = await photoCtx.api.getFile(largest.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileInfo.file_path}`;
    const res = await fetch(fileUrl);
    const buf = Buffer.from(await res.arrayBuffer());
    photoBase64 = buf.toString("base64");
  }
  setRecap("photo", "🖼️ Photo", photoBase64 ? "✅" : "—");
  await updateRecap();

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
    creator_telegram_id: ctx.from?.id ?? null,
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

