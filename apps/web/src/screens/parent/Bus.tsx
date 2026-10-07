import { useMemo } from "react";
import { PageHead } from "../../components/ConsoleShell";
import { DriverChip } from "../../components/fleet/DriverChip";
import { NotifyButton, UpdateFeed, useTodaysBusUpdates } from "../../components/fleet/BusUpdates";
import { Eta, LiveDot, LiveRouteMap, MapSheet, ROUTE_COLORS, busPosition, fmtAgo, fmtEta, useLiveBuses, useNow, type LatLng } from "../../components/fleet/LiveRouteMap";
import { Skeleton } from "../../components/ui/Skeleton";
import { EmptyState } from "../../components/ui/DataTable";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";
import { fmtDistance, isLive, myChildBus, routeProgress, stopsInTravelOrder, type BusOnRoute, type BusUpdate, type ChildInfo } from "@figbloom/shared";
import { useParentData } from "../../lib/parentContext";

/** A child and the bus they ride, if any, with their own stop on it. */
interface Ride { child: ChildInfo; bus: BusOnRoute | null; stopId: string | null; routeName: string | null }

async function loadRides(children: ChildInfo[]): Promise<Ride[]> {
  return Promise.all(children.map(async (child) => {
    const r = await myChildBus(child.id);
    return { child, bus: r?.bus ?? null, stopId: r?.stop?.id ?? null, routeName: r?.routeName ?? null };
  }));
}

/**
 * The family view: every one of this parent's children's buses on one map,
 * each in its own colour with that child's stop pinned, and a card per child
 * saying how long until their bus gets there — no switching between children.
 * Only their own children's buses: other buses' routes would show where other
 * families' children are picked up. RLS enforces that too, not just this page.
 */
export function ParentBus() {
  const { tenant } = useTenantSession();
  const { children } = useParentData();
  const key = children.map((c) => c.id).join(",");
  const { data, loading, error } = useAsync(() => loadRides(children), [key]);
  const one = children.length === 1 ? children[0]! : null;

  return (
    <>
      <PageHead
        eyebrow="Transport"
        title={one ? `${one.first}'s bus` : "Your children's buses"}
        blurb="Where each bus is right now and when it reaches your child's stop."
      />

      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load the buses: {error.message}
          </p>
        ) : loading || !data ? (
          <Skeleton className="h-[560px] rounded-xl" />
        ) : !data.some((r) => r.bus) ? (
          <EmptyState
            title={data.some((r) => r.routeName) ? "No bus assigned yet" : "Not on a bus route"}
            body={data.some((r) => r.routeName)
              ? "Your child's route doesn't have a vehicle assigned yet. Check back once the school has set one up."
              : "None of your children is linked to a transport route yet. Contact the school office if this seems wrong."}
          />
        ) : (
          <FamilyBusMap tenantId={tenant.id} rides={data} />
        )}
      </div>
    </>
  );
}

function FamilyBusMap({ tenantId, rides }: { tenantId: string; rides: Ride[] }) {
  // One entry per bus, even when siblings share it.
  const initial = useMemo(() => {
    const m = new Map<string, BusOnRoute>();
    for (const r of rides) if (r.bus && !m.has(r.bus.vehicle.id)) m.set(r.bus.vehicle.id, r.bus);
    return [...m.values()];
  }, [rides]);
  const buses = useLiveBuses(tenantId, initial);
  const colors = useMemo(() => new Map(initial.map((b, i) => [b.vehicle.id, ROUTE_COLORS[i % ROUTE_COLORS.length]!])), [initial]);
  const now = useNow();
  const updates = useTodaysBusUpdates(rides.map((r) => r.child.id));

  return (
    <LiveRouteMap
      buses={buses}
      selectedId={null}
      colorFor={(id) => colors.get(id) ?? ROUTE_COLORS[0]!}
      showAllStops
      highlightStopIds={rides.map((r) => r.stopId).filter((id): id is string => !!id)}
      className="h-[calc(100vh-210px)] min-h-[520px] rounded-xl border border-line"
    >
      <MapSheet>
        <div className="mb-2.5 flex justify-end empty:hidden"><NotifyButton /></div>
        <div className="grid gap-2.5">
          {rides.map((r) => {
            const bus = r.bus ? (buses.find((b) => b.vehicle.id === r.bus!.vehicle.id) ?? r.bus) : null;
            const mine = updates.filter((u) => u.student_ids.includes(r.child.id));
            return <ChildCard key={r.child.id} ride={r} bus={bus} color={bus ? colors.get(bus.vehicle.id)! : "#A3ABA5"} now={now} updates={mine} />;
          })}
        </div>
      </MapSheet>
    </LiveRouteMap>
  );
}

