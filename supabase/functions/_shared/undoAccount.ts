/**
 * Takes a half-made login back out (FIG-1470).
 *
 * provision-student, provision-guardian and invite-admin make a login in steps (the Auth user, the profile, the links) and used to undo a
 * failed step with calls whose results nobody read, and to ignore a failed audit entry altogether, answering plain success with the
 * password. The audit entry is the record of who created which account, so an account without one is rolled back and the caller is
 * told it was not made.
 *
 * `extra` are the steps that undo the links this function made (the learner's profile_id, the guardian rows); they run first, then
 * the profile, then the Auth user. Every failed step is logged with its function's name; the names of the steps that failed come back, so
 * the caller can say a half-made account may be left (and give its login) instead of pretending it was cleaned up.
 */
// deno-lint-ignore no-explicit-any
type Admin = any;
type Step = { what: string; run: () => PromiseLike<{ error: { message?: string } | null }> };

export async function undoAccount(fn: string, admin: Admin, userId: string, extra: Step[] = []): Promise<string[]> {
  const failed: string[] = [];
  const steps: Step[] = [
    ...extra,
    { what: "remove the profile", run: () => admin.from("profiles").delete().eq("id", userId) },
    { what: "remove the login", run: () => admin.auth.admin.deleteUser(userId) },
  ];
  for (const step of steps) {
    try {
      const { error } = await step.run();
      if (error) { failed.push(step.what); console.error(`${fn}: rollback could not ${step.what}:`, error.message ?? "no detail"); }
    } catch (err) {
      failed.push(step.what);
      console.error(`${fn}: rollback could not ${step.what}:`, err instanceof Error ? err.message : err);
    }
  }
  return failed;
}

/** What to tell the caller when the audit entry (or a step before it) failed and the account was rolled back, or could not be. */
export function accountNotMade(fn: string, what: string, err: unknown, rollbackFailed: string[], loginId: string | undefined): { error: string } {
  const detail = err && typeof err === "object" && "message" in err ? (err as { message: unknown }).message : err;
  console.error(`${fn}: could not ${what}:`, detail ?? "no detail");
  if (rollbackFailed.length === 0) return { error: `Could not ${what}, so the account was not created. Try again.` };
  return {
    error: `Could not ${what}, and the account${loginId ? ` ${loginId}` : ""} could not be fully removed. Tell Figbloom support so it can be removed before you try again.`,
  };
}
