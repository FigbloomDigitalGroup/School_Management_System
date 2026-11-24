import { apiClient } from "./client";
import { familyTenantId } from "./parentApi";

/**
 * Where each of a parent's children's buses is, from `GET .../me/transport` (the API side of the parent Bus page).
 *
 * The API answers a guardian with one row per linked child: their route, their own stop (a name only: no coordinates and no list of
 * the route's stops), the bus's number plate, the driver's first name, the running trip, and the bus's position while the trip runs
 * ("live" when under a minute old or so, "stale" after that, nothing once the child has got off). The OpenAPI file leaves the answer
 * untyped, so it is read defensively here (finding parent-2, docs/web-on-api/parent-pages.md).
 */

export type RideStatus = "waiting" | "boarded" | "dropped_off" | "not_boarded";

export interface FamilyRide {
  learnerId: string;
  learnerName: string;
  /** False when the child has no route. */
  assigned: boolean;
  route: { id: string; name: string } | null;
  stop: { id: string; name: string } | null;
  vehiclePlate: string | null;
  driverFirstName: string | null;
  trip: { id: string; direction: string; startedAt: string; status: RideStatus; statusAt: string | null } | null;
  location: { status: "live" | "stale" | "unavailable"; lat: number | null; lng: number | null; recordedAt: string | null; ageSeconds: number | null } | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const ref = (v: unknown): { id: string; name: string } | null => (isRecord(v) && str(v.id) ? { id: str(v.id)!, name: str(v.name) ?? "" } : null);
const STATUSES: readonly RideStatus[] = ["waiting", "boarded", "dropped_off", "not_boarded"];

/** Reads the answer of `GET .../me/transport`; a row without a learner is dropped. */
export function ridesFromTransport(body: unknown): FamilyRide[] {
  const rows = isRecord(body) && Array.isArray(body.children) ? body.children : [];
  const out: FamilyRide[] = [];
  for (const r of rows) {
    if (!isRecord(r) || !str(r.learner_id)) continue;
    const t = isRecord(r.active_trip) ? r.active_trip : null;
    const l = isRecord(r.location) ? r.location : null;
    const status = str(t?.learner_status);
    out.push({
      learnerId: str(r.learner_id)!,
      learnerName: str(r.learner_name) ?? "",
      assigned: r.assigned === true,
      route: ref(r.route),
      stop: ref(r.stop),
      vehiclePlate: str(r.vehicle_plate),
      driverFirstName: str(r.driver_first_name),
      trip: t && str(t.id)
        ? { id: str(t.id)!, direction: str(t.direction) ?? "", startedAt: str(t.started_at) ?? "", status: (STATUSES as readonly string[]).includes(status ?? "") ? (status as RideStatus) : "waiting", statusAt: str(t.learner_status_at) }
        : null,
      location: l
        ? { status: l.status === "live" || l.status === "stale" ? l.status : "unavailable", lat: num(l.lat), lng: num(l.lng), recordedAt: str(l.recorded_at), ageSeconds: num(l.age_seconds) }
        : null,
    });
  }
  return out;
}

export async function apiFetchFamilyRides(): Promise<FamilyRide[]> {
  const tenantId = familyTenantId();
  return ridesFromTransport(await apiClient().get("/v1/tenants/{tenantId}/me/transport", { path: { tenantId }, tenantId }));
}

/** "Boarded at 7:42", "Waiting to be picked up": what the trip says about this child, in words. */
export function rideStatusText(ride: FamilyRide): string {
  if (!ride.trip) return "The bus is not on a trip right now.";
  const at = ride.trip.statusAt ? new Date(ride.trip.statusAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
  switch (ride.trip.status) {
    case "boarded": return at ? `On the bus (got on at ${at}).` : "On the bus.";
    case "dropped_off": return at ? `Got off the bus at ${at}.` : "Got off the bus.";
    case "not_boarded": return at ? `Did not get on the bus (marked at ${at}).` : "Did not get on the bus.";
    default: return "On the trip, waiting to be picked up.";
  }
}
