import { useEffect, useState } from "react";
import { fetchHrLeaveAccess, type HrLeaveAccess } from "@figbloom/shared";

/**
 * What Figbloom HR says about leave for the signed-in person (hr_leave_access()): whether the school's leave runs
 * there, and whether they approve it. null while HR is being asked, so neither the school's own form nor HR's
 * flashes up first and no row is listed on a guess. When HR cannot be asked the answer is "off" (the school's own
 * form stays, nobody is offered approvals), as on the web.
 */
export function useHrLeaveAccess(profileId: string): HrLeaveAccess | null {
  const [access, setAccess] = useState<HrLeaveAccess | null>(null);
  useEffect(() => {
    let alive = true;
    setAccess(null);
    fetchHrLeaveAccess()
      .then((answer) => { if (alive) setAccess(answer); })
      .catch(() => { if (alive) setAccess({ status: "off", approver: false }); });
    return () => { alive = false; };
  }, [profileId]);
  return access;
}
