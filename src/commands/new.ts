import { InlineKeyboard } from "grammy";
import type { Conversation, ConversationFlavor } from "@grammyjs/conversations";
import type { Context } from "grammy";
import { supabase } from "../lib/supabase.js";
import { uploadImage, triggerDeploy } from "../lib/github.js";
import { toEventId } from "../lib/slugify.js";

export type BotContext = Context & ConversationFlavor;
export type BotConversation = Conversation<BotContext>;

const VALID_CATEGORIES = [
  "music", "talks", "movies", "dance", "workshops", "nature",
  "yoga", "meditation", "sport", "politics", "art", "games",
  "markets", "food",
] as const;

/** Wait for a plain text message; return null if the user types /cancel. */
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

export async function newEventConversation(
  conversation: BotConversation,
  ctx: BotContext
): Promise<void> {
  await ctx.reply(
    "📝 *New Event* — type /cancel at any time to abort.\n\nEvent name:",
    { parse_mode: "Markdown" }
  );

  // ── Name ─────────────────────────────────────────────────────────────────
  const { message: nameMsg } = await conversation.waitFor("message:text");
  if (nameMsg.text.trim() === "/cancel") { await ctx.reply("❌ Cancelled."); return; }
  const name = nameMsg.text.trim();
  if (!name) { await ctx.reply("⚠️ Name cannot be empty. Use /new to start again."); return; }

  // ── Start date ────────────────────────────────────────────────────────────
  const startDateRaw = await askText(conversation, ctx, "📅 Start date (YYYY-MM-DD):");
  if (startDateRaw === null) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDateRaw)) {
    await ctx.reply("❌ Invalid format, expected YYYY-MM-DD. Use /new to start again.");
    return;
  }

  // ── Start time ────────────────────────────────────────────────────────────
  const startTimeRaw = await askText(conversation, ctx, "⏰ Start time (HH:MM):");
  if (startTimeRaw === null) return;
  if (!/^\d{2}:\d{2}$/.test(startTimeRaw)) {
    await ctx.reply("❌ Invalid format, expected HH:MM. Use /new to start again.");
    return;
  }

  const startDate = `${startDateRaw}T${startTimeRaw}:00`;
  const year = parseInt(startDateRaw.split("-")[0]);
  const id = toEventId(name, year);

  // ── End date ──────────────────────────────────────────────────────────────
  const endDateRaw = await askText(
    conversation,
    ctx,
    `📅 End date (YYYY-MM-DD) — or send the same date to use ${startDateRaw}:`
  );
  if (endDateRaw === null) return;
  const endDateStr = endDateRaw || startDateRaw;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDateStr)) {
    await ctx.reply("❌ Invalid format, expected YYYY-MM-DD. Use /new to start again.");
    return;
  }

  // ── End time ──────────────────────────────────────────────────────────────
  const endTimeRaw = await askText(conversation, ctx, "⏰ End time (HH:MM):");
  if (endTimeRaw === null) return;
  if (!/^\d{2}:\d{2}$/.test(endTimeRaw)) {
    await ctx.reply("❌ Invalid format, expected HH:MM. Use /new to start again.");
    return;
  }
  const endDate = `${endDateStr}T${endTimeRaw}:00`;

  // ── Venue name ────────────────────────────────────────────────────────────
  const locationName = await askText(conversation, ctx, "📍 Venue name:");
  if (locationName === null) return;

  // ── City ──────────────────────────────────────────────────────────────────
  const cityRaw = await askText(
    conversation,
    ctx,
    "🏙 City (type Wageningen or a different city):"
  );
  if (cityRaw === null) return;
  const locationCity = cityRaw || "Wageningen";

  // ── Categories ────────────────────────────────────────────────────────────
  const catRaw = await askText(
    conversation,
    ctx,
    `🏷 Categories, comma-separated:\n${VALID_CATEGORIES.join(", ")}`
  );
  if (catRaw === null) return;
  const category = catRaw
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter((c): c is (typeof VALID_CATEGORIES)[number] =>
      (VALID_CATEGORIES as readonly string[]).includes(c)
    );
  if (category.length === 0) {
    await ctx.reply("⚠️ No valid categories found. Use /new to start again.");
    return;
  }

  // ── Price (inline keyboard) ───────────────────────────────────────────────
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
  const tagsRaw = await askText(
    conversation,
    ctx,
    "🏷 Tags, comma-separated (or /skip):"
  );
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
  // If user sent /skip or any other message → no photo, continue

  // ── Summary + confirm ─────────────────────────────────────────────────────
  const summary = [
    `*📌 ${name}*`,
    `ID: \`${id}\``,
    `📅 ${startDateRaw} ${startTimeRaw} → ${endDateStr} ${endTimeRaw}`,
    `📍 ${locationName}, ${locationCity}`,
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

  const { error: dbError } = await supabase.from("events").insert({
    id,
    name,
    slug: id,
    description,
    start_date: startDate,
    end_date: endDate,
    location_name: locationName,
    location_city: locationCity,
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
