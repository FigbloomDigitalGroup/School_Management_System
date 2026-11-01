import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { listVisits, subscribeVisits, type Visit } from "@figbloom/shared";

/** Midnight at the start of today, local time. */
function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Today's visits for this teacher, kept live: one recorded or moved along at
 * the gate or reception arrives here without a pull to refresh. RLS decides
 * whose visits a person gets, so a teacher only ever receives their own. The
 * list is read again whenever the app comes back to the foreground (which also
 * moves "today" on past midnight, and catches anything a dropped connection
 * missed). Newest first.
 */
export function useDayVisits(tenantId: string): { visits: Visit[] | null; error: string | null; reload: () => void } {
  const [visits, setVisits] = useState<Visit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let alive = true;
    const from = startOfToday();
    const until = new Date(from);
    until.setDate(until.getDate() + 1);
    listVisits(tenantId, from, until)
      .then((rows) => { if (alive) { setVisits(rows); setError(null); } })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : "Could not load your visitors."); });
    const off = subscribeVisits(tenantId, (v) => {
      const at = new Date(v.arrived_at).getTime();
      if (!alive || at < from.getTime() || at >= until.getTime()) return;
      setVisits((prev) => [v, ...(prev ?? []).filter((p) => p.id !== v.id)].sort((a, b) => b.arrived_at.localeCompare(a.arrived_at)));
    });
    return () => { alive = false; off(); };
  }, [tenantId, reloadKey]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => { if (state === "active") reload(); });
    return () => sub.remove();
  }, [reload]);

  return { visits, error, reload };
}
