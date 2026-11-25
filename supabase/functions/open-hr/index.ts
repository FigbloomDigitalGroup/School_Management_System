/**
 * "HR & Payroll" in the web console (SCHOOLS_HR_HANDOFF_CONTRACT.md section 3; HR_CONNECT_SPEC.md): whether
 * Figbloom HR is there for the school, asking Figbloom for it, and a one-time sign-in link into it for the
 * person clicking.
 *
 * POST {"tenant_id": "<the school's tenants.id>", "action"?: "open" | "status" | "request"} with the person's own
 * JWT. JWT verification may be off at the gateway (production's self-hosted Supabase turns it off for every
 * function), so the caller is always checked here (auth.getUser with their Authorization header).
 *
 * Every action first asks the same rule as the sidebar, as the caller: hr_handoff_status(tenant_id)
 * (20261105700000). It refuses (42501 -> 403 forbidden) anyone who isn't the school's admin, an org admin of its
 * organisation, or a holder of the fees area; 'off' (platform_settings PLATFORM_HANDOFF_ENABLED, the master
 * switch) hides everything.
 *
 * action "status" -> {enabled, connection, requested_at, can_request_hr}
 *   enabled         false while PLATFORM_HANDOFF_ENABLED is off (then connection and requested_at are null)
 *   connection      whether HR is there for the school, from the platform with Schools' service client
 *                   (kept in memory a minute per school, the platform's cache_seconds at most):
 *     not_connected   the platform doesn't know the school (platform_links), or GET /tenants/{id}/modules/hr
 *                     isn't module_status "active"
 *     setting_up      HR is on but GET /tenants/{id}/links/hr is 404: HR hasn't created/linked the school yet
 *     connected       HR is on and linked: the handoff will work
 *     unknown         the platform couldn't be asked (not configured, unreachable, an error): the web app
 *                     offers HR as if connected, and the launch tab says what's wrong
 *   requested_at    when the school asked Figbloom for HR (ISO), or null
 *
 * action "request" -> {requested_at}: the school asks Figbloom for HR (tenants.hr_requested_at / _by,
 *   20261124100000; staff see it in the console via platform-schools and switch HR on there). The first request
 *   is kept: asking again answers its time. 409 already_connected when HR is connected or being set up;
 *   403 handoff_off while the switch is off.
 *
 * action "open" (the default) -> {url, expires_at}:
 *   1. 'not_linked' (the platform doesn't know the school yet) is refused; 'not_enabled' (the platform said no
 *      in the last hour) is asked again: someone clicking means they expect it to work now.
 *   2. POST /handoffs to the platform as Schools (_shared/platformClient.ts):
 *      target "hr", the school, and the caller's profile: id, name, role and
 *      a real email or null (a synthetic sign-in address is no email).
 *   3. The platform's answer is recorded (platform_record_module_status):
 *        201                          -> {url, expires_at}; the web app's launch tab replaces itself with url
 *        409 target_not_enabled       -> HR isn't on for the school
 *        409 target_not_linked        -> HR is on but its company isn't linked to the school
 *        409 target_no_handoff_url    -> HR hasn't registered where it accepts sign-ins
 *        404                          -> the platform doesn't know the school (school_not_linked)
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
  /** Each school's HR connection as last worked out (one per warm isolate; a fresh one per test). */
  connections?: ConnectionCache;
  now?: () => number;
}

/** Whether Figbloom HR is there for a school (see the top). */
export type HrConnection = "connected" | "setting_up" | "not_connected" | "unknown";
export type ConnectionCache = Map<string, { value: HrConnection; until: number }>;

/** How long a school's connection is kept (the platform's cache_seconds, at most this); a failed check only briefly. */
export const CONNECTION_CACHE_SECONDS = 60;
export const UNKNOWN_CACHE_SECONDS = 15;

