import { useEffect, useState } from "react";
import { fetchUnreadMedicalNotices } from "@figbloom/shared";

const POLL_MS = 60_000;
/** Fired by the parent's Health page once it has marked notices read, so the badge clears straight away. */
export const MEDICAL_READ_EVENT = "figbloom:medical-read";

/** A guardian's unread sick bay notices, across their children: the Health badge. */
export function useMedicalUnread(profileId: string): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => { fetchUnreadMedicalNotices(profileId).then((n) => { if (alive) setCount(n); }).catch(() => {}); };
    load();
    const id = window.setInterval(load, POLL_MS);
    window.addEventListener(MEDICAL_READ_EVENT, load);
    return () => { alive = false; window.clearInterval(id); window.removeEventListener(MEDICAL_READ_EVENT, load); };
  }, [profileId]);
  return count;
}
