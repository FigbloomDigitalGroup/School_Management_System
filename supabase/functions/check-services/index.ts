/**
 * Live-checks the external services the platform console's Health page
 * depends on and logs each result to `service_status`.
 *
 * Deploy: supabase functions deploy check-services
 *
 * Deliberately narrow: no cron/pg_net monitoring infrastructure — a
 * super_admin opening the Health page triggers a fresh check, and the log
 * builds up a real (if sparse) history from repeated views rather than
 * inventing a multi-region uptime model this app isn't actually deployed as.
 *
 * M-Pesa only checks whether Daraja credentials are *configured*, not a
 * live call to Safaricom — payment integration itself is a separate,
 * deliberately deferred piece of work (see FIG-295).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";

type Status = "ok" | "degraded" | "down" | "not_configured";

interface CheckResult {
  service: string;
  status: Status;
  latency_ms: number | null;
  detail: string | null;
}

// deno-lint-ignore no-explicit-any
async function checkSupabase(admin: any): Promise<CheckResult> {
  const start = Date.now();
  try {
    const { error } = await admin.from("tenants").select("id").limit(1);
    const latency_ms = Date.now() - start;
    if (error) return { service: "supabase", status: "down", latency_ms, detail: error.message };
    return { service: "supabase", status: latency_ms > 2000 ? "degraded" : "ok", latency_ms, detail: null };
  } catch (err) {
    return {
      service: "supabase", status: "down", latency_ms: Date.now() - start,
      detail: err instanceof Error ? err.message : "Unreachable",
    };
  }
}

function checkMpesa(): CheckResult {
  const configured = Boolean(Deno.env.get("DARAJA_CONSUMER_KEY")) && Boolean(Deno.env.get("DARAJA_CONSUMER_SECRET"));
  return configured
    ? { service: "mpesa", status: "ok", latency_ms: null, detail: "Daraja credentials configured" }
    : { service: "mpesa", status: "not_configured", latency_ms: null, detail: "Daraja credentials are not set on this project" };
}

// deno-lint-ignore no-explicit-any
export interface Deps { admin: any; asUser: any }

export async function handle(req: Request, { admin, asUser }: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = req.headers.get("Authorization");
  if (!auth) return json({ error: "Unauthorized" }, 401);

  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return json({ error: "Unauthorized" }, 401);

  const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (profile?.role !== "super_admin") {
    return json({ error: "Only Figbloom staff can check service status." }, 403);
  }

  const results = [await checkSupabase(admin), checkMpesa()];

  const { error: insertErr } = await admin.from("service_status").insert(
    results.map((r) => ({ service: r.service, status: r.status, latency_ms: r.latency_ms, detail: r.detail })),
  );
  if (insertErr) return json({ error: insertErr.message }, 500);

  return json({ results });
}

if (import.meta.main) {
  Deno.serve((req) => {
    const auth = req.headers.get("Authorization") ?? "";
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    return handle(req, { admin, asUser });
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
