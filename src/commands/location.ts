import { InlineKeyboard } from "grammy";
import type { Conversation, ConversationFlavor } from "@grammyjs/conversations";
import type { Context } from "grammy";
import { getSupabase, getLocations } from "../lib/supabase.js";
import { toLocationId } from "../lib/slugify.js";

export type BotContext = Context & ConversationFlavor;
export type BotConversation = Conversation<BotContext>;

// ── Delete helper ─────────────────────────────────────────────────────────────
async function del(ctx: BotContext, chatId: number, msgId: number): Promise<void> {
  try { await ctx.api.deleteMessage(chatId, msgId); } catch { /* ignore */ }
}

// ── HTML escape ───────────────────────────────────────────────────────────────
function escHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Cities (same list as /new) ────────────────────────────────────────────────
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

// ── Mandatory map pin (same UX as /new but without /skip) ─────────────────────
async function askMapLocation(
  conversation: BotConversation,
  ctx: BotContext
): Promise<{ lat: number; lon: number } | null> {
  const chatId = ctx.chat!.id;

  while (true) {
    const instrMsg = await ctx.reply(
      "📍 *Map pin — required for location presets*\n\n" +
      "Tap 📎 → Location in Telegram, browse the map, drag the pin to the venue, and send it.\n" +
      "Tip: use the search bar in the location picker to navigate first.\n\n" +
      "Type /cancel to abort.",
      { parse_mode: "Markdown" }
    );

    let locReceived: { latitude: number; longitude: number } | null = null;

    outer: while (true) {
      const upd = await conversation.wait();
      const text = upd.message?.text?.trim();
      if (text === "/cancel") {
        await del(ctx, chatId, instrMsg.message_id);
        await ctx.reply("❌ Cancelled.");
        return null;
      }
      if (upd.message?.location) {
        await del(ctx, chatId, instrMsg.message_id);
        if (upd.message.message_id) await del(ctx, chatId, upd.message.message_id);
        locReceived = { latitude: upd.message.location.latitude, longitude: upd.message.location.longitude };
        break outer;
      }
    }

    if (!locReceived) continue;

    const { latitude, longitude } = locReceived;
    const kb = new InlineKeyboard()
      .text("✅ Confirm", "loc:yes")
      .text("🔄 Retry", "loc:retry");
    const confirmMsg = await ctx.reply(
      `📍 Pin placed at *${latitude.toFixed(6)}, ${longitude.toFixed(6)}*\n\nUse this location?`,
      { parse_mode: "Markdown", reply_markup: kb }
    );

    while (true) {
      const cbUpd = await conversation.wait();
      if (cbUpd.message?.text?.trim() === "/cancel") {
        await del(ctx, chatId, confirmMsg.message_id);
        await ctx.reply("❌ Cancelled.");
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

// ─────────────────────────────────────────────────────────────────────────────
// ADD LOCATION
// ─────────────────────────────────────────────────────────────────────────────

export async function addLocationConversation(
  conversation: BotConversation,
  ctx: BotContext
): Promise<void> {
  const chatId = ctx.chat!.id;

  // ── Recap ─────────────────────────────────────────────────────────────────
  type RecapEntry = { key: string; label: string; value: string };
  const recap: RecapEntry[] = [];
  let recapMsgId = 0;

  function setRecap(key: string, label: string, value: string): void {
    const existing = recap.find((r) => r.key === key);
    if (existing) existing.value = value;
    else recap.push({ key, label, value });
  }

  async function updateRecap(): Promise<void> {
    const body = recap.length > 0
      ? recap.map((r) => `${escHtml(r.label)}: ${escHtml(r.value)}`).join("\n")
      : "(filling in...)";
    const text = `<b>📍 You are adding a location preset</b>\n<b>Current summary:</b>\n──────────────────\n${body}`;
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

  // ── Name ──────────────────────────────────────────────────────────────────
  const namePrompt = await ctx.reply("✏️ Location name: (or /cancel)");
  const { message: nameMsg } = await conversation.waitFor("message:text");
  await del(ctx, chatId, namePrompt.message_id);
  await del(ctx, chatId, nameMsg.message_id);
  if (nameMsg.text.trim() === "/cancel") { await ctx.reply("❌ Cancelled."); return; }
  const name = nameMsg.text.trim();
  if (!name) { await ctx.reply("⚠️ Name cannot be empty. Use /addlocation to try again."); return; }

  const id = toLocationId(name);
  setRecap("name", "✏️ Name", name);
  setRecap("id",   "🔑 ID",   id);
  await updateRecap();

  // ── City ──────────────────────────────────────────────────────────────────
  const city = await askCity(conversation, ctx);
  if (city === null) return;
  setRecap("city", "🏙 City", city);
  await updateRecap();

  // ── Map pin ───────────────────────────────────────────────────────────────
  const pin = await askMapLocation(conversation, ctx);
  if (pin === null) return;
  setRecap("pin", "📌 Coords", `${pin.lat.toFixed(6)}, ${pin.lon.toFixed(6)}`);
  await updateRecap();

  // ── Confirm ───────────────────────────────────────────────────────────────
  const confirmKb = new InlineKeyboard()
    .text("✅ Save", "loc:confirm:yes")
    .text("❌ Cancel", "loc:confirm:no");

  await ctx.reply(
    `*Review location preset:*\n\n` +
    `*Name:* ${name}\n` +
    `*ID:* \`${id}\`\n` +
    `*City:* ${city}\n` +
    `*Coords:* ${pin.lat.toFixed(6)}, ${pin.lon.toFixed(6)}`,
    { parse_mode: "Markdown", reply_markup: confirmKb }
  );

  const confirmCtx = await conversation.waitFor("callback_query:data");
  await confirmCtx.answerCallbackQuery();
  if (confirmCtx.callbackQuery.data !== "loc:confirm:yes") {
    await ctx.reply("❌ Cancelled.");
    return;
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  await ctx.reply("⏳ Saving…");

  const { error } = await getSupabase().from("locations").insert({
    id,
    name,
    city,
    lat: pin.lat,
    lon: pin.lon,
  });

  if (error) {
    await ctx.reply(`❌ Database error: ${error.message}`);
    return;
  }

  await ctx.reply(`✅ *${name}* added as a location preset\\!`, { parse_mode: "MarkdownV2" });
}

// ─────────────────────────────────────────────────────────────────────────────
// REMOVE LOCATION
// ─────────────────────────────────────────────────────────────────────────────

export async function removeLocationConversation(
  conversation: BotConversation,
  ctx: BotContext
): Promise<void> {
  const chatId = ctx.chat!.id;

  const locations = await getLocations();

  if (locations.length === 0) {
    await ctx.reply("No location presets found in the database.");
    return;
  }

  // ── Recap ─────────────────────────────────────────────────────────────────
  let recapMsgId = 0;
  async function updateRecap(locationName?: string): Promise<void> {
    const body = locationName ? `Location: ${escHtml(locationName)}` : "(selecting location...)";
    const text = `<b>🗑 You are removing a location preset</b>\n<b>Current summary:</b>\n──────────────────\n${body}`;
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

  // ── Pick location ──────────────────────────────────────────────────────────
  const kb = new InlineKeyboard();
  locations.forEach((loc, i) => {
    kb.text(`📍 ${loc.name} (${loc.city ?? "?"})`, `rmloc:${i}`).row();
  });

  const listMsg = await ctx.reply("Which location preset do you want to remove?", { reply_markup: kb });

  let selectedIdx = -1;
  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") {
      await del(ctx, chatId, listMsg.message_id);
      await ctx.reply("❌ Cancelled.");
      return;
    }
    if (upd.callbackQuery?.data?.startsWith("rmloc:")) {
      await upd.answerCallbackQuery();
      selectedIdx = parseInt(upd.callbackQuery.data.replace("rmloc:", ""));
      await del(ctx, chatId, listMsg.message_id);
      break;
    }
  }

  const location = locations[selectedIdx];
  if (!location) {
    await ctx.reply("⚠️ Invalid selection.");
    return;
  }

  await updateRecap(location.name);

  // ── Confirm ───────────────────────────────────────────────────────────────
  const confirmKb = new InlineKeyboard()
    .text("🗑 Yes, remove", "rmloc:confirm:yes")
    .text("❌ No, keep it", "rmloc:confirm:no");

  await ctx.reply(
    `Are you sure you want to remove *${location.name}* (${location.city ?? "?"}) from the location presets?`,
    { parse_mode: "Markdown", reply_markup: confirmKb }
  );

  const confirmCtx = await conversation.waitFor("callback_query:data");
  await confirmCtx.answerCallbackQuery();
  if (confirmCtx.callbackQuery.data !== "rmloc:confirm:yes") {
    await ctx.reply("❌ Cancelled.");
    return;
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  const { error } = await getSupabase()
    .from("locations")
    .delete()
    .eq("id", location.id);

  if (error) {
    await ctx.reply(`❌ Database error: ${error.message}`);
    return;
  }

  await ctx.reply(`✅ *${location.name}* removed from location presets\\.`, { parse_mode: "MarkdownV2" });
}
