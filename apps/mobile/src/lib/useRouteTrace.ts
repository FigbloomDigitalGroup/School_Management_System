import { useEffect, useMemo, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { endsAtRoute, fetchRouteTrace, type PathPoint, type RouteStop } from "@figbloom/shared";

const KEY = "figbloom.routeTrace.v1";
/** A road path changes only if the school moves a stop or the road itself changes: a day old is fresh enough. */
const FRESH_MS = 24 * 60 * 60_000;

interface Saved { points: PathPoint[]; savedAt: number }

/** What this launch has already worked out, and the lookups still running, so two children on one route cost one lookup. */
const known = new Map<string, Saved>();
const running = new Map<string, Promise<Saved | null>>();

async function readSaved(routeId: string): Promise<Saved | null> {
  const raw = await AsyncStorage.getItem(`${KEY}.${routeId}`).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw) as Saved; } catch { return null; } // a corrupt entry is as good as none
}

function lookUp(routeId: string, stops: PathPoint[]): Promise<Saved | null> {
  let lookup = running.get(routeId);
  if (!lookup) {
    lookup = fetchRouteTrace(routeId, stops)
      .then((points) => (points ? { points, savedAt: Date.now() } : null))
      .catch(() => null) // offline, or not allowed: the straight line stands
      .finally(() => { running.delete(routeId); });
    running.set(routeId, lookup);
  }
  return lookup;
}

/**
 * The road a route's buses drive, for the map's line (see packages/shared
 * routeTrace.ts for where it comes from), or null while there is none: no trip
 * has covered the route yet, or the phone has not heard back. What the phone
 * found last is shown at once and re-checked after a day. Pass the route's
 * stops (any order); they are also how a saved road that no longer fits (the
 * school moved a stop) is spotted and dropped.
 */
export function useRouteTrace(stops: RouteStop[]): { latitude: number; longitude: number }[] | null {
  const routeId = stops[0]?.route_id ?? null;
  const ordered = useMemo(() => [...stops].sort((a, b) => a.sequence - b.sequence), [stops]);
  const stopsKey = ordered.map((s) => `${s.lat},${s.lng}`).join("|");
  const [trace, setTrace] = useState<PathPoint[] | null>(() => (routeId ? known.get(routeId)?.points ?? null : null));

  useEffect(() => {
    if (!routeId || ordered.length < 2) { setTrace(null); return; }
    let alive = true;
    (async () => {
      let have = known.get(routeId) ?? (await readSaved(routeId));
      if (have && !endsAtRoute(have.points, ordered)) have = null;
      if (have) { known.set(routeId, have); if (alive) setTrace(have.points); }
      if (have && Date.now() - have.savedAt < FRESH_MS) return;

      const fresh = await lookUp(routeId, ordered);
      if (!fresh) return;
      known.set(routeId, fresh);
      void AsyncStorage.setItem(`${KEY}.${routeId}`, JSON.stringify(fresh)).catch(() => {});
      if (alive) setTrace(fresh.points);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by route and by where its stops are
  }, [routeId, stopsKey]);

  return useMemo(() => trace?.map((p) => ({ latitude: p.lat, longitude: p.lng })) ?? null, [trace]);
}
