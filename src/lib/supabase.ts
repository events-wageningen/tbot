import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | undefined;

/** Returns the Supabase client, creating it on first call (after dotenv has run). */
export function getSupabase(): SupabaseClient {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set");
    }
    _client = createClient(url, key);
  }
  return _client;
}

export interface Category {
  id: string;
  label: string;
  emoji: string;
}

export async function getCategories(): Promise<Category[]> {
  const { data, error } = await getSupabase()
    .from("categories")
    .select("id, label, emoji")
    .order("label");
  if (error) throw error;
  return data ?? [];
}

export interface LocationPreset {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export async function getLocations(): Promise<LocationPreset[]> {
  const { data } = await getSupabase()
    .from("locations")
    .select("id, name, lat, lon")
    .order("name");
  return (data ?? []) as LocationPreset[];
}
