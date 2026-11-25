import { apiClient } from "./client";
import { isApiError } from "./errors";
import type { components } from "./schema";

/**
 * The role the signed-in person has in the school this tab is on, and a learner's own record (the student console on the API,
 * docs/web-on-api/student-pages.md).
 *
 * Several shared reads are the same for a parent and a learner (results, report cards, issued items, activities) because the API
 * answers a learner on the same `/me/children/{learnerId}/...` paths with their own learner id. They differ only in where the
 * learner id comes from: a parent lists `GET /me/children`, a learner reads `GET /me/learner` (a parent's is a 403). The school
 * session sets the role when it finds the person's membership at the address, as it sets the active school, so a shared function
 * can tell which of the two it is serving without asking the server (and without an audited refusal).
 */

let activeRole: string | null = null;

/** Remembers the person's role in the school of this tab; null when there is none. Called by the school session. */
export function setApiActiveRole(role: string | null): void {
  activeRole = role;
  if (role !== "student") ownLearners.clear();
}

export function apiActiveRole(): string | null {
  return activeRole;
}

export type OwnLearner = components["schemas"]["StudentLearner"];

const ownLearners = new Map<string, Promise<OwnLearner>>();

/**
 * The signed-in learner's own record (`GET /me/learner`): the learner id every other learner read needs. Asked once for a page load
 * and kept; `fresh` asks again (the console's own load does, so a class change made by the office shows on the next visit).
 * A 404 is passed on: the login is not (or no longer) linked to a live learner.
 */
export function apiFetchOwnLearner(fresh = false): Promise<OwnLearner> {
  const c = apiClient();
  const tenantId = c.activeTenant();
  if (!tenantId) return Promise.reject(new Error("No active school selected."));
  const key = `${c.session()?.userId ?? ""}|${tenantId}`;
  const known = ownLearners.get(key);
  if (known && !fresh) return known;
  const p = c.get("/v1/tenants/{tenantId}/me/learner", { path: { tenantId }, tenantId }).then((r) => r.learner);
  ownLearners.set(key, p);
  p.catch(() => { if (ownLearners.get(key) === p) ownLearners.delete(key); });
  return p;
}

/** Forgets the kept record (sign-out). */
export function forgetOwnLearner(): void {
  ownLearners.clear();
}

/** True when the error says the login has no live learner behind it (a revoked login, an archived learner). */
export function isNoLearnerError(err: unknown): boolean {
  return isApiError(err) && err.code === "not_found";
}
