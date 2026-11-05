/**
 * The project's own server keys, as the edge runtime gives them to a function,
 * for functions that let a server (pg_cron, a script, staff with curl) in by
 * key rather than by a user's session.
 *
 * Supabase Cloud injects (docs: Edge Functions > Environment variables):
 *   SUPABASE_SERVICE_ROLE_KEY  the legacy service_role key (a JWT)
 *   SUPABASE_SECRET_KEYS       the new secret keys, a JSON object by name:
 *                              {"default": "sb_secret_..."}
 * A project can have both. The legacy value the function sees isn't always
 * the one the dashboard shows (seen on ynxxzyyespdzvmerozyd, 2026-11-03), so a
 * function that only accepts SUPABASE_SERVICE_ROLE_KEY can refuse the
 * dashboard's key. Functions that need a dependable key also take one of
 * their own (platform-sync: PLATFORM_SYNC_KEY).
 */

import { secretsMatch } from "./daraja.ts";

type Env = { get(name: string): string | undefined };

/** Every server key the runtime injected: the legacy service_role key and each named secret key. */
export function injectedServerKeys(env: Env = Deno.env): string[] {
  const keys: string[] = [];
  const legacy = env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (legacy) keys.push(legacy);
  const raw = env.get("SUPABASE_SECRET_KEYS")?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const value of Object.values(parsed)) if (typeof value === "string" && value.trim()) keys.push(value.trim());
      }
    } catch {
      console.error("serviceKeys: SUPABASE_SECRET_KEYS is not JSON; ignoring it");
    }
  }
  return keys;
}

/** Whether `given` equals any of `keys`, each compared in constant time, and all of them compared whatever matches. */
export function matchesAnyKey(given: string | null | undefined, keys: string[]): boolean {
  if (!given) return false;
  let match = false;
  for (const key of keys) match = secretsMatch(given, key) || match;
  return match;
}

/**
 * What a presented key is, safe to log: its kind and length, and for a JWT
 * its public claims (role, ref, issued). Never the key, nor any part of it
 * that would help guess it.
 */
export function describeKey(given: string | null | undefined): string {
  if (!given) return "none";
  if (given.startsWith("sb_secret_")) return `sb_secret_ key (${given.length} chars)`;
  if (given.startsWith("sb_publishable_")) return `sb_publishable_ key (${given.length} chars)`;
  const parts = given.split(".");
  if (parts.length === 3) {
    try {
      const claims = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
      return `JWT (${given.length} chars; role=${claims.role ?? "?"}, ref=${claims.ref ?? "?"}, iat=${claims.iat ?? "?"})`;
    } catch { /* not a JWT after all */ }
  }
  return `other (${given.length} chars)`;
}
