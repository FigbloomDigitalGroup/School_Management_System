/**
 * The words around adding and removing administrators: what the confirm box
 * says before an account is taken away, and what the toast says after. Kept
 * out of the screens so what a person is told about someone losing access is
 * one thing, tested, rather than a sentence in each of three places.
 */

import type { RemoveOrgAdminResult } from "./platformAdmin";

export interface Question {
  title: string;
  body: string;
  confirmLabel: string;
}

/** Before a school's administrator is removed (their profile and their login both go). */
export function removeSchoolAdminQuestion(name: string, schoolName: string, onlyOne: boolean): Question {
  return {
    title: `Remove ${name}?`,
    body: [
      `They lose access to ${schoolName} straight away and their login is deleted. This can't be undone.`,
      onlyOne
        ? " They are this school's only administrator: add another afterwards, or nobody there can manage it (an organization admin or Figbloom still can)."
        : "",
    ].join(""),
    confirmLabel: "Remove administrator",
  };
}

/** Before an organization admin is removed from one organization. */
export function removeOrgAdminQuestion(name: string, organizationName: string): Question {
  return {
    title: `Remove ${name}?`,
    body: `They lose access to ${organizationName} and all its schools straight away. If it is the only organization they administer, their login is deleted too. This can't be undone, but they can be invited again.`,
    confirmLabel: "Remove admin",
  };
}

/** The toast after an organization admin was removed: says whether their login went too, or why it stayed. */
export function orgAdminRemovedNote(result: Pick<RemoveOrgAdminResult, "removedAccount" | "warning">, name: string, organizationName: string): string {
  if (result.warning) return result.warning;
  return result.removedAccount
    ? `${name} removed, and their login deleted.`
    : `${name} removed from ${organizationName}. They also administer another organization, so their login stays.`;
}

/**
 * What to call a school administrator whose title was left blank: the first is
 * the head, the others are simply administrators. (The account's own default,
 * "Principal", only applies when nothing is sent.)
 */
export function schoolAdminTitle(typed: string, alreadyThere: number): string {
  return typed.trim() || (alreadyThere === 0 ? "Head teacher" : "Administrator");
}
