import { useEffect, useState } from "react";
import {
  arrangeRiders, fleetCapabilities, listActiveTrips, listRouteStops, listTripRiders, onApi, riderMarkedAt, startPolling, stopsInTravelOrder, stopsOfRiders,
  type ArrangedRider, type DriverOption, type Route, type Trip, type Vehicle,
} from "@figbloom/shared";
import { Avatar } from "../Avatar";
import { Badge, type Tone } from "../ui/Badge";

const POLL_MS = 15_000;

const PLACE: Record<ArrangedRider["place"], { label: string; tone: Tone }> = {
  on_bus: { label: "On the bus", tone: "ok" },
  waiting: { label: "To pick up", tone: "warn" },
  dropped: { label: "Dropped off", tone: "muted" },
  not_here: { label: "Not here", tone: "muted" },
  absent_from_class: { label: "Absent from class", tone: "muted" },
};

interface LiveTrip { trip: Trip; riders: ArrangedRider[]; stopName: Map<string, string> }

async function load(tenantId: string): Promise<LiveTrip[]> {
  const trips = await listActiveTrips(tenantId);
  return Promise.all(trips.map(async (trip) => {
    // The new system cannot list a route's stops: the stops are those of the children's manifest, already in travel order.
    const readStops = fleetCapabilities().routeStops && trip.route_id;
    const [riders, listed] = await Promise.all([listTripRiders(trip.id), readStops ? listRouteStops(trip.route_id!) : Promise.resolve(null)]);
    const ordered = listed ? stopsInTravelOrder(listed, trip.direction) : stopsOfRiders(riders, trip.direction);
    return { trip, riders: arrangeRiders(riders, ordered.map((s) => s.id)), stopName: new Map((listed ?? ordered).map((s) => [s.id, s.name])) };
  }));
}

/**
 * Who's on each bus on the road right now, for the office: the driver's own
 * list (trip_rider_list), read-only, refreshed every 15 seconds as the driver
 * marks children on and off. Nothing here changes a mark; that stays the
 * driver's job.
 */
export function LiveBusRiders({ tenantId, vehicles, routes, drivers }: {
  tenantId: string; vehicles: Vehicle[]; routes: Route[]; drivers: DriverOption[];
}) {
  const [trips, setTrips] = useState<LiveTrip[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openTrip, setOpenTrip] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () => load(tenantId)
      .then((t) => { if (alive) { setTrips(t); setError(null); } })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : String(err)); });
    // Supabase: as before. The new system pauses while the tab is hidden or unused, so a tab left open does not keep the session alive (poll.ts).
    if (onApi()) {
      const stop = startPolling(tick, { intervalMs: POLL_MS, immediate: true });
      return () => { alive = false; stop(); };
    }
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => { alive = false; window.clearInterval(id); };
  }, [tenantId]);

  if (error && !trips) return <p className="text-[12.5px] text-warn-ink">Could not load the children on the buses: {error}</p>;
  if (!trips) return <p className="text-[12.5px] text-ink-muted">Loading the buses on the road…</p>;
  if (!trips.length) return <p className="text-[12.5px] text-ink-muted">No bus is on a trip right now. When a driver starts one, their children show up here.</p>;

  return (
    <div className="grid gap-3">
      {trips.map(({ trip, riders, stopName }) => {
        const plate = vehicles.find((v) => v.id === trip.vehicle_id)?.plate_number ?? "Bus";
        const route = routes.find((r) => r.id === trip.route_id)?.name;
        const driver = drivers.find((d) => d.id === trip.driver_id)?.full_name;
        const count = (p: ArrangedRider["place"]) => riders.filter((r) => r.place === p).length;
        // the first bus is open; the rest open with a tap
        const open = openTrip ? openTrip === trip.id : trip.id === trips[0]!.trip.id;
        return (
          <div key={trip.id} className="overflow-hidden rounded-xl border border-line bg-white">
            <button
              type="button" onClick={() => setOpenTrip(open ? "none" : trip.id)} aria-expanded={open}
              className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left"
            >
              <span className="min-w-0">
                <span className="block font-mono text-[14px] font-semibold">{plate}</span>
                <span className="block text-[12px] text-ink-muted">
                  {[route, trip.direction === "to_school" ? "To school" : "From school", driver,
                    `since ${new Date(trip.started_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                <Badge tone="ok">{count("on_bus")} on the bus</Badge>
                <Badge tone="warn">{count("waiting")} to pick up</Badge>
                <Badge tone="muted">{count("dropped")} dropped off</Badge>
                {count("not_here") > 0 && <Badge tone="muted">{count("not_here")} not here</Badge>}
              </span>
            </button>
            {open && (riders.length ? (
              <ul className="grid border-t border-line-soft sm:grid-cols-2">
                {riders.map((r) => (
                  <li key={r.student_id} className={`flex items-center gap-2.5 border-b border-line-soft px-4 py-2 ${r.faded ? "bg-page" : ""}`}>
                    <Avatar id={r.student_id} name={r.full_name} url={r.avatar_url} size={30} />
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-[13px] font-medium ${r.struck ? "line-through" : ""} ${r.faded ? "text-ink-muted" : ""}`}>{r.full_name}</span>
                      <span className="block truncate text-[11.5px] text-ink-faint">{[(r.stop_id ? stopName.get(r.stop_id) : null) ?? "No stop set", riderMarkedAt(r)].filter(Boolean).join(" · ")}</span>
                    </span>
                    <Badge tone={PLACE[r.place].tone}>{PLACE[r.place].label}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="border-t border-line-soft px-4 py-3 text-[12.5px] text-ink-muted">Nobody is assigned to this route.</p>
            ))}
          </div>
        );
      })}
    </div>
  );
}
