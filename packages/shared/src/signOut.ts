import type { WriteQueue } from "./queue";

/**
 * Signing out of a phone app (FIG-1489). Ending the login is not enough: the phone's notification token
 * stays on the person's account (so the school keeps sending their fee and result notices to whoever holds
 * the phone next), and their cached data and unsent writes stay in the phone's storage.
 *
 * The parts are passed in because they differ per app (Firebase and AsyncStorage on the phone, nothing on
 * the web), so the order of the steps can be tested here once.
 */
export interface SignOutParts {
  /** Who is signed in, read from the stored login (see userIdFromStoredLogin). Null when nobody is (or it cannot be read). */
  userId(): Promise<string | null>;
  queue: Pick<WriteQueue, "flush" | "unsentFor" | "forgetUser">;
  /** Takes this phone's notification token off the person's account. Needs the login, so it runs first. */
  forgetDevice(): Promise<void>;
  /** Deletes the cached copy of family and learner data. */
  forgetCachedData(): Promise<void>;
  /** Ends the login on this phone. */
  endSession(): Promise<void>;
}

export type SignOutResult = { done: true } | { done: false; unsent: number };

/**
 * The keys under which the login library keeps a session on a phone: `sb-<project>-auth-token`, and its
 * `-code-verifier`. The project part comes from the server address, so it is matched, not spelled out.
 */
export function isStoredLoginKey(key: string): boolean {
  return /^sb-.+-auth-token(-code-verifier)?$/.test(key);
}

/**
 * Who a stored login belongs to, read from what is on the phone with no network. Asking the library
 * (`getSession`) is not the same: with an expired access token and no signal it tries to refresh, and
 * stalls. Null when nothing is stored or it cannot be read.
 */
export function userIdFromStoredLogin(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const id = (JSON.parse(raw) as { user?: { id?: unknown } } | null)?.user?.id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * Ends the login on this phone even with no signal. The library tells the server first; when it cannot and
 * the short-lived access token has run out, it answers with an error and KEEPS the login, so a person
 * without signal could not sign out at all (and their data would be left readable). Then the stored login
 * is deleted by hand and the library asked again: with nothing stored it ends the session here and tells the
 * app, which is what moves the screen to the sign-in page.
 */
export async function endLoginEvenOffline(parts: {
  signOut(): Promise<{ error: unknown }>;
  removeStoredLogin(): Promise<void>;
}): Promise<void> {
  const { error } = await parts.signOut();
  if (!error) return;
  await parts.removeStoredLogin();
  await parts.signOut();
}

/** Each clean-up step gets this long, so a phone with no signal can always sign out. */
export const SIGN_OUT_STEP_MS = 8_000;

/** Runs `work`, and lets the sign-out carry on whether it succeeds, fails or takes longer than `ms`. */
function bestEffort(work: () => Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    Promise.resolve()
      .then(work)
      .catch(() => {})
      .finally(() => { clearTimeout(timer); resolve(); });
  });
}

/**
 * Order matters:
 *  1. Try to send what is waiting, while the login still works.
 *  2. If anything is still unsent, stop and say how many, unless `discardUnsent`: deleting a teacher's
 *     unsent register without asking would be worse than the leftover it cleans up.
 *  3. Remove this phone's token (the database only lets a person delete their own, so before the logout).
 *  4. End the login.
 *  5. Delete the cached data and this person's queued writes. After step 4, so a screen that was still
 *     loading cannot write the cache back once it is gone.
 * Steps 1, 3 and 5 never block the sign-out: no signal must not trap a person in the app.
 */
export async function signOutCleanly(
  parts: SignOutParts,
  options: { discardUnsent?: boolean; stepMs?: number } = {},
): Promise<SignOutResult> {
  const stepMs = options.stepMs ?? SIGN_OUT_STEP_MS;
  const userId = await parts.userId().catch(() => null);

  if (userId) {
    await bestEffort(() => parts.queue.flush(), stepMs);
    let unsent = 0;
    await bestEffort(async () => { unsent = (await parts.queue.unsentFor(userId)).length; }, stepMs);
    if (unsent > 0 && !options.discardUnsent) return { done: false, unsent };
    await bestEffort(() => parts.forgetDevice(), stepMs);
  }

  await parts.endSession();

  await bestEffort(() => parts.forgetCachedData(), stepMs);
  if (userId) await bestEffort(() => parts.queue.forgetUser(userId), stepMs);
  return { done: true };
}

/** The question to ask before throwing unsent work away. Plain words: the person reading it is a parent, a driver or a teacher. */
export function unsentWarning(unsent: number): { title: string; message: string; stay: string; leave: string } {
  const one = unsent === 1;
  return {
    title: "Not sent yet",
    message:
      `${unsent} ${one ? "item" : "items"} saved on this phone ${one ? "has" : "have"} not reached the school yet. ` +
      `If you sign out now, ${one ? "it" : "they"} will be lost. ` +
      `Stay signed in and connect to the internet so ${one ? "it" : "they"} can be sent.`,
    stay: "Stay signed in",
    leave: `Sign out and lose ${one ? "it" : "them"}`,
  };
}
