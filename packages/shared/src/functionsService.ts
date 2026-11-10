import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "./supabase";

/**
 * Where the apps call the edge functions: the database's functions_service row (supabase/migrations/
 * 20261110150000_functions_service.sql). No row: the database server's edge runtime, as before. A row: the same functions on
 * AWS Lambda at base_url (figbloom-platform SchoolsFunctions-<env>).
 *
 * Every call already goes through supabase().functions (directly, or through invokeEdge), and supabase-js builds that client
 * from one address it keeps, functionsUrl. Pointing that at the row's address moves every call at once, with no call site
 * changed. functionsService.test.ts checks this against the real supabase-js, so an upgrade that changes it fails in CI.
 *
 * Read once, as the app starts (the apps start it with the client). A call made before it is read goes the old way, which
 * is harmless: both run against the same database. A failed read leaves the old way and is tried again on the next start.
 */
export function pointFunctionsAt(client: SupabaseClient, baseUrl: string): void {
  const c = client as unknown as { functionsUrl?: unknown };
  if (!(c.functionsUrl instanceof URL)) {
    throw new Error("supabase-js no longer keeps functionsUrl as a URL: functionsService.ts needs updating");
  }
  c.functionsUrl = new URL(baseUrl.replace(/\/+$/, ""));
}

let loading: Promise<void> | null = null;

export function loadFunctionsService(): Promise<void> {
  loading ??= (async () => {
    const { data, error } = await supabase().from("functions_service").select("base_url").maybeSingle<{ base_url: string }>();
    // no such table yet (the app deployed before its migration): the functions are where they always were
    if (error && (error.code === "PGRST205" || error.code === "42P01")) return;
    if (error) throw new Error(`Could not find out where the functions are: ${error.message}`);
    if (data?.base_url) pointFunctionsAt(supabase(), data.base_url);
  })().catch((err: unknown) => {
    loading = null;
    throw err;
  });
  return loading;
}
