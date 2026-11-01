/**
 * A database or Auth error, answered as a sentence (FIG-1342).
 *
 * The real message names tables, columns and constraints ('duplicate key
 * value violates unique constraint "profiles_login_id_unique"'), which is
 * for us, not for whoever is using the console. It goes to the function's
 * log; the person gets "Could not <what>. Try again."
 */
export function failure(fn: string, what: string, err: unknown): { error: string } {
  const detail = err && typeof err === "object" && "message" in err ? (err as { message: unknown }).message : err;
  console.error(`${fn}: could not ${what}:`, detail ?? "no detail");
  return { error: `Could not ${what}. Try again.` };
}
