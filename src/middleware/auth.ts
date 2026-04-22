import type { Context, NextFunction } from "grammy";

const ALLOWED = new Set(
  (process.env.ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

export async function authMiddleware(
  ctx: Context,
  next: NextFunction
): Promise<void> {
  const userId = String(ctx.from?.id ?? "");
  if (!ALLOWED.has(userId)) {
    // Only reply if there's a message or callback to reply to
    if (ctx.message ?? ctx.callbackQuery) {
      await ctx.reply("⛔ Not authorised.");
    }
    return;
  }
  await next();
}
