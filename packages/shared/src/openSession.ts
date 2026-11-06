/**
 * Opening a phone app (FIG-1487). The app used to ask the server who is signed in and read the profile over
 * the network, and ANY failure ended on the sign-in screen: a parent with no signal was shown "Sign in" and
 * could never reach the fees and results the phone had saved for exactly that moment.
 *
 * "Cannot reach the server" is not "signed out". Only an answer from the server (or no login stored on the
 * phone) means signed out. With no signal the app opens from the identity it saved last time it could.
 *
 * The parts are passed in (Supabase and AsyncStorage on the phone) so the decision can be tested once here.
 */

/** Where the phone keeps who it last opened as, per person: `<key>.<profileId>`. Deleted on sign-out. */
export const SAVED_SESSION_KEY = "figbloom.session.v1";

/** How long to wait for the server before opening from what the phone saved. */
export const OPEN_WAIT_MS = 10_000;

/** What the server (or the network) answered when asked who is signed in. */
export type WhoIsSignedIn = { id: string } | "signed-out" | "no-signal";

/** What reading the profile gave. `unsupported`: a role this app has no home for. */
export type ProfileRead<S, X> = { session: S; extra: X } | "unsupported" | "no-signal";

export interface OpenParts<S, X> {
  /** Asks the server, which also checks the login is still good. */
  whoIsSignedIn(): Promise<WhoIsSignedIn>;
  /** From the login stored on the phone: no network, so it works when the server cannot be reached. */
  storedUserId(): Promise<string | null>;
  /** Reads the person's profile and school from the server. `extra` is what only a fresh read knows (a password to change). */
  readProfile(userId: string): Promise<ProfileRead<S, X>>;
  /** The identity saved the last time the server answered, or null if there is none (or it cannot be read). */
  readSaved(userId: string): Promise<S | null>;
  save(userId: string, session: S): Promise<void>;
}

export type Opened<S, X> =
  /** Nobody is signed in: show the sign-in screen. */
  | { status: "signed-out" }
  /** The server answered. */
  | { status: "online"; session: S; extra: X }
  /** The server could not be reached; opened from what the phone saved, which may be out of date. */
  | { status: "saved-copy"; session: S }
  /** Signed in on this phone but the server cannot be reached and nothing was saved yet. Not the sign-in screen: the person is still signed in. */
  | { status: "no-signal" };

/** A login the library answers "no" to for lack of a network, as opposed to the server refusing it. */
export function isNoSignalError(error: unknown): boolean {
  const e = error as { name?: unknown; status?: unknown } | null | undefined;
  return !!e && (e.name === "AuthRetryableFetchError" || e.status === 0);
}

function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

export async function openSession<S, X>(parts: OpenParts<S, X>, options: { waitMs?: number } = {}): Promise<Opened<S, X>> {
  const waitMs = options.waitMs ?? OPEN_WAIT_MS;

  const savedCopyFor = async (userId: string | null): Promise<Opened<S, X>> => {
    if (!userId) return { status: "signed-out" };
    const saved = await parts.readSaved(userId).catch(() => null);
    return saved ? { status: "saved-copy", session: saved } : { status: "no-signal" };
  };

  // A throw, or a server that does not answer in time, is a network problem, never "signed out".
  const who = await within(Promise.resolve().then(() => parts.whoIsSignedIn()), waitMs, "no-signal" as WhoIsSignedIn);
  if (who === "signed-out") return { status: "signed-out" };
  if (who === "no-signal") return savedCopyFor(await parts.storedUserId().catch(() => null));

  const profile = await within(Promise.resolve().then(() => parts.readProfile(who.id)), waitMs, "no-signal" as ProfileRead<S, X>);
  if (profile === "unsupported") return { status: "signed-out" };
  if (profile === "no-signal") return savedCopyFor(who.id);

  await parts.save(who.id, profile.session).catch(() => {});
  return { status: "online", session: profile.session, extra: profile.extra };
}
