import { useEffect, useState } from "react";
import { fetchHrLeaveAccess, type HrLeaveAccess } from "@figbloom/shared";
import type { Session } from "./useSession";

/** The last answer per person, so moving between pages (each mounts its shell again) doesn't ask every time. */
const CACHE_MS = 60_000;
const cache = new Map<string, { access: HrLeaveAccess; at: number }>();
const NOT_STAFF: HrLeaveAccess = { status: "not_staff", approver: false };

/**
 * hr_leave_access() for the signed-in person (20261105800000): whether the school's leave is HR's (the leave page
 * applies through HR and the old form is hidden) and whether they get "Leave to approve". null while it's being
 * asked, so neither form flashes up first. An org admin acting for a school is never that school's staff.
 */
export function useHrLeaveAccess(session: Pick<Session, "profile" | "actingForTenant">): HrLeaveAccess | null {
  const key = session.profile && !session.actingForTenant ? session.profile.id : null;
  const hit = key ? cache.get(key) : undefined;
  const [access, setAccess] = useState<HrLeaveAccess | null>(hit && Date.now() - hit.at < CACHE_MS ? hit.access : null);

  useEffect(() => {
    if (!key) { setAccess(NOT_STAFF); return; }
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_MS) { setAccess(cached.access); return; }
    let alive = true;
    fetchHrLeaveAccess()
      .then((a) => { cache.set(key, { access: a, at: Date.now() }); if (alive) setAccess(a); })
      // unknown: the school's own form, as before
      .catch((err: unknown) => { console.error(err); if (alive) setAccess({ status: "off", approver: false }); });
    return () => { alive = false; };
  }, [key]);

  return access;
}
