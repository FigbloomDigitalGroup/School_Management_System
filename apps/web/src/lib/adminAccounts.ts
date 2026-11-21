/**
 * The words around adding and removing a school's administrators: what the
 * confirm box says before an account is taken away, and the title a new
 * administrator gets. Kept out of the screen so what a person is told about
 * someone losing access is one thing, and tested.
 */

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

/**
 * What to call a school administrator whose title was left blank: the first is
 * the head, the others are simply administrators. (The account's own default,
 * "Principal", only applies when nothing is sent.)
 */
export function schoolAdminTitle(typed: string, alreadyThere: number): string {
  return typed.trim() || (alreadyThere === 0 ? "Head teacher" : "Administrator");
}
