/**
 * What to tell families, given where the bus is now and what's already been
 * said this trip. Pure: no database, no network, so it's tested on its own
 * (plan.test.ts) and index.ts only fetches the inputs and acts on the output.
 */

export type Direction = "to_school" | "from_school";
export interface Pt { lat: number; lng: number }
export interface Stop extends Pt { id: string; name: string; sequence: number }

/** Distance milestones, largest first. Only the closest one crossed is announced. */
export const STEPS_M = [2000, 1000, 500] as const;
export const AT_STOP_M = 150;
export const OFF_ROUTE_M = 1500;
/**
 * Announce "running late" once the arrival time slips this far, then again
 * per further step -- and only when two Google checks in a row agree, since
 * a single live-traffic reading can swing by several minutes and back.
 */
export const LATE_STEP_MIN = 5;
/** Live-traffic time this much over the normal time reads as "heavy traffic". */
export const TRAFFIC_MIN = 3;

export function distanceM(a: Pt, b: Pt): number {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** packages/shared/src/fleet.ts's stopsInTravelOrder + routeProgress, kept in step with them. */
export function inTravelOrder<T extends { sequence: number }>(stops: T[], direction: Direction): T[] {
  const sorted = [...stops].sort((a, b) => a.sequence - b.sequence);
  return direction === "to_school" ? sorted.reverse() : sorted;
}

export function routeProgress(stops: Pt[], pos: Pt): { atIndex: number | null; nextIndex: number | null; offRoute: boolean } {
  if (!stops.length) return { atIndex: null, nextIndex: null, offRoute: false };
  let c = 0;
  for (let i = 1; i < stops.length; i++) if (distanceM(pos, stops[i]!) < distanceM(pos, stops[c]!)) c = i;
  const nearest = distanceM(pos, stops[c]!);
  if (nearest > OFF_ROUTE_M) return { atIndex: null, nextIndex: 0, offRoute: true };
  if (nearest <= AT_STOP_M) return { atIndex: c, nextIndex: c + 1 < stops.length ? c + 1 : null, offRoute: false };
  const next = stops[c + 1];
  const passed = next != null && distanceM(pos, next) < distanceM(stops[c]!, next);
  return { atIndex: null, nextIndex: passed ? c + 1 : c, offRoute: false };
}

/**
 * Metres left to stop `target`, following the route: to the next stop, then
 * stop to stop. Closer to the road distance than a straight line to the
 * target, which cuts corners the bus can't.
 */
export function remainingM(stops: Pt[], pos: Pt, nextIndex: number, target: number): number {
  let m = distanceM(pos, stops[nextIndex]!);
  for (let i = nextIndex; i < target; i++) m += distanceM(stops[i]!, stops[i + 1]!);
  return m;
}

export interface Eta { at: Date; trafficMin: number; estimated: boolean }

export interface StopState {
  /** dedupe_keys already announced for this stop this trip */
  said: Set<string>;
  baselineEta: Date | null;
  lateNotifiedMin: number;
  /** Lateness the previous check saw, waiting for this one to confirm it. */
  latePendingMin?: number | null;
}

export interface Update {
  stopId: string;
  kind: "trip_started" | "distance" | "arrived" | "delay";
  key: string;
  title: string;
  body: string;
  distanceM: number | null;
  etaAt: Date | null;
}

export interface StopPlan {
  stopId: string;
  index: number;
  distanceM: number;
  updates: Update[];
  /** Late minutes the newest delay update announced, when one is going out. */
  lateNotifiedMin: number | null;
  /** What to remember for the next check; undefined leaves it as it was (no fresh time this tick). */
  latePendingMin: number | null | undefined;
}

const fmtM = (m: number) => (m >= 1000 ? `${m / 1000} km` : `${m} m`);

export function fmtClock(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { hour: "numeric", minute: "2-digit", timeZone }).format(d);
}

function fmtIn(eta: Eta, now: Date): string {
  const min = Math.max(0, Math.round((eta.at.getTime() - now.getTime()) / 60_000));
  const span = min < 1 ? "under a minute" : `${min} min`;
  return eta.estimated ? `about ${span}` : span;
}

/**
 * The stops with riders that the bus hasn't passed yet, and what to announce
 * for each. `etas` only holds stops Google was asked about this tick.
 */
