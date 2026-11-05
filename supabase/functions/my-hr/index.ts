/**
 * "My HR": a staff member's own payslips, leave, attendance and KPIs from Figbloom HR (Phase 2 step 1,
 * SCHOOLS_HR_PHASE2_CONTRACT.md section 3), and leave run by HR (step 2a, SCHOOLS_HR_LEAVE_CONTRACT.md section 3):
 * applying, cancelling, and approving inside Schools.
 *
 * POST {"route": ..., ...} with the person's own JWT.
 *
 *   Read only (My HR, MY_HR_ENABLED):
 *     "summary" | "payslips" | "leave" | "attendance" | "kpis"
 *     "payslip" {"payslip_id"}               GET payslips/<id>
 *     "attendance" {"from"?, "to"?}           YYYY-MM-DD, up to 93 days
 *   Leave run by HR (HR_LEAVE_ENABLED and HR on for the school: hr_leave_access(), 20261105800000):
 *     "leave_form"                            GET leave/form: types and their rules, balances, the approval chain
 *     "leave_applications"                    GET leave: balances and applications with their approval progress
 *     "leave_apply" {"type_id", "start_date", "end_date", "half_day"?, "reason", "document"?: {"name",
 *                    "content_type", "base64"}}  POST leave/applications (reason 10+ characters, document up to 3 MB)
 *     "leave_cancel" {"application_id"}       POST leave/applications/<id>/cancel
 *   Approving (the same, and an approver: the school's admins, staff holding the leave or fees area):
 *     "approvals"                             GET approvals: what waits on this person's HR user
 *     "approval_decide" {"application_id", "decision": "approve"|"decline", "comment"?}
 *                                             POST approvals/<id>/decide: done in HR as that HR user
 *
 *   1. The rule, asked as the caller: my_hr_status() (20261105710000) for the read-only routes, hr_leave_access()
 *      for the leave and approval routes. Neither takes arguments: the school and the person are the caller's own.
 *      My HR: 'not_staff' and 'off' are refused, 'not_linked' too; 'not_enabled' (a recent "no" from the platform)
 *      is asked again, HR being the authority. Leave: only 'available' goes on (the mode decides which leave form
 *      the school uses); the approval routes also need 'approver'.
 *   2. The school and the person: the caller's own profile (profiles.tenant_id, profiles.id), read with the service
 *      role from the verified JWT, and checked again (a staff role, not archived). Nothing in the body names a school
 *      or a person; any such field is ignored. Only the fields listed above are passed on.
 *   3. HR: <HR_MY_HR_URL>/<path> with Schools' platform token (_shared/hrApi.ts) and the headers x-figbloom-school /
 *      x-figbloom-person. A 401 is retried once with a new token. HR's JSON is passed on as it sent it.
 *   4. HR's refusals, as a sentence a person can read ({error, code}):
 *        404 not_linked, or 200 {"status":"pending_hr"}  -> "Your HR record isn't ready yet. Ask the school's HR administrator."
 *        409 approver_not_linked                         -> 409 approver_not_linked: "Open HR & Payroll once to connect your HR account."
 *        404 otherwise                                   -> 404 not_found
 *        422 leave_rules (HR's applicant checks)         -> 422 leave_rules, HR's sentence and its problems[] (one per rule)
 *        422 otherwise (a decline needs a comment)       -> 422 with HR's code and sentence
 *        400                                             -> 400 bad_request, with HR's sentence
 *        409 not_cancellable / already_decided           -> 409 with that code and HR's sentence (other 409: conflict)
 *        403 school_not_linked, 401 invalid_token        -> 502 hr_not_connected (HR doesn't accept Schools for this school)
 *        403 approver_no_access / not_your_approval      -> 403 with that code and HR's sentence (other 403: hr_forbidden)
 *        413 too_large                                   -> 413 document_too_large
 *        429                                             -> 429 rate_limited
 *        503 my_hr_off                                   -> 503 hr_off
 *        5xx, unreachable, timeout, no token             -> 503 hr_unavailable
 *
 * Nothing HR sends, and no document, is logged; HR audits every call.
 *
 * Function secrets: PLATFORM_CLIENT_ID, PLATFORM_CLIENT_SECRET, PLATFORM_TOKEN_URL, PLATFORM_API_URL (the same as
 * platform-sync and open-hr), and HR_MY_HR_URL: HR's base, e.g. https://hr.example/api/integrations/my-hr
 *
 * Deploy: supabase functions deploy my-hr   (verify_jwt = true)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { PlatformClient, platformConfigFromEnv } from "../_shared/platformClient.ts";
import { callHr, errorCode, hrMessage, hrUrlFromEnv, readJson } from "../_shared/hrApi.ts";

export { hrUrlFromEnv };

const VIEW_ROUTES = ["summary", "payslips", "payslip", "leave", "attendance", "kpis"] as const;
const LEAVE_ROUTES = ["leave_form", "leave_applications", "leave_apply", "leave_cancel"] as const;
const APPROVAL_ROUTES = ["approvals", "approval_decide"] as const;
export const ROUTES = [...VIEW_ROUTES, ...LEAVE_ROUTES, ...APPROVAL_ROUTES] as const;
export type MyHrRoute = typeof ROUTES[number];

const STAFF_ROLES = new Set(["teacher", "driver", "staff", "school_admin"]);
const HR_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_DAYS = 93;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 45_000;

/**
 * A leave document: up to 3 MB, passed to HR as base64. HR takes 5 MB, but its production sits behind Vercel's
 * ~4.5 MB request limit, and base64 adds a third.
 */
