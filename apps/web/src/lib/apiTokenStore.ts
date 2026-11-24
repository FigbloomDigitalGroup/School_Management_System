import { isStoredSession, type StoredSession, type TokenStore } from "@figbloom/shared";

/**
 * Where the browser keeps the API session (FIG-1890): localStorage, so a reload or a second tab stays signed in, and the
 * `storage` event so a sign-out in one tab signs the others out too. Where localStorage is blocked (some private
 * windows) it falls back to this page only: the person signs in again on the next load, nothing breaks.
 *
 * The token is a bearer token: anything that can run script on this page can read it. That is the reason the app loads
 * no third-party script, and the reason the API gives sessions a short life (8 h, 15 min idle for staff).
 */
export const API_SESSION_KEY = "figbloom.api.session";

export function createWebTokenStore(): TokenStore {
  const listeners = new Set<() => void>();
  let fallback: StoredSession | null = null;
  let storageWorks = true;

  const notify = () => { for (const l of [...listeners]) l(); };

  function read(): StoredSession | null {
    if (storageWorks) {
      try {
        const raw = window.localStorage.getItem(API_SESSION_KEY);
        if (!raw) return null;
        const v: unknown = JSON.parse(raw);
        return isStoredSession(v) ? v : null;
      } catch (err) {
        // Blocked storage throws; a value we did not write does not parse. The first means use memory from now on.
        if (err instanceof SyntaxError) return null;
        storageWorks = false;
      }
    }
    return fallback;
  }

  function write(value: StoredSession | null): void {
    if (storageWorks) {
      try {
        if (value) window.localStorage.setItem(API_SESSION_KEY, JSON.stringify(value));
        else window.localStorage.removeItem(API_SESSION_KEY);
        return;
      } catch {
        storageWorks = false;
      }
    }
    fallback = value;
  }

  // Another tab signed in or out. (The event never fires in the tab that wrote.)
  window.addEventListener("storage", (e) => {
    if (e.key === API_SESSION_KEY || e.key === null) notify();
  });

  return {
    get: read,
    set(session) { write(session); notify(); },
    clear() { if (read() === null) return; write(null); notify(); },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
