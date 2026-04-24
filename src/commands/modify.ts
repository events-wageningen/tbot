import { InlineKeyboard } from "grammy";
import type { Conversation, ConversationFlavor } from "@grammyjs/conversations";
import type { Context } from "grammy";
import { getSupabase, getCategories, getLocations, type Category, type LocationPreset } from "../lib/supabase.js";
import { triggerDeploy } from "../lib/github.js";
import { uploadImage } from "../lib/github.js";

export type BotContext = Context & ConversationFlavor;
export type BotConversation = Conversation<BotContext>;

// ── Delete helper ─────────────────────────────────────────────────────────
async function del(ctx: BotContext, chatId: number, msgId: number): Promise<void> {
  try { await ctx.api.deleteMessage(chatId, msgId); } catch { /* ignore */ }
}

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
  const chatId = ctx.chat!.id;
  const thisYear = new Date().getFullYear();
  const yearKb = new InlineKeyboard()
    .text(String(thisYear), `dp:y:${thisYear}`)
    .text(String(thisYear + 1), `dp:y:${thisYear + 1}`);
  const yearMsg = await ctx.reply(`📅 ${prompt} — pick a year:`, { reply_markup: yearKb });
  let year = 0;
  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") { await del(ctx, chatId, yearMsg.message_id); await ctx.reply("❌ Cancelled."); return null; }
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
    if (upd.message?.text?.trim() === "/cancel") { await del(ctx, chatId, monthMsg.message_id); await ctx.reply("❌ Cancelled."); return null; }
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
    if (upd.message?.text?.trim() === "/cancel") { await del(ctx, chatId, dayMsg.message_id); await ctx.reply("❌ Cancelled."); return null; }
    if (upd.callbackQuery?.data?.startsWith("dp:d:")) {
      await upd.answerCallbackQuery();
      day = parseInt(upd.callbackQuery.data.replace("dp:d:", ""));
      await del(ctx, chatId, dayMsg.message_id);
      break;
    }
  }
  return formatYMD(year, month, day);
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
    if (upd.message?.text?.trim() === "/cancel") { await del(ctx, chatId, timeMsg.message_id); await ctx.reply("❌ Cancelled."); return null; }
    if (upd.callbackQuery?.data?.startsWith("time:")) {
      await upd.answerCallbackQuery();
      const val = upd.callbackQuery.data.replace("time:", "");
      if (val !== "other") { await del(ctx, chatId, timeMsg.message_id); return val; }
      await del(ctx, chatId, timeMsg.message_id);
      const otherMsg = await ctx.reply("⏰ Enter time (HH:MM):");
      while (true) {
        const { message: m } = await conversation.waitFor("message:text");
        if (m.text.trim() === "/cancel") { await del(ctx, chatId, otherMsg.message_id); await del(ctx, chatId, m.message_id); await ctx.reply("❌ Cancelled."); return null; }
        const t = m.text.trim();
        if (/^\d{1,2}:\d{2}$/.test(t)) { await del(ctx, chatId, otherMsg.message_id); await del(ctx, chatId, m.message_id); return t.padStart(5, "0"); }
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
  const chatId = ctx.chat!.id;
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
  const catMsg = await ctx.reply("🏷 Select categories (tap to toggle, then Done):", { reply_markup: buildKeyboard() });
  const msgId = catMsg.message_id;
  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") { await del(ctx, chatId, msgId); await ctx.reply("❌ Cancelled."); return null; }
    if (!upd.callbackQuery?.data?.startsWith("cat:")) continue;
    await upd.answerCallbackQuery();
    const data = upd.callbackQuery.data;
    if (data === "cat:done") {
      if (selected.size === 0) { await upd.answerCallbackQuery("⚠️ Select at least one"); continue; }
      await del(ctx, chatId, msgId);
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
    if (upd.message?.text?.trim() === "/cancel") { await del(ctx, chatId, msg.message_id); await ctx.reply("❌ Cancelled."); return null; }
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
      "\uD83D\uDCCD *Optional map pin*\n\nTap \uD83D\uDCCE \u2192 Location, drag the pin, and send it.\nType /skip to skip.",
      { parse_mode: "Markdown" }
    );
    let locReceived: { latitude: number; longitude: number } | null = null;
    outerLoop: while (true) {
      const upd = await conversation.wait();
      const text = upd.message?.text?.trim();
      if (text === "/cancel") { await del(ctx, chatId, instrMsg.message_id); await ctx.reply("\u274c Cancelled."); return null; }
      if (text === "/skip") { await del(ctx, chatId, instrMsg.message_id); if (upd.message) await del(ctx, chatId, upd.message.message_id); return "__skip__"; }
      if (upd.message?.location) {
        await del(ctx, chatId, instrMsg.message_id);
        await del(ctx, chatId, upd.message.message_id);
        locReceived = { latitude: upd.message.location.latitude, longitude: upd.message.location.longitude };
        break outerLoop;
      }
    }
    if (!locReceived) continue;
    const { latitude, longitude } = locReceived;
    const kb = new InlineKeyboard().text("\u2705 Confirm", "loc:yes").text("\uD83D\uDD04 Retry", "loc:retry");
    const confirmMsg = await ctx.reply(
      `\uD83D\uDCCD Pin at *${latitude.toFixed(6)}, ${longitude.toFixed(6)}* — use this?`,
      { parse_mode: "Markdown", reply_markup: kb }
    );
    while (true) {
      const cbUpd = await conversation.wait();
      if (cbUpd.message?.text?.trim() === "/cancel") { await del(ctx, chatId, confirmMsg.message_id); await ctx.reply("\u274c Cancelled."); return null; }
      if (cbUpd.callbackQuery?.data === "loc:yes") { await cbUpd.answerCallbackQuery(); await del(ctx, chatId, confirmMsg.message_id); return { lat: latitude, lon: longitude }; }
      if (cbUpd.callbackQuery?.data === "loc:retry") { await cbUpd.answerCallbackQuery(); await del(ctx, chatId, confirmMsg.message_id); break; }
    }
  }
}

