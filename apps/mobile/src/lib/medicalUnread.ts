import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { fetchUnreadMedicalNotices } from "@figbloom/shared";

const POLL_MS = 60_000;

const readListeners = new Set<() => void>();

/** Called once the Health screen has marked a child's notices read, so the Home badge clears at once. */
export function notifyMedicalRead(): void {
  readListeners.forEach((l) => l());
}

/**
 * A guardian's unread sick bay notices across their children: the Health
 * card's badge. Polled, and refreshed when the app comes back to the
 * foreground and when a Health screen has read some.
 */
export function useMedicalUnread(profileId: string): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetchUnreadMedicalNotices(profileId)
        .then((n) => { if (alive) setCount(n); })
        .catch(() => {});
    };
    load();
    const poll = setInterval(load, POLL_MS);
    const appState = AppState.addEventListener("change", (state) => { if (state === "active") load(); });
    readListeners.add(load);
    return () => { alive = false; clearInterval(poll); appState.remove(); readListeners.delete(load); };
  }, [profileId]);
  return count;
}
