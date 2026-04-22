import { config } from "dotenv";
config({ override: true }); // .env always wins over shell env vars
import { Bot, Context, session } from "grammy";
import type { SessionFlavor } from "grammy";
import {
  conversations,
  createConversation,
  type ConversationFlavor,
} from "@grammyjs/conversations";
import { authMiddleware } from "./middleware/auth.js";
import { newEventConversation } from "./commands/new.js";
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

// ── Context type ─────────────────────────────────────────────────────────────
// ConversationFlavor adds ctx.conversation; SessionFlavor provides the session
// storage that conversations v1 requires internally.
type BotContext = Context &
  SessionFlavor<Record<string, unknown>> &
  ConversationFlavor;

// ── Bot setup ─────────────────────────────────────────────────────────────────
const bot = new Bot<BotContext>(BOT_TOKEN);

// Auth guard first — unauthorised users are blocked before everything else
bot.use(authMiddleware);

// In-memory session (survives between messages, lost on bot restart — fine for 1-2 admins)
bot.use(session({ initial: (): Record<string, unknown> => ({}) }));

// Conversations plugin (must be after session)
bot.use(conversations());

// Register conversation handlers
bot.use(createConversation(newEventConversation));

// ── Commands ──────────────────────────────────────────────────────────────────
bot.command("start", (ctx) =>
  ctx.reply(
    "👋 Hi! Available commands:\n" +
      "/new — add a new event\n" +
      "/list — list upcoming events\n" +
      "/cancel — cancel current operation"
  )
);

bot.command("new", (ctx) =>
  ctx.conversation.enter("newEventConversation")
);

bot.command("list", listCommand);

// /cancel exits any active conversation
bot.command("cancel", async (ctx) => {
  await ctx.conversation.exit();
  await ctx.reply("❌ Cancelled.");
});

// ── Error handling ────────────────────────────────────────────────────────────
bot.catch((err) => {
  console.error("Bot error:", err.message, err.error);
});

// ── Graceful stop ─────────────────────────────────────────────────────────────
process.once("SIGINT", () => bot.stop());
process.once("SIGTERM", () => bot.stop());

console.log("Bot starting (long polling)…");
bot.start();
