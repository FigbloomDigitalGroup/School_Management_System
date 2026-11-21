/**
 * "HR & Payroll" in the web console: a one-time sign-in link into Figbloom HR
 * for the person clicking (SCHOOLS_HR_HANDOFF_CONTRACT.md section 3).
 *
 * POST {"tenant_id": "<the school's tenants.id>"} with the person's own JWT.
 *
 *   1. The same rule as the sidebar item, asked as the caller:
 *      hr_handoff_status(tenant_id) (20261105700000). It refuses (42501)
 *      anyone who isn't the school's admin, an org admin of its organisation,
 *      or a holder of the fees area; 'off' (platform_settings
 *      PLATFORM_HANDOFF_ENABLED) and 'not_linked' (the platform doesn't know
 *      the school yet) are refused here.
 *      'not_enabled' (the platform said no in the last hour) is asked again:
 *      someone clicking means they expect it to work now.
 *   2. POST /handoffs to the platform as Schools (_shared/platformClient.ts):
 *      target "hr", the school, and the caller's profile: id, name, role and
 *      a real email or null (a synthetic sign-in address is no email).
 *   3. The platform's answer is recorded (platform_record_module_status), so
 *      the item hides for an hour after a "no" and shows after a "yes":
 *        201                          -> {url, expires_at}; the web app opens url in a new tab
 *        409 target_not_enabled       -> HR isn't on for the school
 *        409 target_not_linked        -> HR is on but its company isn't linked to the school
 *        409 target_no_handoff_url    -> HR hasn't registered where it accepts sign-ins
 *        404                          -> the platform doesn't know the school
 *        429                          -> too many in the last minute
 *        unreachable / 5xx / token    -> 503, try again shortly
 *
 * Refusals answer {error: "<a sentence>", code: "<reason>"}. The one-time
 * code in the URL is never logged or audited.
 *
 * Function secrets: PLATFORM_CLIENT_ID, PLATFORM_CLIENT_SECRET,
 * PLATFORM_TOKEN_URL, PLATFORM_API_URL (the same as platform-sync).
 *
 * Deploy: supabase functions deploy open-hr   (verify_jwt = true)
 */

import { createClient } from "npm:@supabase/supabase-js@2.116.0";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { PlatformClient, platformConfigFromEnv, PlatformError } from "../_shared/platformClient.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TARGET = "hr";

export interface Deps {
  // deno-lint-ignore no-explicit-any
  admin: any;
  /** A client acting as the caller (their JWT): hr_handoff_status needs auth.uid(). */
  // deno-lint-ignore no-explicit-any
  asUser: any;
  /** null when the PLATFORM_* secrets aren't set. */
  client: PlatformClient | null;
}

/** Same as the database's platform_real_email(): trimmed, lower-case, and null for a synthetic or malformed address. */
export function realEmail(address: string | null | undefined): string | null {
  const a = (address ?? "").trim().toLowerCase();
  if (!a || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a)) return null;
  if (/\.(internal|invalid)$/.test(a)) return null;
  return a;
}

/** What each platform refusal means to the person who clicked. */
const TARGET_REFUSALS: Record<string, string> = {
  target_not_enabled: "HR & Payroll isn't switched on for this school yet. Ask Figbloom to turn it on.",
  target_not_linked: "HR & Payroll is on for this school, but its HR company isn't connected yet. Ask Figbloom to finish the setup.",
  target_no_handoff_url: "HR & Payroll isn't ready to accept sign-ins from Figbloom Schools yet. Try again later.",
};

