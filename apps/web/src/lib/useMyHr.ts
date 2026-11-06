import { useEffect, useState } from "react";
import { fetchMyHrStatus, type MyHrStatus } from "@figbloom/shared";
import type { Session } from "./useSession";

/** The last answer per person, so moving between pages (each mounts its shell again) doesn't ask every time. */
const CACHE_MS = 60_000;
const cache = new Map<string, { status: MyHrStatus; at: number }>();

/**
 * my_hr_status() for the signed-in person (20261105710000): whether the My HR page shows in their console.
 * null while it's being asked (the page and the sidebar item stay hidden until it's "available"). An org admin
 * acting for a school is never that school's staff, so they aren't asked.
 */
export function useMyHrStatus(session: Pick<Session, "profile" | "actingForTenant">): MyHrStatus | null {
  const key = session.profile && !session.actingForTenant ? session.profile.id : null;
  const hit = key ? cache.get(key) : undefined;
  const [status, setStatus] = useState<MyHrStatus | null>(hit && Date.now() - hit.at < CACHE_MS ? hit.status : null);

  useEffect(() => {
    if (!key) { setStatus("not_staff"); return; }
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) { setStatus(cached.status); return; }
    let alive = true;
    fetchMyHrStatus()
      .then((s) => { cache.set(key, { status: s, at: Date.now() }); if (alive) setStatus(s); })
      .catch((err: unknown) => { console.error(err); if (alive) setStatus("off"); });
    return () => { alive = false; };
  }, [key]);

  return status;
}
