import { useState } from "react";
import { fmtDistance, isLive, routeProgress, stopsInTravelOrder, type BusOnRoute } from "@figbloom/shared";
import { DriverChip } from "./DriverChip";
import { Eta, LiveDot, LiveRouteMap, MapSheet, ROUTE_COLORS, busPosition, fmtAgo, fmtEta, useLiveBuses, useNow } from "./LiveRouteMap";

const DIRECTION_LABEL = { to_school: "To school", from_school: "From school" } as const;

/**
 * Every bus in the school on one map — the admin Fleet page and the teacher
 * Buses page. Pick a bus in the sheet (or tap it on the map) to colour its
 * route and see who's driving, where it's heading next and how long it'll be.
 */
export function FleetLiveMap({ tenantId, buses: initial, className = "" }: { tenantId: string; buses: BusOnRoute[]; className?: string }) {
  const buses = useLiveBuses(tenantId, initial);
  const now = useNow();
  const liveCount = buses.filter((b) => isLive(b.vehicle.last_ping_at, now)).length;
  const [picked, setPicked] = useState<string | null>(null);
  // Default to the first bus on the road, so the map opens on something moving.
  const selectedId = picked ?? buses.find((b) => isLive(b.vehicle.last_ping_at, now))?.vehicle.id ?? buses[0]?.vehicle.id ?? null;
  const selected = buses.find((b) => b.vehicle.id === selectedId) ?? null;
  // The selected bus in the brand green, every other bus (marker and route) in its own colour.
  const colorFor = (id: string) => id === selectedId ? "#17402A" : ROUTE_COLORS[Math.max(0, buses.findIndex((b) => b.vehicle.id === id)) % ROUTE_COLORS.length]!;

  return (
    <LiveRouteMap buses={buses} selectedId={selectedId} onSelect={setPicked} colorFor={colorFor} className={className}>
      <MapSheet>
        <div className="flex items-baseline justify-between">
          <div className="text-[15px] font-semibold">{buses.length} {buses.length === 1 ? "bus" : "buses"}</div>
          <div className="text-[12px] text-ink-muted">{liveCount} on the road</div>
        </div>

        {buses.length === 0 ? (
          <p className="mt-2 text-[12.5px] text-ink-muted">No vehicles yet. Add one, give it a route and a driver, and it shows up here.</p>
        ) : (
          <>
            <div className="-mx-1 mt-3 flex gap-1.5 overflow-x-auto px-1 pb-1">
              {buses.map((b) => {
                const on = b.vehicle.id === selectedId;
                return (
                  <button
                    key={b.vehicle.id}
                    type="button"
                    onClick={() => setPicked(b.vehicle.id)}
                    className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 font-mono text-[11.5px] font-semibold transition-colors ${on ? "border-forest bg-forest text-white" : "border-line bg-white text-ink hover:border-forest"}`}
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: isLive(b.vehicle.last_ping_at, now) ? "#2EA45A" : "#A3ABA5" }} />
                    {b.vehicle.plate_number}
                  </button>
                );
              })}
            </div>
            {selected && <BusDetail bus={selected} now={now} />}
          </>
        )}
      </MapSheet>
    </LiveRouteMap>
  );
}

function BusDetail({ bus, now }: { bus: BusOnRoute; now: number }) {
  const live = isLive(bus.vehicle.last_ping_at, now);
  const pos = busPosition(bus);
  const ordered = stopsInTravelOrder(bus.stops, bus.direction);
  const progress = pos ? routeProgress(ordered, pos) : null;
  const next = live && progress?.nextIndex != null ? ordered[progress.nextIndex] : null;
  const at = live && progress?.atIndex != null ? ordered[progress.atIndex] : null;

  return (
    <div className="mt-3 border-t border-line-soft pt-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold">{bus.route?.name ?? "No route assigned"}</div>
          {bus.vehicle.make_model && <div className="truncate text-[12px] text-ink-muted">{bus.vehicle.make_model}</div>}
        </div>
        <LiveDot live={live} />
      </div>
      <div className="mt-2">
        <DriverChip bus={bus} size={32} />
      </div>

      {live && progress?.offRouteM != null ? (
        <div className="mt-3 rounded-xl bg-warn-bg px-3 py-2.5 text-[12.5px] text-warn-ink">
          <span className="font-semibold">Off route</span> · {fmtDistance(progress.offRouteM)} from the nearest stop
        </div>
      ) : live ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-page px-3 py-2.5">
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">{at ? "At stop" : "Next stop"}</div>
            <div className="mt-0.5 truncate text-[13px] font-semibold">{(at ?? next)?.name ?? "End of route"}</div>
            {bus.direction && <div className="text-[11px] text-ink-muted">{DIRECTION_LABEL[bus.direction]}</div>}
          </div>
          <div className="rounded-xl bg-page px-3 py-2.5">
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">Arrives in</div>
            {next && !at ? (
              <Eta from={pos} to={next}>{(eta) => <div className="mt-0.5 text-[18px] font-bold leading-tight">{fmtEta(eta)}</div>}</Eta>
            ) : (
              <div className="mt-0.5 text-[13px] font-semibold">{at ? "Now" : "—"}</div>
            )}
          </div>
        </div>
      ) : null}

      <div className="mt-2.5 text-[11.5px] text-ink-faint">{fmtAgo(bus.vehicle.last_ping_at, now)}</div>
    </div>
  );
}