export async function handle(req: Request, { admin, asUser, client }: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");
  if (!req.headers.get("Authorization")) return fail(401, "unauthorized", "Sign in first.");

  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return fail(401, "unauthorized", "Sign in first.");

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return fail(400, "invalid_json", "The body must be JSON."); }
  const tenantId = typeof body?.tenant_id === "string" ? body.tenant_id.trim() : "";
  if (!UUID.test(tenantId)) return fail(400, "invalid_school", "Say which school (tenant_id).");

  // 1. the rule, as the caller
  const { data: status, error: statusError } = await asUser.rpc("hr_handoff_status", { p_tenant_id: tenantId });
  if (statusError?.code === "42501") return fail(403, "forbidden", "HR & Payroll is for the school's administrators and the bursar.");
  if (statusError) {
    console.error("open-hr: hr_handoff_status failed:", statusError.message);
    return fail(500, "status_failed", "Could not check access to HR & Payroll. Try again.");
  }
  switch (status) {
    case "off":
      return fail(403, "handoff_off", "Signing in to HR & Payroll from Figbloom Schools isn't available yet.");
    case "not_linked":
      return fail(409, "school_not_linked", "This school isn't connected to the Figbloom platform yet. Try again later, or ask Figbloom.");
    case "available":
    case "not_enabled":
      break;
    default:
      console.error("open-hr: unexpected hr_handoff_status:", status);
      return fail(500, "status_failed", "Could not check access to HR & Payroll. Try again.");
  }

  if (!client) return fail(503, "platform_not_configured", "HR & Payroll can't be reached from Figbloom Schools yet. Ask Figbloom.");

  const { data: profile, error: profileError } = await admin
    .from("profiles").select("id, full_name, email, role").eq("id", user.id).maybeSingle();
  if (profileError || !profile) {
    if (profileError) console.error("open-hr: profile read failed:", profileError.message);
    return fail(403, "forbidden", "HR & Payroll is for the school's administrators and the bursar.");
  }

  // 2. the platform
  let answer: { url: string; expires_at: string };
  try {
    answer = await client.createHandoff({
      target: TARGET,
      tenant_local_id: tenantId,
      person: {
        external_id: profile.id,
        name: profile.full_name ?? "",
        email: realEmail(profile.email) ?? realEmail(user.email),
        role: profile.role,
      },
    });
  } catch (err) {
    if (err instanceof PlatformError && err.status === 409 && Object.hasOwn(TARGET_REFUSALS, err.code)) {
      await record(admin, tenantId, false, err.code);
      return fail(409, err.code, TARGET_REFUSALS[err.code]!);
    }
    if (err instanceof PlatformError && err.status === 404) {
      return fail(409, "school_not_linked", "The Figbloom platform doesn't know this school yet. Try again later, or ask Figbloom.");
    }
    if (err instanceof PlatformError && err.status === 429) {
      return fail(429, "rate_limited", "Too many HR sign-ins for this school in the last minute. Wait a moment and try again.");
    }
    const why = err instanceof PlatformError ? `${err.status} ${err.code}` : err instanceof Error ? err.message : String(err);
    console.error(`open-hr: POST /handoffs failed for school ${tenantId}: ${why}`);
    return fail(503, "platform_unavailable", "HR & Payroll can't be reached right now. Try again in a minute.");
  }

  // never hand the browser anything but an https address to open
  let url: URL | null = null;
  try { url = new URL(answer?.url); } catch { /* not a URL */ }
  if (!url || url.protocol !== "https:") {
    console.error(`open-hr: the platform's handoff answer for school ${tenantId} is not an https URL`);
    return fail(502, "platform_bad_answer", "HR & Payroll can't be reached right now. Try again in a minute.");
  }

  // 3. remembered, and audited (no code)
  await record(admin, tenantId, true, null);
  const { error: auditError } = await admin.from("audit_events").insert({
    tenant_id: tenantId,
    actor_id: user.id,
    actor_label: profile.full_name ?? "Unknown",
    event: "Opened HR & Payroll (one-time sign-in link)",
    category: "access",
  });
  if (auditError) console.error("open-hr: audit failed:", auditError.message);

  return json({ url: url.href, expires_at: answer.expires_at });
}

// deno-lint-ignore no-explicit-any
async function record(admin: any, tenantId: string, enabled: boolean, reason: string | null) {
  const { error } = await admin.rpc("platform_record_module_status", {
    p_tenant_id: tenantId, p_module: TARGET, p_enabled: enabled, p_reason: reason,
  });
  if (error) console.error("open-hr: could not record HR's status:", error.message);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });

const fail = (status: number, code: string, error: string) => json({ error, code }, status);

let platformClient: PlatformClient | null | undefined;

if (import.meta.main) {
  Deno.serve((req) => {
    const auth = req.headers.get("Authorization") ?? "";
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const asUser = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: auth } },
    });
    // one per warm isolate, so its token is reused
    if (platformClient === undefined) {
      const config = platformConfigFromEnv();
      platformClient = config ? new PlatformClient(config) : null;
    }
    return handle(req, { admin, asUser, client: platformClient });
  });
}
