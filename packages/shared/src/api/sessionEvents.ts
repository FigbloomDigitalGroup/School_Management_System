import { apiClient } from "./client";

/**
 * "The login changed", for an API build (the counterpart of Supabase's onAuthStateChange). The API has no refresh and no
 * push, so a change is one of: this tab signed in or out, another tab did (the token store tells us), the token's own
 * expiry passed, or the server answered a call with 401 (the client clears the store, which tells us).
 */

export type ApiSessionEvent = "initial" | "signed-in" | "signed-out";

export interface ApiSessionChange {
  event: ApiSessionEvent;
  userId: string | null;
}

/** setTimeout's largest delay is about 24.8 days; the API's sessions last 8 hours, but a stored value is only trusted so far. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export function apiOnSessionChange(listener: (change: ApiSessionChange) => void): () => void {
  const c = apiClient();
  let stopped = false;
  let lastToken: string | null = c.store.get()?.token ?? null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const arm = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    const s = c.store.get();
    if (!s) return;
    const wait = Math.min(Math.max(Date.parse(s.expiresAt) - Date.now(), 0) + 50, MAX_TIMER_MS);
    // session() clears an expired token, which the store subscription below reports as signed out.
    timer = setTimeout(() => { c.session(); arm(); }, wait);
  };

  const unsubscribe = c.store.subscribe(() => {
    if (stopped) return;
    const s = c.store.get();
    const token = s?.token ?? null;
    if (token === lastToken) return;
    lastToken = token;
    arm();
    listener({ event: token ? "signed-in" : "signed-out", userId: s?.userId ?? null });
  });

  arm();
  // Like Supabase, report how things stand as soon as listening starts.
  void Promise.resolve().then(() => {
    if (!stopped) listener({ event: "initial", userId: c.session()?.userId ?? null });
  });

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}
