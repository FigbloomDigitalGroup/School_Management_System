import { useEffect, useState } from "react";
import { fetchRunningLiveClasses, subscribeLiveClasses, type LiveClass } from "@figbloom/shared";

/**
 * Live classes running now in these classes (all of the school's when omitted),
 * kept current over Realtime: the website's useRunningLiveClasses. A parent with
 * two children in one class lists it once.
 */
export function useRunningLiveClasses(tenantId: string, classIds?: string[]): LiveClass[] {
  const [running, setRunning] = useState<LiveClass[]>([]);
  const key = classIds ? [...new Set(classIds)].sort().join(",") : "*";
  useEffect(() => {
    let alive = true;
    const ids = key === "*" ? undefined : key ? key.split(",") : [];
    const load = () => { fetchRunningLiveClasses(ids).then((r) => { if (alive) setRunning(r); }).catch(() => {}); };
    load();
    const unsubscribe = subscribeLiveClasses(tenantId, load);
    return () => { alive = false; unsubscribe(); };
  }, [key, tenantId]);
  return running;
}
