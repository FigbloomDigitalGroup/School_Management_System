import { useEffect } from "react";
import { AppState } from "react-native";
import { queue } from "../storage";

/** How often to try again while something is waiting and the phone still believes it has signal. */
const RETRY_MS = 60_000;

/**
 * Ties the queue to the signed-in teacher and keeps it draining: once now (a
 * register held from an earlier session goes out as soon as the app opens, not
 * only when a screen that uses the queue is visited), whenever the app comes
 * back to the foreground, and every minute for the "has signal but the server
 * isn't answering" case that raises no event.
 */
export function useQueueSync(userId: string): void {
  // Set while rendering, not in the effect below: a screen's own flush-on-mount
  // effect runs before this component's, and must already see who is signed in.
  queue.setUser(userId);
  useEffect(() => {
    const drain = () => { void queue.flush().catch(() => {}); };
    drain();
    const sub = AppState.addEventListener("change", (state) => { if (state === "active") drain(); });
    const timer = setInterval(drain, RETRY_MS);
    return () => { sub.remove(); clearInterval(timer); };
  }, [userId]);
}
