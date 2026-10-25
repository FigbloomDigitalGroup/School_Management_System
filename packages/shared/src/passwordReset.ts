import type { Role } from "./types";
import { ROLE_ID_PREFIX } from "./auth";
import { invokeEdge } from "./edge";
import { supabase } from "./supabase";

/**
 * Forgotten passwords for accounts that sign in with a school ID.
 *
 * Learners, parents, teachers and drivers have no mailbox (their sign-in
 * email is synthetic, see loginIdEmail), so "Forgot password?" can't email a
 * link. Instead the sign-in screen asks the school: requestPasswordReset
 * records a request, and the school office, an org admin, or (for a
 * learner) a parent sets a new temporary password with resetUserPassword.
 * The person signs in with it once and is asked to choose their own
 * (profiles.must_change_password, the same as a brand-new account).
 *
 * Admins and org admins sign in with a real email and use Supabase's own
 * emailed link (resetPasswordForEmail) instead.
 */

/** Same as the other sign-in lookups: say so rather than sit on "Sending…". */
const REQUEST_TIMEOUT_MS = 8000;
/** Setting a password is a real write; give it longer. */
const RESET_TIMEOUT_MS = 15000;

/**
 * "Forgot password?" for a school-ID account. Resolves the same whether or
 * not the ID exists (the function never says), so the caller always shows
 * passwordResetRequestedMessage afterwards.
 */
export async function requestPasswordReset(tenantId: string, loginId: string): Promise<void> {
  await invokeEdge<{ ok: true }>("request-password-reset", { tenant_id: tenantId, login_id: loginId.trim() }, { timeoutMs: REQUEST_TIMEOUT_MS });
}

/** What to tell someone after they asked. `role` is the portal they came through, not anything the server said. */
export function passwordResetRequestedMessage(role: Role | null | undefined): string {
  const office = "If that ID is right, the school office has been asked to set you a new temporary password.";
  if (role === "student") {
    return `${office} Your parent can also do it from their Figbloom app, under your name. You'll choose your own password when you next sign in.`;
  }
  return `${office} Ask them for it, then sign in and choose your own.`;
}

export interface PasswordResetResult {
  /** Shown once and handed over: it isn't stored anywhere it can be read back. */
  password: string;
  login_id: string | null;
  full_name: string;
}

/**
 * Sets a new temporary password for someone at a school. Allowed for the
 * school's own admins, org admins of the owning organization, Figbloom
 * staff, and a parent for their own child's learner login.
 */
export async function resetUserPassword(profileId: string): Promise<PasswordResetResult> {
  return invokeEdge<PasswordResetResult>("reset-user-password", { profile_id: profileId }, { timeoutMs: RESET_TIMEOUT_MS });
}

export interface PasswordResetRequest {
  id: string;
  profile_id: string;
  created_at: string;
  full_name: string;
  role: Role;
  login_id: string | null;
}

/** Open "Forgot password?" requests at a school, oldest first. Readable by the school's admins and its org admins. */
export async function fetchOpenPasswordResetRequests(tenantId: string): Promise<PasswordResetRequest[]> {
  const { data, error } = await supabase()
    .from("password_reset_requests")
    .select("id, profile_id, created_at, profiles!password_reset_requests_profile_id_fkey(full_name, role, login_id)")
    .eq("tenant_id", tenantId)
    .is("resolved_at", null)
    .order("created_at")
    .returns<{ id: string; profile_id: string; created_at: string; profiles: { full_name: string; role: Role; login_id: string | null } | null }[]>();
  if (error) throw error;
  return (data ?? []).flatMap((r) => r.profiles
    ? [{ id: r.id, profile_id: r.profile_id, created_at: r.created_at, full_name: r.profiles.full_name, role: r.profiles.role, login_id: r.profiles.login_id }]
    : []);
}

/**
 * Why an emailed reset link didn't work, read from the address it landed on.
 * Supabase sends people back with `error_code` in the hash (or the query,
 * depending on the flow) when the link is spent or out of date. Returns
 * null when the address carries no error.
 */
export function recoveryLinkProblem(hash: string, search: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const query = new URLSearchParams(search.replace(/^\?/, ""));
  const code = params.get("error_code") ?? query.get("error_code");
  const error = params.get("error") ?? query.get("error");
  if (!code && !error) return null;
  if (code === "otp_expired") {
    return "This reset link has expired or has already been used. Links work once, for about an hour. Ask for a new one below.";
  }
  return "This reset link didn't work. It may have been copied only partly, or already used. Ask for a new one below.";
}

/**
 * Which kind of account a typed login ID belongs to, from its prefix alone
 * ("ST-0001" is a learner): only used to word the "we've asked" message on
 * screens that serve several roles. Says nothing about whether the ID exists.
 */
export function roleFromLoginId(loginId: string): Role | null {
  const prefix = loginId.trim().toUpperCase().split("-")[0];
  const match = Object.entries(ROLE_ID_PREFIX).find(([, p]) => p === prefix);
  return match ? (match[0] as Role) : null;
}

/**
 * Which of these learners have their own login (students.profile_id), for a
 * parent's "Reset <child>'s app password". A learner the school never made
 * a login for has nothing to reset.
 */
export async function fetchChildLogins(studentIds: string[]): Promise<Map<string, string>> {
  if (studentIds.length === 0) return new Map();
  const { data, error } = await supabase()
    .from("students").select("id, profile_id").in("id", studentIds)
    .returns<{ id: string; profile_id: string | null }[]>();
  if (error) throw error;
  return new Map((data ?? []).flatMap((s) => (s.profile_id ? [[s.id, s.profile_id] as [string, string]] : [])));
}
