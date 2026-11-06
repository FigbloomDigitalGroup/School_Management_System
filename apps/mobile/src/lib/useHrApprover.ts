import { useEffect, useState } from "react";
import { fetchHrLeaveAccess, showsLeaveToApprove } from "@figbloom/shared";

/**
 * Whether leave applications can wait on this person in Figbloom HR: the school's leave runs there
 * (hr_leave_access() is "available") and they are one of its approvers. False while the question is out, and when it
 * fails: the "Leave to approve" row is never listed on a guess, and it appears by itself once HR has answered.
 */
export function useHrApprover(profileId: string): boolean {
  const [approver, setApprover] = useState(false);
  useEffect(() => {
    let alive = true;
    setApprover(false);
    fetchHrLeaveAccess()
      .then((access) => { if (alive) setApprover(showsLeaveToApprove(access)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [profileId]);
  return approver;
}
