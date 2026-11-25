import type { Role } from "../types";
import { apiLogout, apiMe, apiMfaStatus, type MfaStatus } from "./authApi";
import { apiFetchMyOrganizations, orgHomePath } from "./orgApi";
import { apiHomeDestination, apiSignInProfile, forgetApiSchools, viewOfMe } from "./sessionApi";

/**
 * What stands between a valid password and the console, on the API (FIG-1890). The API lets a signed-in session do very
 * little until three things are settled, in this order: a password an admin handed out is changed, two-step
 * verification is set up (enrol) or answered (challenge), and the person's school is known. This decides which of those
 * comes next, so the web, and later the phone, show the same steps.
 */

export type SignInStep = "change-password" | "mfa-enroll" | "mfa-challenge" | "done";

/** The next thing to do, from the two facts the server gives. A password change comes before two-step: it works without it. */
export function stepAfterSignIn(input: { mustChangePassword: boolean; mfa: Pick<MfaStatus, "next"> }): SignInStep {
  if (input.mustChangePassword) return "change-password";
  if (input.mfa.next === "enroll") return "mfa-enroll";
  if (input.mfa.next === "challenge") return "mfa-challenge";
  return "done";
}

/** Whether a role's console exists on the API build yet (every role, including the platform console P2). */
export function consoleOnApi(_role: Role): boolean {
  return true;
}

export type SignInOutcome =
  | { kind: "step"; step: Exclude<SignInStep, "done"> }
  /** Everything is settled: go to this address. */
  | { kind: "open"; path: string }
  /** Cannot go on; the session has been ended and this says why. */
  | { kind: "refused"; message: string };

async function refuse(message: string): Promise<SignInOutcome> {
  await apiLogout();
  forgetApiSchools();
  return { kind: "refused", message };
}

/**
 * Looks at the session as it stands and says what to do next. Safe to call again after each step, and on a page load
 * with a session already kept. A server or network failure is thrown for the screen to show; a session the server no
 * longer honours throws a 401 ApiError (the client has already forgotten it).
 */
export async function continueSignIn(): Promise<SignInOutcome> {
  const me = viewOfMe(await apiMe());
  const mfa = await apiMfaStatus();
  const step = stepAfterSignIn({ mustChangePassword: me.user.must_change_password, mfa });
  if (step !== "done") return { kind: "step", step };

  const profile = await apiSignInProfile();
  if (!profile) return refuse("Your account isn't fully set up yet. Contact the school office.");
  if (!consoleOnApi(profile.role)) return refuse("This console is not on the new system yet.");
  if (profile.role === "super_admin") {
    return { kind: "open", path: "/platform/tenants" };
  }
  if (profile.role === "org_admin") {
    // One organisation: its dashboard. Several: the picker. None (a membership with no organisation left): nothing to open.
    const path = orgHomePath(await apiFetchMyOrganizations());
    return path ? { kind: "open", path } : refuse("Your account is not linked to an organization any more. Contact Figbloom support.");
  }
  if (!profile.tenant_id) return refuse("Could not find your school. Contact Figbloom support.");
  const home = await apiHomeDestination(profile.tenant_id);
  if (!home.slug) return refuse("Could not find your school. Contact Figbloom support.");
  return { kind: "open", path: `/s/${encodeURIComponent(home.slug)}` };
}
