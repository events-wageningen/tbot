import { InlineKeyboard } from "grammy";
import type { Conversation, ConversationFlavor } from "@grammyjs/conversations";
import type { Context } from "grammy";
import { getSupabase } from "../lib/supabase.js";
import { triggerDeploy } from "../lib/github.js";

export type BotContext = Context & ConversationFlavor;
export type BotConversation = Conversation<BotContext>;

export async function removeEventConversation(
  conversation: BotConversation,
  ctx: BotContext
): Promise<void> {
  // ── Fetch upcoming events ────────────────────────────────────────────────
  const { data: events, error } = await getSupabase()
    .from("events")
    .select("id, name, start_date")
    .order("start_date", { ascending: true });

  if (error) {
    await ctx.reply(`❌ Database error: ${error.message}`);
    return;
  }

  if (!events || events.length === 0) {
    await ctx.reply("No events found in the database.");
    return;
  }

  // ── Event picker ─────────────────────────────────────────────────────────
  // Use index as callback data to avoid Telegram's 64-byte button limit
  const kb = new InlineKeyboard();
  events.forEach((e, i) => {
    const date = new Date(e.start_date as string);
    const label = `${e.name} (${date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })})`;
    kb.text(label, `rm:${i}`).row();
  });
  kb.text("❌ Cancel", "rm:cancel");

  await ctx.reply("🗑 *Remove event* — select an event:", {
    parse_mode: "Markdown",
    reply_markup: kb,
  });

  let eventId = "";
  let eventName = "";
  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") {
      await ctx.reply("❌ Cancelled.");
      return;
    }
    if (!upd.callbackQuery?.data?.startsWith("rm:")) continue;
    await upd.answerCallbackQuery();
    const val = upd.callbackQuery.data.replace("rm:", "");
    if (val === "cancel") {
      await ctx.reply("❌ Cancelled.");
      return;
    }
    const idx = parseInt(val);
    eventId = events[idx]!.id;
    eventName = events[idx]!.name;
    break;
  }

  // ── Confirmation ─────────────────────────────────────────────────────────
  const confirmKb = new InlineKeyboard()
    .text("✅ Yes, remove it", "rmconf:yes")
    .text("❌ No, keep it", "rmconf:no");

  await ctx.reply(
    `⚠️ Are you sure you want to remove the event *${eventName}*?\n\nThis cannot be undone.`,
    { parse_mode: "Markdown", reply_markup: confirmKb }
  );

  while (true) {
    const upd = await conversation.wait();
    if (upd.message?.text?.trim() === "/cancel") {
      await ctx.reply("❌ Cancelled.");
      return;
    }
    if (!upd.callbackQuery?.data?.startsWith("rmconf:")) continue;
    await upd.answerCallbackQuery();

    if (upd.callbackQuery.data === "rmconf:no") {
      await ctx.reply("👍 Kept. No changes made.");
      return;
    }
    break;
  }

  // ── Delete ────────────────────────────────────────────────────────────────
  const { error: delError } = await getSupabase()
    .from("events")
    .delete()
    .eq("id", eventId);

  if (delError) {
    await ctx.reply(`❌ Delete failed: ${delError.message}`);
    return;
  }

  // ── Trigger rebuild ───────────────────────────────────────────────────────
  try {
    await triggerDeploy();
    await ctx.reply(
      `✅ *${eventName}* removed. The website will update in ~2 minutes.`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    await ctx.reply(
      `✅ Event removed from DB. Deploy trigger failed:\n${err instanceof Error ? err.message : String(err)}`
    );
  }
}