export function plan(input: {
  direction: Direction;
  stops: Stop[]; // travel order
  pos: Pt;
  riderStopIds: Set<string>;
  state: Map<string, StopState>;
  etas: Map<string, Eta>;
  /** The etas are a new Google check this tick, not a reused or estimated time. */
  fresh?: boolean;
  now: Date;
  timeZone: string;
}): StopPlan[] {
  const { direction, stops, pos, riderStopIds, state, etas, now, timeZone, fresh = false } = input;
  const { atIndex, nextIndex, offRoute } = routeProgress(stops, pos);
  const from = atIndex ?? nextIndex;
  if (from == null) return [];
  const out: StopPlan[] = [];

  for (let i = from; i < stops.length; i++) {
    const stop = stops[i]!;
    if (!riderStopIds.has(stop.id)) continue;
    const s = state.get(stop.id) ?? { said: new Set<string>(), baselineEta: null, lateNotifiedMin: 0 };
    const here = atIndex === i;
    const dist = here ? 0 : Math.round(remainingM(stops, pos, nextIndex!, i));
    const eta = etas.get(stop.id) ?? null;
    const when = eta ? ` · ${fmtClock(eta.at, timeZone)} (${fmtIn(eta, now)})` : "";
    const updates: Update[] = [];
    const add = (kind: Update["kind"], key: string, title: string, body: string) => {
      if (!s.said.has(key)) updates.push({ stopId: stop.id, kind, key, title, body, distanceM: here ? 0 : dist, etaAt: eta?.at ?? null });
    };
    const arrived = s.said.has("arrived");
    const milestonesSaid = STEPS_M.filter((m) => s.said.has(`m${m}`));
    const anySaid = s.said.size > 0;

    if (here) {
      add("arrived", "arrived", `Bus is at ${stop.name}`,
        direction === "to_school" ? "It's at the pickup point now." : "It's at the drop-off point now.");
    } else if (!arrived && !offRoute) {
      // The closest milestone crossed, unless a closer one was already said.
      const step = [...STEPS_M].reverse().find((m) => dist <= m);
      if (step != null && !milestonesSaid.some((m) => m <= step)) {
        add("distance", `m${step}`, `Bus is ${fmtM(step)} away`, `From ${stop.name}${when}`);
      } else if (!anySaid && step == null) {
        add("trip_started",
          "started",
          direction === "to_school" ? "Bus is on its way" : "Bus has left school",
          `Heading to ${stop.name}${when}`);
      }
    } else if (!arrived && offRoute && !anySaid) {
      // Still on the way to the route (from the depot, say): it has set off all the same.
      add("trip_started", "started", direction === "to_school" ? "Bus is on its way" : "Bus has left school", `Heading to ${stop.name}${when}`);
    }

    let lateNotified: number | null = null;
    let latePending: number | null | undefined = undefined;
    if (fresh && !here && !arrived && eta && !eta.estimated && s.baselineEta && dist > 500) {
      const late = Math.round((eta.at.getTime() - s.baselineEta.getTime()) / 60_000);
      const due = s.lateNotifiedMin + LATE_STEP_MIN;
      if (late < due) {
        latePending = null;
      } else if ((s.latePendingMin ?? -1) >= due) {
        // Confirmed by a second check: announce the smaller of the two, never overstate.
        const said = Math.min(late, s.latePendingMin!);
        const reason = eta.trafficMin >= TRAFFIC_MIN ? "Heavy traffic · " : "";
        add("delay", `late${said}`, "Bus is running late",
          `${reason}about ${said} min behind, now reaching ${stop.name} ${fmtClock(eta.at, timeZone)}`);
        lateNotified = said;
        latePending = null;
      } else {
        latePending = late;
      }
    }

    out.push({ stopId: stop.id, index: i, distanceM: dist, updates, lateNotifiedMin: lateNotified, latePendingMin: latePending });
  }
  return out;
}

/** "Amani's bus …" / "Amani and Zawadi's bus …" from a row's "Bus …" title. */
export function personalise(title: string, names: string[]): string {
  if (!names.length) return title;
  const who = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return title.replace(/^Bus\b/, `${who}'s bus`);
}
