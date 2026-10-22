import { useEffect, useRef, useState } from "react";
import type { BusOnRoute, RouteStop, TripPoint, TripRow } from "@figbloom/shared";
import { LiveRouteMap } from "./fleet/LiveRouteMap";

/** How fast the scrubber auto-advances while playing: one recorded fix per tick. */
const PLAY_TICK_MS = 500;

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * A trip's recorded path, replayed on the same live map everyone else sees a
 * bus on — real roads, numbered stops, the same bus icon — instead of a
 * separate bare-bones map, so a replay looks like the live view frozen in
 * time rather than a different feature. `selfPos` is what makes this work:
 * LiveRouteMap already uses it to show a driver's own GPS fix moving over
 * their bus marker, which is exactly "place this vehicle's icon here."
 */
export function TripReplayMap({ trip, path, stops }: { trip: TripRow; path: TripPoint[]; stops: RouteStop[] }) {
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => { setI(0); setPlaying(false); }, [path]);

  useEffect(() => {
    if (!playing) return;
    timer.current = window.setInterval(() => {
      setI((cur) => {
        if (cur >= path.length - 1) { setPlaying(false); return cur; }
        return cur + 1;
      });
    }, PLAY_TICK_MS);
    return () => { if (timer.current != null) window.clearInterval(timer.current); };
  }, [playing, path.length]);

  if (path.length === 0) {
    return (
      <div className="grid h-[280px] place-items-center rounded-lg border border-line bg-sunken px-6 text-center">
        <p className="max-w-[300px] text-[12.5px] leading-relaxed text-ink-muted">
          No location pings were recorded for this trip.
        </p>
      </div>
    );
  }

  const at = path[i]!;
  const bus: BusOnRoute = {
    vehicle: {
      id: trip.vehicle_id, tenant_id: trip.tenant_id, plate_number: trip.vehicle?.plate_number ?? "Vehicle",
      make_model: null, capacity: null, active: true, last_lat: at.lat, last_lng: at.lng,
      last_ping_at: at.recorded_at, speed_limit_kmh: 80, created_at: trip.started_at,
    },
    driverName: trip.driver?.full_name ?? null,
    driver: null,
    route: trip.route_id && trip.route ? { id: trip.route_id, name: trip.route.name } : null,
    stops,
    direction: trip.direction,
  };

  return (
    <div className="grid gap-2.5">
      <LiveRouteMap
        buses={[bus]}
        selectedId={bus.vehicle.id}
        selfPos={{ lat: at.lat, lng: at.lng }}
        showAllStops
        className="h-80 rounded-lg border border-line"
      />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => {
            if (!playing && i >= path.length - 1) setI(0);
            setPlaying((p) => !p);
          }}
          aria-label={playing ? "Pause replay" : "Play replay"}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink text-white"
        >
          {playing ? "❚❚" : "▶"}
        </button>
        <input
          type="range" min={0} max={Math.max(path.length - 1, 0)} value={i}
          onChange={(e) => { setPlaying(false); setI(Number(e.target.value)); }}
          aria-label="Scrub through the trip"
          className="flex-1"
        />
        <span className="w-16 shrink-0 text-right font-mono text-[12px] text-ink-muted">{i + 1}/{path.length}</span>
      </div>

      <div className="flex flex-wrap items-center gap-4 rounded-lg bg-page px-3.5 py-2.5 text-[12.5px]">
        <span><span className="text-ink-faint">Time</span> <span className="font-mono">{fmtTime(at.recorded_at)}</span></span>
        <span><span className="text-ink-faint">Speed</span> <span className="font-mono">{at.speed_kmh != null ? `${Math.round(at.speed_kmh)} km/h` : "—"}</span></span>
        <span><span className="text-ink-faint">Position</span> <span className="font-mono">{at.lat.toFixed(4)}, {at.lng.toFixed(4)}</span></span>
      </div>
    </div>
  );
}
