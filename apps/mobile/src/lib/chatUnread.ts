import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { fetchChatUnreadCount, subscribeChatMessages } from "@figbloom/shared";

const POLL_MS = 20_000;

const readListeners = new Set<() => void>();

/** Called after a thread has been marked read, so every badge drops at once. */
export function notifyChatRead(): void {
  readListeners.forEach((l) => l());
}

/**
 * Unread chat messages for a badge. Live over Realtime, and polled as well
 * (and refreshed when the app comes back to the foreground), so a dropped
 * socket or a thread read elsewhere still settles the count.
 */
export function useChatUnread(tenantId: string | null): number {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!tenantId) return;
    let alive = true;
    const load = () => {
      fetchChatUnreadCount()
        .then((n) => { if (alive) setUnread(n); })
        .catch(() => {});
    };
    load();
    const poll = setInterval(load, POLL_MS);
    const unsubscribe = subscribeChatMessages({ tenantId }, load);
    const appState = AppState.addEventListener("change", (state) => { if (state === "active") load(); });
    readListeners.add(load);
    return () => { alive = false; clearInterval(poll); unsubscribe(); appState.remove(); readListeners.delete(load); };
  }, [tenantId]);
  return unread;
}
