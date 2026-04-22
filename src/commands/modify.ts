import { InlineKeyboard } from "grammy";
import type { Conversation, ConversationFlavor } from "@grammyjs/conversations";
import type { Context } from "grammy";
import { getSupabase, getCategories, type Category } from "../lib/supabase.js";
import { triggerDeploy } from "../lib/github.js";
import { uploadImage } from "../lib/github.js";

export type BotContext = Context & ConversationFlavor;
export type BotConversation = Conversation<BotContext>;

// ── Re-used helpers (duplicated from new.ts to keep files independent) ────────

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function formatYMD(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

const MONTH_LABELS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

async function askDate(
  conversation: BotConversation,
  ctx: BotContext,
  prompt: string
): Promise<string | null> {
  const thisYear = new Date().getFullYear();

  const yearKb = new InlineKeyboard()
    .text(String(thisYear), `dp:y:${thisYear}`)
    .text(String(thisYear + 1), `dp:y:${thisYear + 1}`);

  await ctx.reply(`📅 ${prompt} — pick a year:`, { reply_markup: yearKb });
  let year = 0;
  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") { await ctx.reply("❌ Cancelled."); return null; }
    if (upd.callbackQuery?.data?.startsWith("dp:y:")) {
      await upd.answerCallbackQuery();
      year = parseInt(upd.callbackQuery.data.replace("dp:y:", ""));
      break;
    }
  }

  const monthKb = new InlineKeyboard();
  MONTH_LABELS.forEach((label, i) => {
    monthKb.text(label, `dp:m:${i + 1}`);
    if (i % 4 === 3) monthKb.row();
  });
  await ctx.reply(`📅 ${prompt} ${year} — pick a month:`, { reply_markup: monthKb });
  let month = 0;
  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") { await ctx.reply("❌ Cancelled."); return null; }
    if (upd.callbackQuery?.data?.startsWith("dp:m:")) {
      await upd.answerCallbackQuery();
      month = parseInt(upd.callbackQuery.data.replace("dp:m:", ""));
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
  await ctx.reply(`📅 ${prompt} ${monthName} ${year} — pick a day:`, { reply_markup: dayKb });
  let day = 0;
  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") { await ctx.reply("❌ Cancelled."); return null; }
    if (upd.callbackQuery?.data?.startsWith("dp:d:")) {
      await upd.answerCallbackQuery();
      day = parseInt(upd.callbackQuery.data.replace("dp:d:", ""));
      break;
    }
  }

  await ctx.reply(`📅 Selected: ${day} ${monthName} ${year}`);
  return formatYMD(year, month, day);
}

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
    if (upd.message?.text?.trim() === "/cancel") { await ctx.reply("❌ Cancelled."); return null; }
    if (upd.callbackQuery?.data?.startsWith("time:")) {
      await upd.answerCallbackQuery();
      const val = upd.callbackQuery.data.replace("time:", "");
      if (val !== "other") return val;
      await ctx.reply("⏰ Enter time (HH:MM):");
      while (true) {
        const { message: m } = await conversation.waitFor("message:text");
        if (m.text.trim() === "/cancel") { await ctx.reply("❌ Cancelled."); return null; }
        const t = m.text.trim();
        if (/^\d{1,2}:\d{2}$/.test(t)) return t.padStart(5, "0");
        await ctx.reply("⚠️ Invalid format. Try again:");
      }
    }
  }
}