async function askText(
  conversation: BotConversation,
  ctx: BotContext,
  prompt: string,
  allowSkip = false
): Promise<string | null> {
  const chatId = ctx.chat!.id;
  const qMsg = await ctx.reply(prompt + (allowSkip ? " (or /skip)" : ""));
  const { message } = await conversation.waitFor("message:text");
  await del(ctx, chatId, qMsg.message_id);
  await del(ctx, chatId, message.message_id);
  if (message.text.trim() === "/cancel") { await ctx.reply("❌ Cancelled."); return null; }
  if (allowSkip && message.text.trim() === "/skip") return "__skip__";
  return message.text.trim();
}

async function askVenue(
  conversation: BotConversation,
  ctx: BotContext,
  presets: LocationPreset[]
): Promise<{ name: string; lat: number | null; lon: number | null } | null> {
  const chatId = ctx.chat!.id;
  const kb = new InlineKeyboard();
  presets.forEach((p) => kb.text(`📍 ${p.name}`, `venue:${p.id}`).row());
  kb.text("✍️ Type venue name", "venue:__custom__");
  const msg = await ctx.reply("📍 Venue — pick a preset or type/tap to enter:", { reply_markup: kb });
  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text) {
      const text = upd.message.text.trim();
      if (text === "/cancel") { await del(ctx, chatId, msg.message_id); await del(ctx, chatId, upd.message.message_id); await ctx.reply("❌ Cancelled."); return null; }
      await del(ctx, chatId, msg.message_id); await del(ctx, chatId, upd.message.message_id);
      return { name: text, lat: null, lon: null };
    }
    if (upd.callbackQuery?.data?.startsWith("venue:")) {
      await upd.answerCallbackQuery();
      const key = upd.callbackQuery.data.replace("venue:", "");
      await del(ctx, chatId, msg.message_id);
      if (key === "__custom__") {
        const qMsg = await ctx.reply("📍 Type the venue name:");
        const { message } = await conversation.waitFor("message:text");
        await del(ctx, chatId, qMsg.message_id); await del(ctx, chatId, message.message_id);
        if (message.text.trim() === "/cancel") { await ctx.reply("❌ Cancelled."); return null; }
        return { name: message.text.trim(), lat: null, lon: null };
      }
      const preset = presets.find((p) => p.id === key);
      if (preset) return { name: preset.name, lat: preset.lat, lon: preset.lon };
    }
  }
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
  { id: "map_location",  label: "📍 Map pin" },
];

