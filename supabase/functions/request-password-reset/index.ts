/**
 * Public, unauthenticated "Forgot password?" for accounts that sign in with
 * a school ID (learners, parents, teachers, drivers). Those accounts have no
 * mailbox -- their auth email is a synthetic
 * {id}@login.{school}.figbloom.internal -- so there is no link to send.
 * Instead this records a request in password_reset_requests, and the school
 * office (or, for a learner, their parent) sets a new temporary password
 * with reset-user-password, which closes the request.
 *
 * It answers exactly the same whether or not the ID exists, so it can't be
 * used to find out who is on a school's roll, and it is rate-limited the
 * same way resolve-login-id is (note_login_lookup, keyed by a hash of the
 * caller's address) so a script can't flood a school's request list.
 *
 * Deploy: supabase functions deploy request-password-reset --no-verify-jwt
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { CORS_HEADERS } from "../_shared/cors.ts";
import { canSignIn } from "../_shared/signInStatuses.ts";
import { callerKey, dbLimiter, type Limiter, overallKey, unlimited } from "../_shared/rateLimit.ts";

/** Requests one caller may make in the window. A person who forgot their password asks once or twice. */
const REQUEST_LIMIT = 10;
const REQUEST_WINDOW = "1 hour";
/** Requests at one school from everyone together (FIG-1336). */
const SCHOOL_REQUEST_LIMIT = 100;
const TOO_MANY_MESSAGE = "Too many attempts. Wait a while and try again, or ask the school office.";

/** Roles that sign in with a school ID. Admins with an email use the emailed link instead. */
const ID_ROLES = new Set(["student", "parent", "teacher", "driver", "staff", "school_admin"]);

interface Body {
  tenant_id: string;
  login_id: string;
}

export interface Deps {
  // deno-lint-ignore no-explicit-any
  admin: any;
  /** Records a request by this caller and says whether it is still within its allowance. */
  withinLimit: Limiter;
  /** The same for the school asked about, whoever asks. */
  withinSchoolLimit?: Limiter;
}

export async function handle(req: Request, { admin, withinLimit, withinSchoolLimit = unlimited }: Deps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!(await withinLimit(await callerKey(req, "request-password-reset")))) return json({ error: TOO_MANY_MESSAGE }, 429);

  let body: Partial<Body>;
  try { body = await req.json(); } catch { return json({ error: "Invalid request body" }, 400); }

  const tenantId = body.tenant_id?.trim();
  const loginId = body.login_id?.trim().toUpperCase();
  if (!tenantId || !loginId) return json({ error: "A school and an ID are both required." }, 400);
  if (!(await withinSchoolLimit(await overallKey("request-password-reset", tenantId)))) return json({ error: TOO_MANY_MESSAGE }, 429);

  // From here on every path answers the same { ok: true }: whether the ID
  // exists is exactly what this must not reveal.
  const { data: tenant } = await admin.from("tenants").select("id, status").eq("id", tenantId).maybeSingle();
  // trial and overdue schools sign in too, so their people can ask (FIG-1341)
  if (!tenant || !canSignIn(tenant.status)) return json({ ok: true });

  const { data: profile } = await admin.from("profiles")
    .select("id, role").eq("tenant_id", tenantId).eq("login_id", loginId).maybeSingle();
  if (!profile || !ID_ROLES.has(profile.role)) return json({ ok: true });

  // One open request per account (also a unique index): asking again just leaves the first one waiting.
  const { data: open } = await admin.from("password_reset_requests")
    .select("id").eq("profile_id", profile.id).is("resolved_at", null).maybeSingle();
  if (!open) {
    const { error } = await admin.from("password_reset_requests").insert({ tenant_id: tenantId, profile_id: profile.id });
    // 23505: a request landed between the check and the insert -- the same outcome
    if (error && (error as { code?: string }).code !== "23505") {
      console.error("request-password-reset: could not record the request:", error.message);
      return json({ error: "Could not send the request. Try again, or ask the school office." }, 500);
    }
  }

  return json({ ok: true });
}

if (import.meta.main) {
  Deno.serve((req) => {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    return handle(req, {
      admin,
      // Unlike sign-in, nothing urgent is lost by refusing here: if the limiter fails, refuse.
      withinLimit: dbLimiter(admin, "request-password-reset", REQUEST_LIMIT, REQUEST_WINDOW, { failClosed: true }),
      withinSchoolLimit: dbLimiter(admin, "request-password-reset", SCHOOL_REQUEST_LIMIT, REQUEST_WINDOW, { failClosed: true }),
    });
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
