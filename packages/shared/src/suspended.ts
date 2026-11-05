import { EdgeError } from "./edge";
import { FIGBLOOM_SUPPORT_EMAIL } from "./legalLinks";
import { supabase } from "./supabase";

/**
 * What someone at a suspended school sees instead of a failed sign-in or an
 * empty screen. A suspended school's users are banned in Supabase Auth
 * (20261026080000_suspended_tenants_and_orgs), so sign-in fails with Auth's
 * `user_banned`, and a session that was already open sees nothing (my_tenant()
 * answers a no-match id). Every sign-in screen (web and both phone apps)
 * shows this one message.
 *
 * Never the reason: these screens are reachable by anyone who types an ID or
 * an email, and the reason is for the school's own console.
 */
export const SUSPENDED_SCHOOL_TITLE = "Your school's account is suspended.";
export const SUSPENDED_SCHOOL_BODY = "Please contact your school's administrator or Figbloom support.";
/** The support contact shown under the message; change it in legalLinks.ts. */
export const SUSPENDED_SCHOOL_CONTACT = FIGBLOOM_SUPPORT_EMAIL;
/** The whole message as one sentence pair, for places that show plain text. */
export const SUSPENDED_SCHOOL_MESSAGE = `${SUSPENDED_SCHOOL_TITLE} ${SUSPENDED_SCHOOL_BODY}`;

/** Supabase Auth's answer for a banned user, on sign-in and on a token refresh: code `user_banned`, "User is banned". */
export function isBannedAuthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code === "user_banned") return true;
  // older GoTrue versions send no code, only the message
  return typeof message === "string" && /\buser is banned\b/i.test(message);
}

/** resolve-login-id's answer for a school that is suspended (before it looks at the ID at all). */
export function isSchoolSuspendedError(err: unknown): boolean {
  return err instanceof EdgeError && err.code === "school_suspended";
}

/** Either way of learning, at sign-in, that the school is suspended. */
export function isSuspendedSignInError(err: unknown): boolean {
  return isBannedAuthError(err) || isSchoolSuspendedError(err);
}

/**
 * For an open session whose school row came back empty: is that because the
 * school is suspended? Asks my_school_suspended(), which answers only for the
 * caller's own school. A failed check answers false, so the app carries on as
 * it would have; it never invents a suspension.
 */
export async function mySchoolSuspended(): Promise<boolean> {
  try {
    const { data, error } = await supabase().rpc("my_school_suspended");
    if (error) return isBannedAuthError(error);
    return data === true;
  } catch (err) {
    return isBannedAuthError(err);
  }
}

/**
 * The check the apps run after loading the signed-in profile and its school:
 * only someone who belongs to a school (tenant_id set) and can't read it is
 * worth asking about. Anyone else answers false without a round trip.
 */
export async function sessionSchoolSuspended(profile: { tenant_id: string | null } | null, schoolVisible: boolean): Promise<boolean> {
  if (!profile?.tenant_id || schoolVisible) return false;
  return mySchoolSuspended();
}
