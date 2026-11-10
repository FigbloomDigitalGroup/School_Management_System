import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * One client factory for web and React Native. RN passes its own storage
 * adapter (AsyncStorage) and disables URL session detection.
 */

export interface ClientConfig {
  url: string;
  anonKey: string;
  storage?: { getItem(k: string): unknown; setItem(k: string, v: string): unknown; removeItem(k: string): unknown };
  detectSessionInUrl?: boolean;
}

let client: SupabaseClient | null = null;
let apiKey = "";

export function initSupabase(cfg: ClientConfig): SupabaseClient {
  apiKey = cfg.anonKey;
  client = createClient(cfg.url, cfg.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: cfg.detectSessionInUrl ?? true,
      ...(cfg.storage ? { storage: cfg.storage as never } : {}),
    },
  });
  return client;
}

export function supabase(): SupabaseClient {
  if (!client) throw new Error("initSupabase() must run before supabase() — see apps/web/src/lib/client.ts");
  return client;
}

/** The public API key the client was made with (the files API passes it on to the database with the user's token). */
export function supabaseApiKey(): string {
  return apiKey;
}

/** Every tenant-scoped read goes through here so the filter is never forgotten. */
export function scoped(table: string, tenantId: string) {
  return supabase().from(table).select("*").eq("tenant_id", tenantId);
}