// ── Main conversation ─────────────────────────────────────────────────────────

export async function modifyEventConversation(
  conversation: BotConversation,
  ctx: BotContext
): Promise<void> {
  // ── Fetch all events ──────────────────────────────────────────────────────
  const { data: events, error } = await getSupabase()
    .from("events")
    .select("id, name, start_date, end_date, location_name, location_city, lat, lon, category, price, description, url, tags")
    .order("start_date", { ascending: true });

  if (error) { await ctx.reply(`❌ Database error: ${error.message}`); return; }
  if (!events || events.length === 0) { await ctx.reply("No events found."); return; }

  const chatId = ctx.chat!.id;

  // ── Event picker ──────────────────────────────────────────────────────────
  // Use index as callback data to avoid Telegram's 64-byte button limit
  const listKb = new InlineKeyboard();
  events.forEach((e, i) => {
    const date = new Date(e.start_date as string);
    const label = `${e.name} (${date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })})`;
    listKb.text(label, `mod:ev:${i}`).row();
  });
  listKb.text("❌ Cancel", "mod:ev:cancel");

  const listMsg = await ctx.reply("✏️ *Modify event* — select an event:", {
    parse_mode: "Markdown",
    reply_markup: listKb,
  });

  let eventId = "";
  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") { await del(ctx, chatId, listMsg.message_id); await ctx.reply("❌ Cancelled."); return; }
    if (!upd.callbackQuery?.data?.startsWith("mod:ev:")) continue;
    await upd.answerCallbackQuery();
    const val = upd.callbackQuery.data.replace("mod:ev:", "");
    if (val === "cancel") { await del(ctx, chatId, listMsg.message_id); await ctx.reply("❌ Cancelled."); return; }
    await del(ctx, chatId, listMsg.message_id);
    const idx = parseInt(val);
    eventId = events[idx]!.id;
    break;
  }

  const event = events.find((e) => e.id === eventId)!

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
  const fieldMsgId = fieldMsg.message_id;

  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") { await del(ctx, chatId, fieldMsgId); await ctx.reply("❌ Cancelled."); return; }
    if (!upd.callbackQuery?.data?.startsWith("mod:f:")) continue;
    await upd.answerCallbackQuery();
    const val = upd.callbackQuery.data.replace("mod:f:", "");
    if (val === "done") {
      if (selectedFields.size === 0) { await upd.answerCallbackQuery("⚠️ Select at least one field"); continue; }
      await del(ctx, chatId, fieldMsgId);
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
        const locationPresets = await getLocations();
        const venueResult = await askVenue(conversation, ctx, locationPresets);
        if (venueResult === null) return;
        updates.location_name = venueResult.name;
        if (venueResult.lat !== null) {
          updates.lat = venueResult.lat;
          updates.lon = venueResult.lon;
        }
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
        const priceMsg = await ctx.reply("💰 New price:", { reply_markup: priceKb });
        const cbCtx = await conversation.waitFor("callback_query:data");
        await cbCtx.answerCallbackQuery();
        await del(ctx, chatId, priceMsg.message_id);
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
        const v = await askText(conversation, ctx, "# New tags — comma or space separated, # optional", true);
        if (v === null) return;
        updates.tags = v === "__skip__" ? [] : v.split(/[\s,]+/).map((t) => t.replace(/^#+/, "").trim().toLowerCase()).filter(Boolean);
        break;
      }
      case "map_location": {
        const v = await askMapLocation(conversation, ctx);
        if (v === null) return;
        if (v !== "__skip__") {
          updates.lat = v.lat;
          updates.lon = v.lon;
        }
        break;
      }
      case "photo": {
        const photoPromptMsg = await ctx.reply("🖼 Send the new photo (or /skip):");
        const photoUpd = await conversation.wait();
        await del(ctx, chatId, photoPromptMsg.message_id);
        if (photoUpd.message) await del(ctx, chatId, photoUpd.message.message_id);
        if (photoUpd.message?.text?.trim() === "/cancel") { await ctx.reply("❌ Cancelled."); return; }
        if (photoUpd.message?.photo && photoUpd.message.photo.length > 0) {
          const largest = photoUpd.message.photo[photoUpd.message.photo.length - 1]!;
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
