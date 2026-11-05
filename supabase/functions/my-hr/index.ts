/**
 * "My HR" (Phase 2 step 1, view only): a staff member's own payslips, leave,
 * attendance and KPIs from Figbloom HR (SCHOOLS_HR_PHASE2_CONTRACT.md section 3).
 *
 * POST {"route": "summary" | "payslips" | "payslip_pdf" | "leave" | "attendance" | "kpis",
 *       "payslip_id"?: "<HR's id>" (payslip_pdf), "from"?, "to"?: "YYYY-MM-DD" (attendance)}
 * with the person's own JWT.
 *
 *   1. The rule, asked as the caller: my_hr_status() (20261105710000). It takes no arguments: the school and the
 *      person are the caller's own. 'not_staff' (not an active, non-archived staff profile of a school that isn't
 *      suspended) and 'off' (platform_settings MY_HR_ENABLED) are refused; 'not_linked' (the platform doesn't know
 *      the school) too. 'not_enabled' (the platform said HR isn't on for the school, in the last hour) is asked
 *      again: HR itself is the authority.
 *   2. The school and the person: the caller's own profile (profiles.tenant_id, profiles.id), read with the service
 *      role from the verified JWT, and checked again (a staff role, not archived). Nothing in the body names a school
 *      or a person; any such field is ignored.
 *   3. HR: GET <HR_MY_HR_URL>/<route> with Schools' platform token (_shared/platformClient.ts, the same client
 *      credentials as platform-sync) and the headers x-figbloom-school / x-figbloom-person. A 401 is retried once
 *      with a new token. A payslip PDF is streamed through as it comes; JSON is passed on as HR sent it.
 *   4. HR's refusals, as a sentence a person can read ({error, code}):
 *        404 not_linked, or 200 {"status":"pending_hr"}  -> "Your HR record isn't ready yet. Ask the school's HR administrator."
 *                                                          (pending_hr is a 200 {status, message}: the page shows the state)
 *        404 otherwise (a payslip that isn't theirs)     -> 404 not_found
 *        401 / 403                                       -> 502 hr_not_connected (HR doesn't accept Schools for this school)
 *        429                                             -> 429 rate_limited
 *        503 (MY_HR_API_ENABLED off in HR), 5xx, unreachable, timeout, no token -> 503 hr_unavailable
 *
 * Nothing HR sends is logged; HR audits every call.
 *
 * Function secrets: PLATFORM_CLIENT_ID, PLATFORM_CLIENT_SECRET, PLATFORM_TOKEN_URL, PLATFORM_API_URL (the same as
 * platform-sync and open-hr), and HR_MY_HR_URL: HR's base, e.g. https://hr.example/api/integrations/my-hr
 *
 * Deploy: supabase functions deploy my-hr   (verify_jwt = true)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { PlatformClient, platformConfigFromEnv } from "../_shared/platformClient.ts";

export const ROUTES = ["summary", "payslips", "payslip_pdf", "leave", "attendance", "kpis"] as const;
export type MyHrRoute = typeof ROUTES[number];

const STAFF_ROLES = new Set(["teacher", "driver", "staff", "school_admin"]);
const PAYSLIP_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMEOUT_MS = 15_000;

export const NOT_READY = "Your HR record isn't ready yet. Ask the school's HR administrator.";
const UNAVAILABLE = "HR & Payroll can't be reached right now. Try again in a minute.";

export interface Deps {
  // deno-lint-ignore no-explicit-any
  admin: any;
  /** A client acting as the caller (their JWT): my_hr_status needs auth.uid(). */
  // deno-lint-ignore no-explicit-any
  asUser: any;
  /** null when the PLATFORM_* secrets aren't set. */
  client: PlatformClient | null;
  /** HR_MY_HR_URL, without a trailing slash; null when unset. */
  hrUrl: string | null;
  fetch?: typeof fetch;
}

/** HR_MY_HR_URL as my-hr uses it: an https address without a trailing slash, or null. */
export function hrUrlFromEnv(env: { get(name: string): string | undefined } = Deno.env): string | null {
  const raw = env.get("HR_MY_HR_URL")?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return raw.replace(/\/+$/, "");
}

