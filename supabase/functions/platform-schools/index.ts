/**
 * Figbloom Schools in the Figbloom console (console.figbloom.org).
 *
 * The console's backend (bloomHR's /api) calls this server to server; no
 * browser ever does, so there is no CORS. It has no Supabase session to
 * send, so JWT verification is off and this function does its own check:
 *
 * - Header `x-platform-secret`, compared in constant time with the function
 *   secret PLATFORM_CONSOLE_SECRET. A missing or wrong header, or a secret
 *   that is unset or shorter than 32 characters, is 401. Nothing else is
 *   accepted.
 *
 * Actions (POST, JSON body):
 *
 * - {"action": "list"} -> {generated_at, schools: [row]}. A row is counts,
 *   statuses, one support contact (admin_email: the first school admin's
 *   email) and the school's admins (admins: [{email, name, role:
 *   "school_admin"}], every school admin who is not archived and has a real
 *   email, synthetic login addresses dropped, oldest first, at most 20), so
 *   the console can invite them to Figbloom HR (20261105610000): no other
 *   names of staff, none of learners, no records.
 * - {"action": "set_status", school_id, status: "suspended" | "active",
 *   reason, actor_email} -> {school: row}. Suspends through Schools' own
 *   mechanism (tenants.status, see 20261104600000_platform_console_schools.sql);
 *   "active" means reactivate: the school gets back the status it had before
 *   it was suspended (trial, overdue, ...), or active, and the row says which.
 *   The school's audit log says "Figbloom (via Figbloom console)" and the
 *   reason; actor_email is kept only where Figbloom staff alone can read it.
 *   Only an active, trial or overdue school can be suspended.
 *   400 bad input, 404 no such school, 409 already suspended / not suspended,
 *   422 a status that can't be set from here, a school (onboarding,
 *   setup_stalled) that can't be suspended from here, or a school whose
 *   organisation is suspended (reactivate the organisation). Suspending a
 *   school its organisation's suspension holds makes the suspension its own.
 *
 * Errors are always {"error": {"code": "snake_case", "message": "Sentence."}}.
 *
 * Deploy with JWT verification off (config.toml says so too):
 *   supabase secrets set PLATFORM_CONSOLE_SECRET=$(openssl rand -hex 32)
 *   supabase functions deploy platform-schools --no-verify-jwt
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { secretsMatch } from "../_shared/daraja.ts";

export const MIN_SECRET_LENGTH = 32;
export const MAX_REASON_LENGTH = 500;
/** The statuses the console may set; anything else Schools manages itself. */
export const SETTABLE_STATUSES = ["active", "suspended"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SchoolRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  status_reason: string | null;
  organization: { id: string; name: string } | null;
  created_at: string;
  admin_email: string | null;
  /** The school's admins with a real email, for the console's HR invitations (at most MAX_ADMINS). */
  admins: SchoolAdmin[];
  students: number;
  teachers: number;
  parents: number;
  last_activity_at: string | null;
}

export interface SchoolAdmin {
  email: string;
  name: string;
  role: "school_admin";
}

export const MAX_ADMINS = 20;

export interface Deps {
  // deno-lint-ignore no-explicit-any
  admin: any;
  /** PLATFORM_CONSOLE_SECRET. */
  secret: string | undefined;
  now?: () => Date;
}

export async function handle(req: Request, { admin, secret, now = () => new Date() }: Deps): Promise<Response> {
  if (!authorized(req, secret)) {
    return fail(401, "unauthorized", "The platform secret is missing or wrong.");
  }
  if (req.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return fail(400, "invalid_json", "The request body must be JSON."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail(400, "invalid_body", "The request body must be a JSON object.");
  }

  switch (body.action) {
    case "list": return await list(admin, now);
    case "set_status": return await setStatus(admin, body);
    default: return fail(400, "unknown_action", 'The action must be "list" or "set_status".');
  }
}

/** The secret check: a configured secret of at least 32 characters, and the same value in the header. */
export function authorized(req: Request, secret: string | undefined): boolean {
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    console.error(`platform-schools: PLATFORM_CONSOLE_SECRET is ${secret ? `shorter than ${MIN_SECRET_LENGTH} characters` : "not set"}; refusing every call`);
    return false;
  }
  const given = req.headers.get("x-platform-secret");
  if (!given) return false;
  return secretsMatch(given, secret);
}

// deno-lint-ignore no-explicit-any
async function list(admin: any, now: () => Date): Promise<Response> {
  const { data, error } = await admin.rpc("platform_console_schools", { p_school_id: null });
  if (error) return internal("list the schools", error);
  const schools = (Array.isArray(data) ? data : []).map(toRow);
  return json({ generated_at: isoSeconds(now()), schools });
}

