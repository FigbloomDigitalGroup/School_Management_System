import { useEffect, useState } from "react";
import { fetchEarlySignOutsForStudents, liveSignOutsByStudent, type EarlySignOut } from "@figbloom/shared";
import { useChildren } from "../data";

/**
 * Today's early sign-outs for the parent's children, by student id (FIG-1513 stage A, display only). Loaded on its own, not as part
 * of the cached parent data, so fees and results never wait on it. Fails soft: offline or any error gives an empty map and Home
 * reads as it did before. Voided sign-outs are left out.
 */
export function useChildSignOuts(): Map<string, EarlySignOut> {
  const ids = useChildren().map((c) => c.id).join(",");
  const [byChild, setByChild] = useState<Map<string, EarlySignOut>>(new Map());

  useEffect(() => {
    let alive = true;
    fetchEarlySignOutsForStudents(ids ? ids.split(",") : [])
      .then((rows) => { if (alive) setByChild(liveSignOutsByStudent(rows)); })
      .catch(() => { if (alive) setByChild(new Map()); });
    return () => { alive = false; };
  }, [ids]);

  return byChild;
}