export const ACTIONS = ["open", "status", "request"] as const;
type Action = typeof ACTIONS[number];

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

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const { admin, asUser, client } = deps;
  const connections = deps.connections ?? new Map();
  const now = deps.now ?? Date.now;
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
  const action: Action | null = body?.action === undefined || body?.action === null ? "open"
    : (ACTIONS as readonly unknown[]).includes(body.action) ? body.action as Action : null;
  if (!action) return fail(400, "unknown_action", 'The action must be "open", "status" or "request".');

  // 1. the rule, as the caller
  const { data: status, error: statusError } = await asUser.rpc("hr_handoff_status", { p_tenant_id: tenantId });
  if (statusError?.code === "42501") return fail(403, "forbidden", "HR & Payroll is for the school's administrators and the bursar.");
  if (statusError) {
    console.error("open-hr: hr_handoff_status failed:", statusError.message);
    return fail(500, "status_failed", "Could not check access to HR & Payroll. Try again.");
  }
  if (!["off", "not_linked", "not_enabled", "available"].includes(status)) {
    console.error("open-hr: unexpected hr_handoff_status:", status);
    return fail(500, "status_failed", "Could not check access to HR & Payroll. Try again.");
  }

  if (action === "status") {
    if (status === "off") return json({ enabled: false, connection: null, requested_at: null, can_request_hr: false });
    const [connection, requested] = await Promise.all([
      status === "not_linked" ? Promise.resolve<HrConnection>("not_connected") : connectionOf(admin, client, connections, now, tenantId),
      requestedAt(admin, tenantId),
    ]);
    return json({ enabled: true, connection, requested_at: requested.ok ? requested.at : null, can_request_hr: true });
  }

  if (action === "request") {
    if (status === "off") return fail(403, "handoff_off", "HR & Payroll isn't available from Figbloom Schools yet.");
    const connection = status === "not_linked" ? "not_connected" : await connectionOf(admin, client, connections, now, tenantId);
    if (connection === "connected" || connection === "setting_up") {
      return fail(409, "already_connected", "Figbloom HR is already switched on for this school.");
    }
    const before = await requestedAt(admin, tenantId);
    if (!before.ok) return fail(500, "request_failed", "Couldn't send the request. Try again.");
    if (before.at) return json({ requested_at: before.at });
    const { data: at, error: requestError } = await admin.rpc("platform_record_hr_request", { p_tenant_id: tenantId, p_profile_id: user.id });
    if (requestError || !at) {
      console.error("open-hr: could not record the HR request:", requestError?.message ?? "no answer");
      return fail(500, "request_failed", "Couldn't send the request. Try again.");
    }
    connections.delete(tenantId);
    const { data: me } = await admin.from("profiles").select("full_name").eq("id", user.id).maybeSingle();
    const { error: auditError } = await admin.from("audit_events").insert({
      tenant_id: tenantId,
      actor_id: user.id,
      actor_label: me?.full_name ?? "Unknown",
      event: "Asked Figbloom for HR & Payroll",
      category: "access",
    });
    if (auditError) console.error("open-hr: audit failed:", auditError.message);
    return json({ requested_at: iso(at) });
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
      connections.delete(tenantId);
      return fail(409, err.code, TARGET_REFUSALS[err.code]!);
    }
    if (err instanceof PlatformError && err.status === 404) {
      connections.delete(tenantId);
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

/**
 * Whether HR is there for the school (see the top), kept a minute per school. Never throws: a platform that can't be
 * asked is "unknown". Asked only after the caller passed the rule and the switch is on.
 */
export async function connectionOf(
  // deno-lint-ignore no-explicit-any
  admin: any, client: PlatformClient | null, cache: ConnectionCache, now: () => number, tenantId: string,
): Promise<HrConnection> {
  const kept = cache.get(tenantId);
  if (kept && kept.until > now()) return kept.value;
  const { value, seconds } = await askPlatform(admin, client, tenantId);
  cache.set(tenantId, { value, until: now() + seconds * 1000 });
  return value;
}

// deno-lint-ignore no-explicit-any
async function askPlatform(admin: any, client: PlatformClient | null, tenantId: string): Promise<{ value: HrConnection; seconds: number }> {
  if (!client) return { value: "unknown", seconds: UNKNOWN_CACHE_SECONDS };
  try {
    const { data: link, error } = await admin
      .from("platform_links").select("platform_id").eq("kind", "tenant").eq("local_id", tenantId).maybeSingle();
    if (error) throw new Error(`platform_links: ${error.message}`);
    if (!link?.platform_id) return { value: "not_connected", seconds: CONNECTION_CACHE_SECONDS };
    const module = await client.getTenantModule(String(link.platform_id), TARGET);
    const asked = Number(module?.cache_seconds);
    const seconds = asked > 0 ? Math.min(asked, CONNECTION_CACHE_SECONDS) : CONNECTION_CACHE_SECONDS;
    if (module?.module_status !== "active") return { value: "not_connected", seconds };
    try {
      await client.getTenantLink(String(link.platform_id), TARGET);
      return { value: "connected", seconds };
    } catch (err) {
      if (err instanceof PlatformError && err.status === 404) return { value: "setting_up", seconds };
      throw err;
    }
  } catch (err) {
    const why = err instanceof PlatformError ? `${err.status} ${err.code}` : err instanceof Error ? err.message : String(err);
    console.error(`open-hr: HR connection check failed for school ${tenantId}: ${why}`);
    return { value: "unknown", seconds: UNKNOWN_CACHE_SECONDS };
  }
}

/** tenants.hr_requested_at as ISO (null: never asked); ok false when it couldn't be read. */
// deno-lint-ignore no-explicit-any
async function requestedAt(admin: any, tenantId: string): Promise<{ ok: boolean; at: string | null }> {
  const { data, error } = await admin.from("tenants").select("hr_requested_at").eq("id", tenantId).maybeSingle();
  if (error) {
    console.error("open-hr: could not read the HR request:", error.message);
    return { ok: false, at: null };
  }
  return { ok: true, at: data?.hr_requested_at ? iso(data.hr_requested_at) : null };
}

const iso = (v: unknown): string => {
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
};

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
const warmConnections: ConnectionCache = new Map();

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
    return handle(req, { admin, asUser, client: platformClient, connections: warmConnections });
  });
}