export async function handle(req: Request, { admin, asUser, client, hrUrl, fetch: fetchFn = fetch }: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");
  if (!req.headers.get("Authorization")) return fail(401, "unauthorized", "Sign in first.");

  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return fail(401, "unauthorized", "Sign in first.");

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return fail(400, "invalid_json", "The body must be JSON."); }
  const route = body?.route as MyHrRoute;
  if (!ROUTES.includes(route)) return fail(400, "invalid_route", "Say what to show (route).");
  let path: string = route;
  if (route === "payslip_pdf") {
    const id = typeof body.payslip_id === "string" ? body.payslip_id.trim() : "";
    if (!PAYSLIP_ID.test(id)) return fail(400, "invalid_payslip", "Say which payslip (payslip_id).");
    path = `payslips/${encodeURIComponent(id)}/pdf`;
  } else if (route === "attendance") {
    const q = new URLSearchParams();
    for (const k of ["from", "to"] as const) {
      const v = body[k];
      if (v === undefined || v === null || v === "") continue;
      if (typeof v !== "string" || !DATE.test(v) || Number.isNaN(Date.parse(v))) return fail(400, "invalid_dates", "Dates are YYYY-MM-DD.");
      q.set(k, v);
    }
    if (q.get("from") && q.get("to") && q.get("from")! > q.get("to")!) return fail(400, "invalid_dates", "The start date is after the end date.");
    if ([...q].length) path = `attendance?${q}`;
  }

  // 1. the rule, as the caller
  const { data: status, error: statusError } = await asUser.rpc("my_hr_status");
  if (statusError) {
    console.error("my-hr: my_hr_status failed:", statusError.message);
    return fail(500, "status_failed", "Could not check access to My HR. Try again.");
  }
  switch (status) {
    case "not_staff":
      return fail(403, "forbidden", "My HR is for the school's staff.");
    case "off":
      return fail(403, "my_hr_off", "My HR isn't available yet.");
    case "not_linked":
      return fail(409, "school_not_linked", "This school isn't connected to Figbloom HR yet. Ask Figbloom.");
    case "available":
    case "not_enabled":
      break;
    default:
      console.error("my-hr: unexpected my_hr_status:", status);
      return fail(500, "status_failed", "Could not check access to My HR. Try again.");
  }

  // 2. the school and the person: the caller's own, from the session only
  const { data: profile, error: profileError } = await admin
    .from("profiles").select("id, tenant_id, role, archived_at").eq("id", user.id).maybeSingle();
  if (profileError) {
    console.error("my-hr: profile read failed:", profileError.message);
    return fail(500, "status_failed", "Could not check access to My HR. Try again.");
  }
  if (!profile || !profile.tenant_id || !STAFF_ROLES.has(profile.role) || profile.archived_at) {
    return fail(403, "forbidden", "My HR is for the school's staff.");
  }

  if (!client || !hrUrl) return fail(503, "not_configured", "My HR can't reach Figbloom HR yet. Ask Figbloom.");

  // 3. HR
  let res: Response;
  try {
    res = await callHr(fetchFn, client, `${hrUrl}/${path}`, profile.tenant_id, profile.id, route === "payslip_pdf");
    if (res.status === 401) {
      // the token was revoked or rotated early: once more with a fresh one
      await res.body?.cancel();
      client.forgetToken();
      res = await callHr(fetchFn, client, `${hrUrl}/${path}`, profile.tenant_id, profile.id, route === "payslip_pdf");
    }
  } catch (err) {
    console.error(`my-hr: ${route} for school ${profile.tenant_id} failed: ${err instanceof Error ? err.message : String(err)}`);
    return fail(503, "hr_unavailable", UNAVAILABLE);
  }

  if (res.ok) {
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (route === "payslip_pdf" && type !== "application/json") {
      if (type !== "application/pdf") {
        await res.body?.cancel();
        console.error(`my-hr: HR's payslip answer for school ${profile.tenant_id} is not a PDF (${type || "no type"})`);
        return fail(502, "hr_bad_answer", UNAVAILABLE);
      }
      const headers: Record<string, string> = {
        ...CORS_HEADERS,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="payslip-${body.payslip_id.trim()}.pdf"`,
        "Cache-Control": "no-store",
      };
      const length = res.headers.get("content-length");
      if (length && /^\d+$/.test(length)) headers["Content-Length"] = length;
      return new Response(res.body, { status: 200, headers });
    }
    const data = await readJson(res);
    if (data === undefined || data === null || typeof data !== "object") {
      console.error(`my-hr: HR's ${route} answer for school ${profile.tenant_id} is not JSON`);
      return fail(502, "hr_bad_answer", UNAVAILABLE);
    }
    if ((data as { status?: unknown }).status === "pending_hr") return json({ status: "pending_hr", message: NOT_READY });
    if (route === "payslip_pdf") {
      console.error(`my-hr: HR's payslip answer for school ${profile.tenant_id} is JSON, not a PDF`);
      return fail(502, "hr_bad_answer", UNAVAILABLE);
    }
    return json(data);
  }

  // 4. refusals
  const code = errorCode(await readJson(res));
  switch (true) {
    case code === "not_linked" || code === "pending_hr":
      return fail(404, code!, NOT_READY);
    case res.status === 404:
      return fail(404, "not_found", route === "payslip_pdf" ? "That payslip isn't available." : "That isn't available in HR.");
    case res.status === 401 || res.status === 403:
      console.error(`my-hr: HR refused Schools for school ${profile.tenant_id}: ${res.status} ${code ?? ""}`);
      return fail(502, "hr_not_connected", "Figbloom HR isn't connected to this school yet. Ask Figbloom.");
    case res.status === 429:
      return fail(429, "rate_limited", "Too many requests to HR in the last minute. Wait a moment and try again.");
    default:
      console.error(`my-hr: HR answered ${res.status} ${code ?? ""} for ${route} at school ${profile.tenant_id}`);
      return fail(503, "hr_unavailable", res.status === 503 ? "My HR is switched off in Figbloom HR for now. Try again later." : UNAVAILABLE);
  }
}

async function callHr(fetchFn: typeof fetch, client: PlatformClient, url: string, school: string, person: string, pdf: boolean): Promise<Response> {
  const token = await client.accessToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetchFn(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: pdf ? "application/pdf" : "application/json",
        "x-figbloom-school": school,
        "x-figbloom-person": person,
      },
      signal: controller.signal,
      redirect: "error",
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

/** HR's error code: {error: {code}}, {code} or {error: "<code>"}. */
function errorCode(body: unknown): string | null {
  // deno-lint-ignore no-explicit-any
  const b = body as any;
  if (typeof b?.error?.code === "string") return b.error.code;
  if (typeof b?.code === "string") return b.code;
  if (typeof b?.status === "string" && b.status === "pending_hr") return "pending_hr";
  if (typeof b?.error === "string" && /^[a-z_]{1,40}$/.test(b.error)) return b.error;
  return null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" } });

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
    return handle(req, { admin, asUser, client: platformClient, hrUrl: hrUrlFromEnv() });
  });
}
