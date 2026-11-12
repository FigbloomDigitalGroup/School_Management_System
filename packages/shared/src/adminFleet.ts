import { isLive, listAlerts, listBusesOnRoutes, listTrips, type AlertRow, type BusOnRoute, type TripRow } from "./fleet";
import type { AlertKind, TripDirection, Vehicle } from "./types";

/**
 * The school's buses as the transport office and the principal look at them on the move: which are on the road and
 * where, what the database has flagged (speeding, off route, a breakdown, children still aboard), and the latest trips.
 * The web's Fleet screen reads the same things; adding vehicles and routes and assigning drivers stay there.
 */

/** How each alert the database raises reads. */
export const FLEET_ALERT_LABEL: Record<AlertKind, string> = { speed: "Speeding", geofence: "Off route", rider: "Children still on the bus", breakdown: "Bus broken down" };

export const TRIP_DIRECTION_LABEL: Record<TripDirection, string> = { to_school: "To school", from_school: "From school" };

/** How many recent trips are listed. */
export const RECENT_TRIPS = 20;

export interface FleetNow {
  /** Every active vehicle, with its route, stops, driver and the direction of a trip running now. */
  buses: BusOnRoute[];
  /** Alerts nobody has acknowledged yet, newest first. */
  alerts: AlertRow[];
  /** The latest trips across the fleet, newest first. */
  trips: TripRow[];
}

export async function fetchFleetNow(tenantId: string): Promise<FleetNow> {
  const [buses, alerts, trips] = await Promise.all([listBusesOnRoutes(tenantId), listAlerts(tenantId), listTrips(tenantId, undefined, RECENT_TRIPS)]);
  return { buses, alerts, trips };
}

/** A new position (the realtime feed) laid over the buses already read: the same bus, now somewhere else. */
export function withPosition(buses: BusOnRoute[], vehicle: Pick<Vehicle, "id" | "last_lat" | "last_lng" | "last_ping_at">): BusOnRoute[] {
  return buses.map((b) => (b.vehicle.id === vehicle.id
    ? { ...b, vehicle: { ...b.vehicle, last_lat: vehicle.last_lat, last_lng: vehicle.last_lng, last_ping_at: vehicle.last_ping_at } }
    : b));
}

/** The buses on the road first, then the rest, each group by number plate. */
export function busesLiveFirst(buses: BusOnRoute[], now: number = Date.now()): BusOnRoute[] {
  const live = (b: BusOnRoute) => (isLive(b.vehicle.last_ping_at, now) ? 0 : 1);
  return [...buses].sort((a, b) => live(a) - live(b) || a.vehicle.plate_number.localeCompare(b.vehicle.plate_number));
}

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (iso: string) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** "05 Nov, 14:05" on this device's clock. */
export function fleetDateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** Where a bus stands: on the road now (and how fresh its position is), when it was last seen, or never reported. */
export function busStatusLine(vehicle: Pick<Vehicle, "last_ping_at">, now: number = Date.now()): string {
  const ping = vehicle.last_ping_at;
  if (!ping) return "Not reporting yet";
  if (!isLive(ping, now)) return `Last seen ${fleetDateTime(ping)}`;
  const minutes = Math.floor((now - Date.parse(ping)) / 60_000);
  return `On the road now · ${minutes < 1 ? "updated just now" : `updated ${minutes} min ago`}`;
}

/** "To school · Route A · Joseph Kamau": what a trip was. */
export function tripLine(t: Pick<TripRow, "direction" | "route" | "driver">): string {
  return [TRIP_DIRECTION_LABEL[t.direction], t.route?.name ?? "No route", t.driver?.full_name ?? "A driver"].join(" · ");
}

/** "06:40 – 07:35", "06:40 – on the road" while it runs, and the start alone for one that was cancelled. */
export function tripTimes(t: Pick<TripRow, "started_at" | "ended_at" | "status">): string {
  if (t.status === "cancelled") return `${clock(t.started_at)} · Cancelled`;
  return `${clock(t.started_at)} – ${t.ended_at ? clock(t.ended_at) : "on the road"}`;
}
