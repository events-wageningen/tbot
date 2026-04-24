import { config } from "dotenv";
config({ override: true }); // .env always wins over shell env vars
import { Bot, Context, session, InlineKeyboard } from "grammy";
import type { SessionFlavor } from "grammy";
import {
  conversations,
  createConversation,
  type ConversationFlavor,
} from "@grammyjs/conversations";
import { authMiddleware } from "./middleware/auth.js";
import { newEventConversation } from "./commands/new.js";
import { removeEventConversation } from "./commands/remove.js";
import { modifyEventConversation } from "./commands/modify.js";
import { listCommand } from "./commands/list.js";

// ── Validate required env vars at startup ────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error("BOT_TOKEN is not set");

for (const key of [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GITHUB_PAT",
  "GITHUB_OWNER",
  "GITHUB_REPO",
  "ALLOWED_USER_IDS",
]) {
  if (!process.env[key]) throw new Error(`${key} is not set`);
}

// ── Session type ──────────────────────────────────────────────────────────────
interface BotSession {
  /** Name of the grammY conversation currently running for this user. */
  activeConversation?: string;
  /** Set when user requested to switch conversation; awaiting confirmation. */
  pendingSwitch?: string;
  /** Set after "switch:yes" is clicked; triggers entering the new conversation. */
  pendingEnter?: string;
  /** Required index signature for grammY conversations plugin. */
  [key: string]: unknown;
}

// ── Context type ─────────────────────────────────────────────────────────────
type BotContext = Context & SessionFlavor<BotSession> & ConversationFlavor;

// ── Bot setup ─────────────────────────────────────────────────────────────────
const bot = new Bot<BotContext>(BOT_TOKEN);

// Auth guard first — unauthorised users are blocked before everything else
bot.use(authMiddleware);

// Per-user in-memory session — each user gets their own isolated session
bot.use(session({
  initial: (): BotSession => ({}),
  getSessionKey: (ctx) => ctx.from?.id.toString(),
}));

// ── Idle timeout management ───────────────────────────────────────────────────
// Two-level external timer: warn after 60 s, force-close after 120 s.
// These fire via bot.api even when no update is incoming.
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const forceCloseUsers = new Set<string>();

function clearIdleTimer(userId: string): void {
  clearTimeout(idleTimers.get(userId));
  idleTimers.delete(userId);
  forceCloseUsers.delete(userId);
}

function startIdleTimer(userId: string, chatId: number): void {
  clearIdleTimer(userId);
  const warnTimer = setTimeout(async () => {
    try {
      await bot.api.sendMessage(
        chatId,
        "⏰ Still there? This conversation will close in 1 minute if there is no more activity."
      );
    } catch { /* ignore send errors */ }

    const closeTimer = setTimeout(async () => {
      forceCloseUsers.add(userId);
      idleTimers.delete(userId);
      try {
        await bot.api.sendMessage(
          chatId,
          "⏰ Conversation closed due to inactivity. Use /new, /modify, or /remove to start again."
        );
      } catch { /* ignore send errors */ }
    }, 60_000);

    idleTimers.set(userId, closeTimer);
  }, 60_000);

  idleTimers.set(userId, warnTimer);
}

// ── Pre-conversations middleware ──────────────────────────────────────────────
// Runs after session (has ctx.session) but before conversations() so we can
// intercept switch confirmations and force-close timed-out conversations.
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();
  if (!userId) { await next(); return; }

  // 1. Force-close if idle timer expired ─────────────────────────────────────
  if (forceCloseUsers.has(userId)) {
    forceCloseUsers.delete(userId);
    clearIdleTimer(userId);
    ctx.session.activeConversation = undefined;
    ctx.session.pendingSwitch = undefined;
    ctx.session.pendingEnter = undefined;
    // Clear grammY's stored conversation state (key confirmed from library source)
    const sess = ctx.session as BotSession & { conversation?: unknown };
    const hasConversation = sess.conversation != null &&
      typeof sess.conversation === "object" &&
      Object.keys(sess.conversation as object).length > 0;
    if (hasConversation) {
      // Drop the update — user already got the "closed" message from the timer
      delete sess.conversation;
      return;
    }
    // Conversation already finished; just clear flags and continue normally
    await next();
    return;
  }

  // 2. Handle "switch:no" — user wants to keep current conversation ───────────
  if (ctx.callbackQuery?.data === "switch:no" && ctx.session.pendingSwitch) {
    await ctx.answerCallbackQuery();
    ctx.session.pendingSwitch = undefined;
    try { await ctx.deleteMessage(); } catch { /* ignore */ }
    await ctx.reply("👍 Continuing with your current operation.");
    // Don't call next() — the active conversation's wait() would also consume
    // this callback query and silently ignore it, which is fine, but returning
    // here avoids the extra round-trip through the conversation replay.
    return;
  }

  // 3. Handle "switch:yes" — user confirmed cancelling current conversation ───
  if (ctx.callbackQuery?.data === "switch:yes" && ctx.session.pendingSwitch) {
    await ctx.answerCallbackQuery();
    const targetName = ctx.session.pendingSwitch;
    ctx.session.pendingSwitch = undefined;
    try { await ctx.deleteMessage(); } catch { /* ignore */ }

    // Clear the active grammY conversation state so conversations() finds nothing
    const sess = ctx.session as BotSession & { conversation?: unknown };
    delete sess.conversation;
    clearIdleTimer(userId);
    ctx.session.activeConversation = undefined;

    // Signal to the post-conversations middleware to enter the new conversation
    ctx.session.pendingEnter = targetName;
    // Call next() so conversations() and then the post-conversations handler run
    await next();
    return;
  }

  // 4. Reset idle timer on any update from a user with an active conversation ─
  if (ctx.session.activeConversation && ctx.chat?.id) {
    startIdleTimer(userId, ctx.chat.id);
  }

  await next();
});

