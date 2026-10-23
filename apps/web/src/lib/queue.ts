import { useEffect } from "react";
import { WriteQueue, sendQueuedWrite } from "@figbloom/shared";

/** Web queue: localStorage behind the shared WriteQueue. */
export const queue = new WriteQueue(window.localStorage, sendQueuedWrite);

/** Try to drain whenever the browser says we are back. */
window.addEventListener("online", () => { void queue.flush().catch(() => {}); });

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