// deno-lint-ignore no-explicit-any
async function setStatus(admin: any, body: Record<string, unknown>): Promise<Response> {
  const { school_id, status, reason, actor_email } = body;

  if (typeof school_id !== "string" || !UUID.test(school_id)) {
    return fail(400, "invalid_school_id", "school_id must be a school's ID (a UUID).");
  }
  if (typeof status !== "string" || status === "") {
    return fail(400, "invalid_status", 'status must be "suspended" or "active".');
  }
  if (!(SETTABLE_STATUSES as readonly string[]).includes(status)) {
    return fail(422, "status_not_settable", 'Only "suspended" and "active" can be set from the Figbloom console.');
  }
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    return fail(400, "invalid_reason", "reason must be text.");
  }
  const why = typeof reason === "string" ? reason.trim() : "";
  if (status === "suspended" && !why) {
    return fail(400, "reason_required", "Give a reason for suspending the school.");
  }
  if (why.length > MAX_REASON_LENGTH) {
    return fail(400, "reason_too_long", `The reason must be ${MAX_REASON_LENGTH} characters or fewer.`);
  }
  const actor = typeof actor_email === "string" ? actor_email.trim() : "";
  if (!actor || actor.length > 254 || !EMAIL.test(actor)) {
    return fail(400, "invalid_actor_email", "actor_email must be the email address of the person making the change.");
  }

  const { data, error } = await admin.rpc("platform_console_set_school_status", {
    p_school_id: school_id,
    p_status: status,
    p_reason: why || null,
    p_actor_email: actor,
  });
  if (error) return internal("change the school's status", error);

  switch (data?.outcome) {
    case "ok": return json({ school: toRow(data.school) });
    case "not_found": return fail(404, "school_not_found", "There is no school with that ID.");
    case "already": return fail(409, "already_in_status", "The school is already suspended.");
    case "not_suspended": return fail(409, "not_suspended", "The school isn't suspended, so there is nothing to reactivate.");
    case "not_settable": return fail(422, "status_not_settable", status === "suspended"
      ? "Only a school that is active, on trial or overdue can be suspended from the Figbloom console."
      : `"${status}" can't be set from the Figbloom console.`);
    // 20261104910000: a suspended (or rejected) organisation holds all its schools
    case "organization_suspended":
      return fail(422, "status_not_settable", "The school's organization is suspended. Reactivate the organization instead.");
    default: return internal("change the school's status", `unexpected answer ${JSON.stringify(data)}`);
  }
}

/** Only the contract's fields, whatever the database sends: nothing personal beyond admin_email and admins. */
// deno-lint-ignore no-explicit-any
export function toRow(r: any): SchoolRow {
  return {
    id: String(r.id),
    name: String(r.name),
    slug: String(r.slug),
    status: String(r.status),
    status_reason: r.status_reason ?? null,
    organization: r.organization ? { id: String(r.organization.id), name: String(r.organization.name) } : null,
    created_at: String(r.created_at),
    admin_email: r.admin_email ?? null,
    admins: toAdmins(r.admins),
    students: Number(r.students ?? 0),
    teachers: Number(r.teachers ?? 0),
    parents: Number(r.parents ?? 0),
    last_activity_at: r.last_activity_at ?? null,
  };
}

/** Each admin as {email, name, role}; a synthetic login address (or no address) is dropped, here too. */
function toAdmins(list: unknown): SchoolAdmin[] {
  if (!Array.isArray(list)) return [];
  const out: SchoolAdmin[] = [];
  for (const a of list) {
    const email = typeof a?.email === "string" ? a.email.trim().toLowerCase() : "";
    if (!EMAIL.test(email) || /\.(internal|invalid)$/.test(email)) continue;
    out.push({ email, name: typeof a?.name === "string" ? a.name : "", role: "school_admin" });
    if (out.length === MAX_ADMINS) break;
  }
  return out;
}

const isoSeconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

/** The database's own message can name tables and columns: it goes to the log, not the response. */
function internal(what: string, err: unknown): Response {
  const detail = err && typeof err === "object" && "message" in err ? (err as { message: unknown }).message : err;
  console.error(`platform-schools: could not ${what}:`, detail ?? "no detail");
  return fail(500, "internal_error", `Could not ${what}. Try again.`);
}

if (import.meta.main) {
  Deno.serve((req) => {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    return handle(req, { admin, secret: Deno.env.get("PLATFORM_CONSOLE_SECRET") });
  });
}