/** One child: their bus, and where it is relative to their stop. */
function ChildCard({ ride, bus, color, now, updates }: { ride: Ride; bus: BusOnRoute | null; color: string; now: number; updates: BusUpdate[] }) {
  const { child, stopId } = ride;
  if (!bus) {
    return (
      <div className="rounded-xl bg-page px-3.5 py-3">
        <div className="text-[13.5px] font-semibold">{child.first}</div>
        <div className="text-[12px] text-ink-muted">{ride.routeName ? `${ride.routeName} has no bus assigned yet.` : "Not on a bus route."}</div>
      </div>
    );
  }

  const live = isLive(bus.vehicle.last_ping_at, now);
  const pos = busPosition(bus);
  const ordered = stopsInTravelOrder(bus.stops, bus.direction);
  const progress = live && pos ? routeProgress(ordered, pos) : null;
  const mine = stopId ? ordered.findIndex((s) => s.id === stopId) : -1;
  const myStop = mine >= 0 ? ordered[mine]! : null;
  const next = progress?.nextIndex != null ? ordered[progress.nextIndex]! : null;

  return (
    <div className="rounded-xl border border-line-soft px-3.5 py-3" style={{ borderLeft: `4px solid ${color}` }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold">{child.first}</div>
          <div className="truncate text-[11.5px] text-ink-muted">
            <span className="font-mono font-semibold" style={{ color }}>{bus.vehicle.plate_number}</span>
            {bus.route ? ` · ${bus.route.name}` : ""}
          </div>
        </div>
        <LiveDot live={live} />
      </div>
      <div className="mt-2">
        <Status progress={progress} mine={mine} myStop={myStop} next={next} pos={pos} live={live} color={color} childName={child.first} />
      </div>
      {updates.length > 0 && (
        <div className="mt-2.5 border-t border-line-soft pt-2">
          <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">Today</div>
          <UpdateFeed updates={updates} limit={3} />
        </div>
      )}
      <div className="mt-2.5 border-t border-line-soft pt-2">
        <DriverChip bus={bus} size={30} />
      </div>
      {!live && <div className="mt-1 text-[11px] text-ink-faint">{fmtAgo(bus.vehicle.last_ping_at, now)}</div>}
    </div>
  );
}

function Status({ progress, mine, myStop, next, pos, live, color, childName }: {
  progress: ReturnType<typeof routeProgress> | null; mine: number;
  myStop: { name: string; lat: number; lng: number } | null; next: { name: string; lat: number; lng: number } | null;
  pos: LatLng | null; live: boolean; color: string; childName: string;
}) {
  if (!live || !progress) return <p className="text-[12.5px] text-ink-muted">Not on the road right now.</p>;
  if (progress.offRouteM != null) {
    return <p className="text-[12.5px] text-ink-muted">On the road, {fmtDistance(progress.offRouteM)} from its route. Arrival time shows once it joins.</p>;
  }
  if (myStop && progress.atIndex === mine) return <p className="text-[14px] font-bold" style={{ color }}>At {myStop.name} now</p>;
  if (myStop && progress.nextIndex != null && mine >= progress.nextIndex) {
    const before = mine - progress.nextIndex;
    return (
      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0 text-[12px] text-ink-muted">
          Arriving at <span className="font-semibold text-ink">{myStop.name}</span>
          <div>{before === 0 ? `${childName}'s stop is next` : `${before} stop${before === 1 ? "" : "s"} before`}</div>
        </div>
        <Eta from={pos} to={myStop}>{(eta) => <div className="shrink-0 text-[22px] font-bold leading-none" style={{ color }}>{fmtEta(eta)}</div>}</Eta>
      </div>
    );
  }
  if (myStop) return <p className="text-[12.5px] text-ink-muted">Has passed {myStop.name}{next ? `, heading to ${next.name}` : ""}.</p>;
  return next ? <p className="text-[12.5px] text-ink-muted">Heading to {next.name}.</p> : null;
}
