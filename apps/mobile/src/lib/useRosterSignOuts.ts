import { useEffect, useState } from "react";
import { fetchEarlySignOutsForStudents, liveSignOutsByStudent, type EarlySignOut } from "@figbloom/shared";

/**
 * Today's early sign-outs for the learners on the register (FIG-1513 stage A), by student id, for a read-only badge. A separate
 * read: the register's write path and offline queue do not depend on it. Fails soft: offline or any error gives an empty map and the
 * register behaves as it always did, without the badge.
 */
export function useRosterSignOuts(studentIds: string[]): Map<string, EarlySignOut> {
  const key = studentIds.join(",");
  const [byStudent, setByStudent] = useState<Map<string, EarlySignOut>>(new Map());

  useEffect(() => {
    if (!key) { setByStudent(new Map()); return; }
    let alive = true;
    fetchEarlySignOutsForStudents(key.split(","))
      .then((rows) => { if (alive) setByStudent(liveSignOutsByStudent(rows)); })
      .catch(() => { if (alive) setByStudent(new Map()); });
    return () => { alive = false; };
  }, [key]);

  return byStudent;
}
