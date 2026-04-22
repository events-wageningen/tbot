import type { Context } from "grammy";
import { supabase } from "../lib/supabase.js";
import { formatDate, formatTime } from "../lib/format.js";

export async function listCommand(ctx: Context): Promise<void> {
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("events")
    .select("id, name, start_date, location_name, location_city, price, status")
    .eq("status", "scheduled")
    .gte("start_date", now)
    .order("start_date", { ascending: true })
    .limit(10);

  if (error) {
    await ctx.reply(`❌ Database error: ${error.message}`);
    return;
  }

  if (!data || data.length === 0) {
    await ctx.reply("No upcoming events found.");
    return;
  }

  const lines = data.map(
    (e, i) =>
      `${i + 1}. *${e.name}*\n` +
      `   📅 ${formatDate(e.start_date as string)}, ${formatTime(e.start_date as string)}\n` +
      `   📍 ${e.location_name}, ${e.location_city}\n` +
      `   💰 ${e.price}`
  );

  await ctx.reply(`📋 *Upcoming Events:*\n\n${lines.join("\n\n")}`, {
    parse_mode: "Markdown",
  });
}
