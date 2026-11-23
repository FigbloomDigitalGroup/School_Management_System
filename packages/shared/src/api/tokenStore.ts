/**
 * Where the API session's bearer token is kept. The API gives an opaque token with an expiry and nothing to refresh it
 * with, so the app keeps the pair and sends the token on every call. The place differs by app: the web uses
 * localStorage (apps/web/src/lib/apiTokenStore.ts, which also tells other tabs), the phone will use the keychain.
 */

export interface StoredSession {
  /** The opaque bearer token, returned once at sign-in. */
  token: string;
  /** When the server stops honouring it (ISO date-time). The server also ends it earlier after being idle. */
  expiresAt: string;
  /** Who it belongs to, kept so "who is signed in" needs no call. Absent in a session stored without it. */
  userId?: string;
}

export interface TokenStore {
  get(): StoredSession | null;
  set(session: StoredSession): void;
  clear(): void;
  /** Calls `listener` whenever the stored session changes, including from another tab where that applies. Returns the stop function. */
  subscribe(listener: () => void): () => void;
}

export function isStoredSession(v: unknown): v is StoredSession {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as StoredSession).token === "string" && (v as StoredSession).token.length > 0 &&
    typeof (v as StoredSession).expiresAt === "string" && Number.isFinite(Date.parse((v as StoredSession).expiresAt)) &&
    ((v as StoredSession).userId === undefined || typeof (v as StoredSession).userId === "string")
  );
}

/** A store that lives only as long as the page: tests, and anywhere nothing should be written to disk. */
export function createMemoryTokenStore(initial: StoredSession | null = null): TokenStore {
  let value = initial;
  const listeners = new Set<() => void>();
  const notify = () => { for (const l of [...listeners]) l(); };
  return {
    get: () => value,
    set(session) { value = session; notify(); },
    clear() { if (value === null) return; value = null; notify(); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
