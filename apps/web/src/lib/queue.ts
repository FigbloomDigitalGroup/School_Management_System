import { useEffect } from "react";
import { WriteQueue, sendQueuedWrite, supabase } from "@figbloom/shared";

/** Web queue: localStorage behind the shared WriteQueue. */
export const queue = new WriteQueue(window.localStorage, sendQueuedWrite);
// Until the app knows who is signed in, nothing is shown or sent: an unscoped queue sends whatever it holds (FIG-1403).
queue.setUser(null);

/** Try to drain whenever the browser says we are back. */
window.addEventListener("online", () => { void queue.flush().catch(() => {}); });

/**
 * Tells the queue who is signed in, for EVERY role, from the top of the app (FIG-1403). The 'online' listener above
 * flushes for whoever is on the page, and only a teacher's shell used to say who that was: for an admin, parent or driver
 * the queue was not scoped to anyone, so a register held by a teacher on the same browser was sent under the admin's login,
 * or refused and set aside for good when a parent or driver signed in. Signed out means nobody, so nothing is shown or sent.
 */
export function useQueueUser(): void {
  useEffect(() => {
    const client = supabase();
    const tell = (userId: string | undefined) => {
      queue.setUser(userId ?? null);
      // What this person held earlier goes out now; what anyone else held stays untouched.
      if (userId) void queue.flush().catch(() => {});
    };
    void client.auth.getSession().then(({ data }) => tell(data.session?.user.id));
    const { data } = client.auth.onAuthStateChange((_event, session) => tell(session?.user.id));
    return () => data.subscription.unsubscribe();
  }, []);
}

/** How often to try again while something is waiting and the browser still believes it has signal. */
const RETRY_MS = 60_000;

/**
 * Ties the queue to the signed-in user and keeps it draining: once now (a
 * register held from an earlier visit goes out as soon as the page loads), when
 * the browser comes back online, and every minute for the "online but the
 * server isn't answering" case that raises no event.
 */
export function useQueueSync(userId: string): void {
  // Set while rendering, not in the effect below: a screen's own flush-on-mount
  // effect runs before this component's, and must already see who is signed in.
  queue.setUser(userId);
  useEffect(() => {
    const drain = () => { void queue.flush().catch(() => {}); };
    drain();
    window.addEventListener("online", drain);
    const timer = window.setInterval(drain, RETRY_MS);
    return () => { window.removeEventListener("online", drain); window.clearInterval(timer); };
  }, [userId]);
}