// ── Conversations plugin (must be after session and our middleware) ───────────
bot.use(conversations());
bot.use(createConversation(newEventConversation));
bot.use(createConversation(removeEventConversation));
bot.use(createConversation(modifyEventConversation));

// ── Post-conversations middleware: handle pending switch + cleanup after finish
// Runs after conversations() so ctx.conversation.enter() is available.
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();

  // If a conversation was running and has now finished (session.conversation is
  // empty after this update), clear the idle timer immediately so no spurious
  // warning fires after the operation completes.
  if (userId && ctx.session.activeConversation) {
    const sess = ctx.session as BotSession & { conversation?: Record<string, unknown> };
    const hasRunningConv =
      sess.conversation != null &&
      typeof sess.conversation === "object" &&
      Object.keys(sess.conversation as object).length > 0;
    if (!hasRunningConv) {
      clearIdleTimer(userId);
      ctx.session.activeConversation = undefined;
    }
  }

  const pendingName = ctx.session.pendingEnter;
  if (pendingName) {
    ctx.session.pendingEnter = undefined;
    ctx.session.activeConversation = pendingName;
    if (userId && ctx.chat?.id) startIdleTimer(userId, ctx.chat.id);
    await ctx.conversation.enter(
      pendingName as Parameters<typeof ctx.conversation.enter>[0],
      { overwrite: true }
    );
    return;
  }
  await next();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const CONVERSATION_LABELS: Record<string, string> = {
  newEventConversation:    "new event",
  removeEventConversation: "remove event",
  modifyEventConversation: "modify event",
};

/**
 * Enter a named conversation, tracking it in session and starting the idle
 * timer. If another conversation is already running, shows a Yes/No prompt.
 */
async function enterConversation(ctx: BotContext, name: string): Promise<void> {
  const current = ctx.session.activeConversation;
  if (current && current !== name) {
    const currentLabel = CONVERSATION_LABELS[current] ?? current;
    const newLabel = CONVERSATION_LABELS[name] ?? name;
    const kb = new InlineKeyboard()
      .text(`✅ Yes, start ${newLabel}`, "switch:yes")
      .text("❌ No, keep going", "switch:no");
    ctx.session.pendingSwitch = name;
    await ctx.reply(
      `⚠️ You are already working on a *${currentLabel}* operation.\n\nDo you want to cancel it and start a *${newLabel}* instead?`,
      { parse_mode: "Markdown", reply_markup: kb }
    );
    return;
  }

  const userId = ctx.from?.id.toString();
  if (userId && ctx.chat?.id) startIdleTimer(userId, ctx.chat.id);
  ctx.session.activeConversation = name;
  await ctx.conversation.enter(
    name as Parameters<typeof ctx.conversation.enter>[0],
    { overwrite: true }
  );
}

// ── Commands ──────────────────────────────────────────────────────────────────
bot.command("start", (ctx) =>
  ctx.reply(
    "👋 Hi! Available commands:\n" +
      "/new — add a new event\n" +
      "/list — list upcoming events\n" +
      "/remove — remove an event\n" +
      "/modify — edit an event\n" +
      "/cancel — cancel current operation"
  )
);

bot.command("new",    (ctx) => enterConversation(ctx, "newEventConversation"));
bot.command("remove", (ctx) => enterConversation(ctx, "removeEventConversation"));
bot.command("modify", (ctx) => enterConversation(ctx, "modifyEventConversation"));

bot.command("list", listCommand);

// /cancel exits any active conversation
bot.command("cancel", async (ctx) => {
  const userId = ctx.from?.id.toString();
  if (userId) clearIdleTimer(userId);
  await ctx.conversation.exit();
  ctx.session.activeConversation = undefined;
  ctx.session.pendingSwitch = undefined;
  await ctx.reply("❌ Cancelled.");
});

// ── Error handling ────────────────────────────────────────────────────────────
bot.catch((err) => {
  console.error("Bot error:", err.message, err.error);
});

// ── Graceful stop ─────────────────────────────────────────────────────────────
process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());

// Register commands with Telegram (shows the "/" menu near the keyboard)
await bot.api.setMyCommands([
  { command: "new",    description: "Add a new event" },
  { command: "list",   description: "List upcoming events" },
  { command: "remove", description: "Remove an event" },
  { command: "modify", description: "Edit an event" },
  { command: "skip",   description: "Skip optional field (use during /new or /modify)" },
  { command: "cancel", description: "Cancel current operation" },
]);

console.log("Bot starting (long polling)…");
bot.start();