export const MAX_DOCUMENT_BYTES = 3 * 1024 * 1024;
const TOO_LARGE = "The document is larger than 3 MB. Choose a smaller file.";
/** The request itself: the document's base64 (a third larger) and the rest. */
const MAX_BODY_CHARS = Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4 + 16 * 1024;
export const DOCUMENT_TYPES = new Set([
  "application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
/** HR's rule for the reason (leave/form reason_min_length; my_hr_routes.js REASON_MIN / REASON_MAX). */
export const MIN_REASON = 10;
const MAX_REASON = 2000;
const MAX_COMMENT = 1000;
const MAX_LEAVE_DAYS = 366;

export const NOT_READY = "Your HR record isn't ready yet. Ask the school's HR administrator.";
export const CONNECT_ONCE = "Open HR & Payroll once to connect your HR account.";
const UNAVAILABLE = "HR & Payroll can't be reached right now. Try again in a minute.";

export interface Deps {
  // deno-lint-ignore no-explicit-any
  admin: any;
  /** A client acting as the caller (their JWT): my_hr_status and hr_leave_access need auth.uid(). */
  // deno-lint-ignore no-explicit-any
  asUser: any;
  /** null when the PLATFORM_* secrets aren't set. */
  client: PlatformClient | null;
  /** HR_MY_HR_URL, without a trailing slash; null when unset. */
  hrUrl: string | null;
  fetch?: typeof fetch;
}

interface Plan { path: string; method: "GET" | "POST"; body?: unknown; timeoutMs: number }

const isDate = (v: unknown): v is string => typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(v));
const daysBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

/** base64's decoded size, or null when it isn't base64. */
export function base64Bytes(b64: string): number | null {
  if (b64.length === 0 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

/** What to ask HR for this route, or the refusal of a malformed request. Only the fields HR needs are passed on. */
// deno-lint-ignore no-explicit-any
function plan(route: MyHrRoute, body: any): Plan | Response {
  const get = (path: string): Plan => ({ path, method: "GET", timeoutMs: TIMEOUT_MS });
  switch (route) {
    case "payslip": {
      const id = typeof body.payslip_id === "string" ? body.payslip_id.trim() : "";
      if (!HR_ID.test(id)) return fail(400, "invalid_payslip", "Say which payslip (payslip_id).");
      return get(`payslips/${encodeURIComponent(id)}`);
    }
    case "attendance": {
      const q = new URLSearchParams();
      for (const k of ["from", "to"] as const) {
        const v = body[k];
        if (v === undefined || v === null || v === "") continue;
        if (!isDate(v)) return fail(400, "invalid_dates", "Dates are YYYY-MM-DD.");
        q.set(k, v);
      }
      const from = q.get("from"), to = q.get("to");
      if (from && to && from > to) return fail(400, "invalid_dates", "The start date is after the end date.");
      if (from && to && daysBetween(from, to) > MAX_DAYS - 1) return fail(400, "invalid_dates", `Choose a range of ${MAX_DAYS} days or less.`);
      return get([...q].length ? `attendance?${q}` : "attendance");
    }
    case "leave_form":
      return get("leave/form");
    case "leave_applications":
      return get("leave");
    case "leave_apply": {
      const type = body.type_id;
      const typeId = typeof type === "number" && Number.isInteger(type) && type > 0 ? type
        : typeof type === "string" && HR_ID.test(type.trim()) ? type.trim() : null;
      if (typeId === null) return fail(400, "invalid_type", "Choose the type of leave.");
      const { start_date: start, end_date: end } = body;
      if (!isDate(start) || !isDate(end)) return fail(400, "invalid_dates", "Choose the first and last day (YYYY-MM-DD).");
      if (start > end) return fail(400, "invalid_dates", "The last day is before the first.");
      if (daysBetween(start, end) > MAX_LEAVE_DAYS - 1) return fail(400, "invalid_dates", `Choose ${MAX_LEAVE_DAYS} days or fewer.`);
      if (body.half_day !== undefined && body.half_day !== null && typeof body.half_day !== "boolean") {
        return fail(400, "invalid_half_day", "half_day is true or false.");
      }
      const halfDay = body.half_day === true;
      if (halfDay && start !== end) return fail(400, "invalid_half_day", "A half day is one day: the first and last day must be the same.");
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (reason.length < MIN_REASON) return fail(400, "invalid_reason", `Give a reason of at least ${MIN_REASON} characters.`);
      if (reason.length > MAX_REASON) return fail(400, "invalid_reason", `Keep the reason to ${MAX_REASON} characters.`);
      const out: Record<string, unknown> = { type_id: typeId, start_date: start, end_date: end, half_day: halfDay, reason };
      if (body.document !== undefined && body.document !== null) {
        const d = body.document;
        const name = typeof d?.name === "string" ? d.name.trim() : "";
        const contentType = typeof d?.content_type === "string" ? d.content_type.trim().toLowerCase() : "";
        const b64 = typeof d?.base64 === "string" ? d.base64 : "";
        if (!name || name.length > 200 || /[\\/]/.test(name) || [...name].some((c) => c.charCodeAt(0) < 32)) return fail(400, "invalid_document", "The document needs a file name.");
        if (!DOCUMENT_TYPES.has(contentType)) return fail(400, "invalid_document", "Attach a PDF, a photo (JPEG, PNG, WebP, HEIC) or a Word document.");
        const size = base64Bytes(b64);
        if (size === null || size === 0) return fail(400, "invalid_document", "The document couldn't be read. Choose it again.");
        if (size > MAX_DOCUMENT_BYTES) return fail(413, "document_too_large", TOO_LARGE);
        out.document = { name, content_type: contentType, base64: b64 };
      }
      return { path: "leave/applications", method: "POST", body: out, timeoutMs: out.document ? UPLOAD_TIMEOUT_MS : TIMEOUT_MS };
    }
    case "leave_cancel":
    case "approval_decide": {
      const id = typeof body.application_id === "string" ? body.application_id.trim() : "";
      if (!HR_ID.test(id)) return fail(400, "invalid_application", "Say which application (application_id).");
      if (route === "leave_cancel") return { path: `leave/applications/${encodeURIComponent(id)}/cancel`, method: "POST", body: {}, timeoutMs: TIMEOUT_MS };
      if (body.decision !== "approve" && body.decision !== "decline") return fail(400, "invalid_decision", "Approve or decline.");
      if (body.comment !== undefined && body.comment !== null && typeof body.comment !== "string") return fail(400, "invalid_comment", "The comment is text.");
      const comment = typeof body.comment === "string" ? body.comment.trim() : "";
      if (comment.length > MAX_COMMENT) return fail(400, "invalid_comment", `Keep the comment to ${MAX_COMMENT} characters.`);
      return {
        path: `approvals/${encodeURIComponent(id)}/decide`, method: "POST", timeoutMs: TIMEOUT_MS,
        body: comment ? { decision: body.decision, comment } : { decision: body.decision },
      };
    }
    case "approvals":
      return get("approvals");
    default:
      return get(route);
  }
}

/** The rule for this route, asked as the caller; a Response when refused. */
// deno-lint-ignore no-explicit-any
async function gate(asUser: any, route: MyHrRoute): Promise<Response | null> {
  if ((VIEW_ROUTES as readonly string[]).includes(route)) {
    const { data: status, error } = await asUser.rpc("my_hr_status");
    if (error) {
      console.error("my-hr: my_hr_status failed:", error.message);
      return fail(500, "status_failed", "Could not check access to My HR. Try again.");
    }
    switch (status) {
      case "not_staff": return fail(403, "forbidden", "My HR is for the school's staff.");
      case "off": return fail(403, "my_hr_off", "My HR isn't available yet.");
      case "not_linked": return fail(409, "school_not_linked", "This school isn't connected to Figbloom HR yet. Ask Figbloom.");
      case "available":
      case "not_enabled":
        return null;
      default:
        console.error("my-hr: unexpected my_hr_status:", status);
        return fail(500, "status_failed", "Could not check access to My HR. Try again.");
    }
  }
  const { data: access, error } = await asUser.rpc("hr_leave_access");
  if (error) {
    console.error("my-hr: hr_leave_access failed:", error.message);
    return fail(500, "status_failed", "Could not check access to leave. Try again.");
  }
  switch (access?.status) {
    case "not_staff": return fail(403, "forbidden", "Leave through HR is for the school's staff.");
    case "off":
    case "not_enabled":
      return fail(403, "hr_leave_off", "Your school doesn't handle leave in Figbloom HR. Use the school's leave form.");
    case "not_linked": return fail(409, "school_not_linked", "This school isn't connected to Figbloom HR yet. Ask Figbloom.");
    case "available":
      if ((APPROVAL_ROUTES as readonly string[]).includes(route) && access.approver !== true) {
        return fail(403, "not_approver", "Approving leave is for the head teacher, deputies, the bursar and the school's admins.");
      }
      return null;
    default:
      console.error("my-hr: unexpected hr_leave_access:", JSON.stringify(access));
      return fail(500, "status_failed", "Could not check access to leave. Try again.");
  }
}

export async function handle(req: Request, { admin, asUser, client, hrUrl, fetch: fetchFn = fetch }: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");
  if (!req.headers.get("Authorization")) return fail(401, "unauthorized", "Sign in first.");

  const { data: { user } } = await asUser.auth.getUser();
  if (!user) return fail(401, "unauthorized", "Sign in first.");

  const raw = await req.text();
  if (raw.length > MAX_BODY_CHARS) return fail(413, "document_too_large", TOO_LARGE);
  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = JSON.parse(raw); } catch { return fail(400, "invalid_json", "The body must be JSON."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail(400, "invalid_route", "Say what to show (route).");
  const route = body.route as MyHrRoute;
  if (!ROUTES.includes(route)) return fail(400, "invalid_route", "Say what to show (route).");
  const planned = plan(route, body);
  if (planned instanceof Response) return planned;

  // 1. the rule, as the caller
  const refused = await gate(asUser, route);
  if (refused) return refused;

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
    res = await callHr(fetchFn, client, `${hrUrl}/${planned.path}`, {
      method: planned.method, school: profile.tenant_id, person: profile.id, body: planned.body, timeoutMs: planned.timeoutMs,
    });
  } catch (err) {
    console.error(`my-hr: ${route} for school ${profile.tenant_id} failed: ${err instanceof Error ? err.message : String(err)}`);
    return fail(503, "hr_unavailable", UNAVAILABLE);
  }

  if (res.ok) {
    const data = await readJson(res);
    if (data === undefined || data === null || typeof data !== "object") {
      console.error(`my-hr: HR's ${route} answer for school ${profile.tenant_id} is not JSON`);
      return fail(502, "hr_bad_answer", UNAVAILABLE);
    }
    if ((data as { status?: unknown }).status === "pending_hr") return json({ status: "pending_hr", message: NOT_READY });
    return json(data, res.status === 201 ? 201 : 200);
  }

  // 4. refusals
  const answer = await readJson(res);
  const code = errorCode(answer);
  const said = hrMessage(answer);
  switch (true) {
    case code === "not_linked" || code === "pending_hr":
      return fail(404, code!, NOT_READY);
    case code === "approver_not_linked":
      return fail(409, "approver_not_linked", CONNECT_ONCE);
    case res.status === 404:
      return fail(404, "not_found", route === "payslip" ? "That payslip isn't available."
        : route === "leave_cancel" || route === "approval_decide" ? "That application isn't available any more." : "That isn't available in HR.");
    case res.status === 422 && code === "leave_rules":
      return json({ error: said ?? "HR's leave rules don't allow that.", code: "leave_rules", problems: problemsOf(answer) }, 422);
    case res.status === 422:
      return fail(422, code ?? "invalid", said ?? "HR couldn't take that. Check the details and try again.");
    case res.status === 400:
      return fail(400, "bad_request", said ?? "HR couldn't take that. Check the details and try again.");
    case res.status === 409 && (code === "not_cancellable" || code === "already_decided"):
      return fail(409, code!, said ?? (code === "not_cancellable" ? "This leave can't be cancelled any more." : "This application has already been decided."));
    case res.status === 409:
      return fail(409, "conflict", said ?? "That can't be done any more. Reload and try again.");
    case res.status === 401 || code === "school_not_linked" || code === "invalid_token":
      console.error(`my-hr: HR refused Schools for school ${profile.tenant_id}: ${res.status} ${code ?? ""}`);
      return fail(502, "hr_not_connected", "Figbloom HR isn't connected to this school yet. Ask Figbloom.");
    case res.status === 403 && code === "approver_no_access":
      return fail(403, "approver_no_access", said ?? "You don't have access to HR for this school. Ask your HR administrator.");
    case res.status === 403 && code === "not_your_approval":
      return fail(403, "not_your_approval", said ?? "You are not the approver for this step.");
    case res.status === 403:
      return fail(403, "hr_forbidden", said ?? "Figbloom HR didn't allow that.");
    case res.status === 413:
      return fail(413, "document_too_large", TOO_LARGE);
    case res.status === 429:
      return fail(429, "rate_limited", "You've opened My HR many times in the last few minutes. Wait a few minutes and try again.");
    case res.status === 503 && code === "my_hr_off":
      return fail(503, "hr_off", "My HR is switched off in Figbloom HR for now. Try again later.");
    default:
      console.error(`my-hr: HR answered ${res.status} ${code ?? ""} for ${route} at school ${profile.tenant_id}`);
      return fail(503, "hr_unavailable", UNAVAILABLE);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" } });

const fail = (status: number, code: string, error: string) => json({ error, code }, status);

/** HR's problems[] on a 422 leave_rules: one short sentence per rule that failed. */
function problemsOf(answer: unknown): string[] {
  // deno-lint-ignore no-explicit-any
  const list = (answer as any)?.error?.problems ?? (answer as any)?.problems;
  return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string" && p.length <= 300).slice(0, 20) : [];
}

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
