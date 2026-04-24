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
bot.use(createConversation(removeEventConversation));
bot.use(createConversation(modifyEventConversation));

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

bot.command("new", async (ctx) => {
  await ctx.conversation.enter("newEventConversation", { overwrite: true });
});

bot.command("remove", async (ctx) => {
  await ctx.conversation.enter("removeEventConversation", { overwrite: true });
});

bot.command("modify", async (ctx) => {
  await ctx.conversation.enter("modifyEventConversation", { overwrite: true });
});

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
