import { useEffect, useState } from "react";
import { fetchChatUnreadCount, subscribeChatMessages } from "@figbloom/shared";

const POLL_MS = 20_000;

/** Fired by ChatThread after it marks a thread read, so the badge drops at once. */
export const CHAT_READ_EVENT = "figbloom:chat-read";

/**
 * Unread chat messages for the sidebar badge. Live over Realtime, and polled
 * as well (like the notice badges) so a dropped socket or a thread read in
 * another tab still settles the count.
 */
export function useChatUnread(tenantId: string): number {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetchChatUnreadCount()
        .then((n) => { if (alive) setUnread(n); })
        .catch(() => {});
    };
    load();
    const id = window.setInterval(load, POLL_MS);
    const unsubscribe = subscribeChatMessages({ tenantId }, load);
    window.addEventListener(CHAT_READ_EVENT, load);
    return () => { alive = false; window.clearInterval(id); unsubscribe(); window.removeEventListener(CHAT_READ_EVENT, load); };
  }, [tenantId]);
  return unread;
}