async function askCategories(
  conversation: BotConversation,
  ctx: BotContext,
  categories: Category[],
  initial: string[] = []
): Promise<string[] | null> {
  const selected = new Set<string>(initial);

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
    if (upd.message?.text?.trim() === "/cancel") { await ctx.reply("❌ Cancelled."); return null; }
    if (!upd.callbackQuery?.data?.startsWith("cat:")) continue;
    await upd.answerCallbackQuery();
    const data = upd.callbackQuery.data;
    if (data === "cat:done") {
      if (selected.size === 0) { await upd.answerCallbackQuery("⚠️ Select at least one"); continue; }
      await ctx.api.editMessageReplyMarkup(chatId, msgId);
      await ctx.reply(`🏷 Selected: ${[...selected].join(", ")}`);
      return [...selected];
    }
    const catId = data.replace("cat:", "");
    if (selected.has(catId)) selected.delete(catId); else selected.add(catId);
    await ctx.api.editMessageReplyMarkup(chatId, msgId, { reply_markup: buildKeyboard() });
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

async function askText(
  conversation: BotConversation,
  ctx: BotContext,
  prompt: string,
  allowSkip = false
): Promise<string | null> {
  await ctx.reply(prompt + (allowSkip ? " (or /skip)" : ""));
  const { message } = await conversation.waitFor("message:text");
  if (message.text.trim() === "/cancel") { await ctx.reply("❌ Cancelled."); return null; }
  if (allowSkip && message.text.trim() === "/skip") return "__skip__";
  return message.text.trim();
}

// ── Editable fields ───────────────────────────────────────────────────────────

const FIELDS: { id: string; label: string }[] = [
  { id: "name",          label: "✏️ Name" },
  { id: "start_date",    label: "📅 Start date" },
  { id: "start_time",    label: "⏰ Start time" },
  { id: "end_date",      label: "📅 End date" },
  { id: "end_time",      label: "⏰ End time" },
  { id: "location_name", label: "📍 Venue" },
  { id: "location_city", label: "🏙 City" },
  { id: "category",      label: "🏷 Categories" },
  { id: "price",         label: "💰 Price" },
  { id: "description",   label: "📋 Description" },
  { id: "url",           label: "🔗 URL" },
  { id: "tags",          label: "# Tags" },
  { id: "photo",         label: "🖼 Photo" },
];

// ── Main conversation ─────────────────────────────────────────────────────────

export async function modifyEventConversation(
  conversation: BotConversation,
  ctx: BotContext
): Promise<void> {
  // ── Fetch all events ──────────────────────────────────────────────────────
  const { data: events, error } = await getSupabase()
    .from("events")
    .select("id, name, start_date, end_date, location_name, location_city, category, price, description, url, tags")
    .order("start_date", { ascending: true });

  if (error) { await ctx.reply(`❌ Database error: ${error.message}`); return; }
  if (!events || events.length === 0) { await ctx.reply("No events found."); return; }

  // ── Event picker ──────────────────────────────────────────────────────────
  const listKb = new InlineKeyboard();
  events.forEach((e) => {
    const date = new Date(e.start_date as string);
    const label = `${e.name} (${date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })})`;
    listKb.text(label, `mod:ev:${e.id}`).row();
  });
  listKb.text("❌ Cancel", "mod:ev:cancel");

  await ctx.reply("✏️ *Modify event* — select an event:", {
    parse_mode: "Markdown",
    reply_markup: listKb,
  });

  let eventId = "";
  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") { await ctx.reply("❌ Cancelled."); return; }
    if (!upd.callbackQuery?.data?.startsWith("mod:ev:")) continue;
    await upd.answerCallbackQuery();
    const val = upd.callbackQuery.data.replace("mod:ev:", "");
    if (val === "cancel") { await ctx.reply("❌ Cancelled."); return; }
    eventId = val;
    break;
  }

  const event = events.find((e) => e.id === eventId)!;

  // ── Field picker (multi-select) ───────────────────────────────────────────
  const selectedFields = new Set<string>();

  const buildFieldKb = () => {
    const kb = new InlineKeyboard();
    FIELDS.forEach((f, i) => {
      const on = selectedFields.has(f.id);
      kb.text(on ? `✅ ${f.label}` : f.label, `mod:f:${f.id}`);
      if (i % 2 === 1) kb.row();
    });
    if (FIELDS.length % 2 !== 0) kb.row();
    kb.text("✅ Done", "mod:f:done");
    return kb;
  };

  const fieldMsg = await ctx.reply(
    `✏️ *${event.name}*\n\nWhich fields do you want to modify?`,
    { parse_mode: "Markdown", reply_markup: buildFieldKb() }
  );
  const chatId = ctx.chat!.id;
  const fieldMsgId = fieldMsg.message_id;

  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") { await ctx.reply("❌ Cancelled."); return; }
    if (!upd.callbackQuery?.data?.startsWith("mod:f:")) continue;
    await upd.answerCallbackQuery();
    const val = upd.callbackQuery.data.replace("mod:f:", "");
    if (val === "done") {
      if (selectedFields.size === 0) { await upd.answerCallbackQuery("⚠️ Select at least one field"); continue; }
      await ctx.api.editMessageReplyMarkup(chatId, fieldMsgId);
      break;
    }
    if (selectedFields.has(val)) selectedFields.delete(val); else selectedFields.add(val);
    await ctx.api.editMessageReplyMarkup(chatId, fieldMsgId, { reply_markup: buildFieldKb() });
  }

  // ── Collect new values for selected fields ────────────────────────────────
  const updates: Record<string, unknown> = {};
  let newPhotoBase64: string | undefined;

  // Parse existing dates/times from stored ISO timestamps
  const existingStartISO = event.start_date as string;
  const existingEndISO = event.end_date as string;
  let startDateYMD = existingStartISO.slice(0, 10);
  let startTimeHM  = existingStartISO.slice(11, 16);
  let endDateYMD   = existingEndISO.slice(0, 10);
  let endTimeHM    = existingEndISO.slice(11, 16);

  for (const fieldId of FIELDS.map((f) => f.id).filter((id) => selectedFields.has(id))) {
    switch (fieldId) {
      case "name": {
        const v = await askText(conversation, ctx, "✏️ New name:");
        if (v === null) return;
        updates.name = v;
        break;
      }
      case "start_date": {
        const v = await askDate(conversation, ctx, "📅 New start date");
        if (v === null) return;
        startDateYMD = v;
        break;
      }
      case "start_time": {
        const v = await askTime(conversation, ctx, "⏰ New start time:");
        if (v === null) return;
        startTimeHM = v;
        break;
      }
      case "end_date": {
        const v = await askDate(conversation, ctx, "📅 New end date");
        if (v === null) return;
        endDateYMD = v;
        break;
      }
      case "end_time": {
        const v = await askTime(conversation, ctx, "⏰ New end time:");
        if (v === null) return;
        endTimeHM = v;
        break;
      }
      case "location_name": {
        const v = await askText(conversation, ctx, "📍 New venue name:");
        if (v === null) return;
        updates.location_name = v;
        break;
      }
      case "location_city": {
        const v = await askCity(conversation, ctx);
        if (v === null) return;
        updates.location_city = v;
        break;
      }
      case "category": {
        const allCategories = await getCategories();
        const current = (event.category as string[]) ?? [];
        const v = await askCategories(conversation, ctx, allCategories, current);
        if (v === null) return;
        updates.category = v;
        break;
      }
      case "price": {
        const priceKb = new InlineKeyboard()
          .text("Free ✨", "price:free")
          .text("Paid 💰", "price:paid")
          .text("Donation 🙏", "price:donation");
        await ctx.reply("💰 New price:", { reply_markup: priceKb });
        const cbCtx = await conversation.waitFor("callback_query:data");
        await cbCtx.answerCallbackQuery();
        updates.price = cbCtx.callbackQuery.data.replace("price:", "");
        break;
      }
      case "description": {
        const v = await askText(conversation, ctx, "📋 New description:");
        if (v === null) return;
        updates.description = v;
        break;
      }
      case "url": {
        const v = await askText(conversation, ctx, "🔗 New URL", true);
        if (v === null) return;
        updates.url = v === "__skip__" ? "" : v;
        break;
      }
      case "tags": {
        const v = await askText(conversation, ctx, "# New tags, comma-separated", true);
        if (v === null) return;
        updates.tags = v === "__skip__" ? [] : v.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
        break;
      }
      case "photo": {
        await ctx.reply("🖼 Send the new photo (or /skip):");
        const photoUpd = await conversation.wait();
        if (photoUpd.message?.text?.trim() === "/cancel") { await ctx.reply("❌ Cancelled."); return; }
        if (photoUpd.message?.photo && photoUpd.message.photo.length > 0) {
          const largest = photoUpd.message.photo[photoUpd.message.photo.length - 1];
          const fileInfo = await photoUpd.api.getFile(largest.file_id);
          const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${fileInfo.file_path}`;
          const res = await fetch(fileUrl);
          newPhotoBase64 = Buffer.from(await res.arrayBuffer()).toString("base64");
        }
        break;
      }
    }
  }

  // Rebuild date/time fields if any date or time was changed
  if (selectedFields.has("start_date") || selectedFields.has("start_time")) {
    updates.start_date = `${startDateYMD}T${startTimeHM}:00`;
  }
  if (selectedFields.has("end_date") || selectedFields.has("end_time")) {
    updates.end_date = `${endDateYMD}T${endTimeHM}:00`;
  }

  // ── Save to Supabase ──────────────────────────────────────────────────────
  if (Object.keys(updates).length > 0) {
    const { error: updErr } = await getSupabase()
      .from("events")
      .update(updates)
      .eq("id", eventId);

    if (updErr) { await ctx.reply(`❌ Update failed: ${updErr.message}`); return; }
  }

  // ── Upload new photo if provided ──────────────────────────────────────────
  if (newPhotoBase64) {
    try {
      await uploadImage(eventId, newPhotoBase64);
    } catch (err) {
      await ctx.reply(`⚠️ DB updated, but image upload failed:\n${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Trigger rebuild ───────────────────────────────────────────────────────
  try {
    await triggerDeploy();
    await ctx.reply(
      `✅ *${event.name}* updated! The website will update in ~2 minutes.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    await ctx.reply(
      `✅ Event updated! Deploy trigger failed:\n${err instanceof Error ? err.message : String(err)}`
    );
  }
}
