import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetchFamilyRides, apiFetchTransportNotifications, apiMarkTransportNotificationRead, parentCapabilities, rideStatusText, userMessage, type BusOnRoute, type FamilyRide, type FamilyTransportNotification } from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { LiveDot, LiveRouteMap, ROUTE_COLORS, fmtAgo, useNow } from "../../components/fleet/LiveRouteMap";
import { EmptyState } from "../../components/ui/DataTable";
import { Skeleton } from "../../components/ui/Skeleton";

/** How often the buses are asked for again while the page is open and visible. The API has no live feed, so this is a plain re-read. */
const REFRESH_MS = 15_000;

/** The rides, read now and again every REFRESH_MS while the tab is visible; a refresh that fails keeps what was shown. */
function useRides(): { rides: FamilyRide[] | null; error: string | null } {
  const [rides, setRides] = useState<FamilyRide[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const load = useCallback(async () => {
    try {
      const next = await apiFetchFamilyRides();
      if (!alive.current) return;
      setRides(next);
      setError(null);
    } catch (err) {
      if (alive.current) setError(userMessage(err));
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    void load();
    const id = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, REFRESH_MS);
    return () => { alive.current = false; window.clearInterval(id); };
  }, [load]);
  return { rides, error };
}

/** A bus with a position, as the shared map draws it. The API gives the position and the plate, not the route's stops. */
function busOf(ride: FamilyRide): BusOnRoute | null {
  const l = ride.location;
  if (!l || l.lat === null || l.lng === null) return null;
  return {
    vehicle: {
      id: ride.trip?.id ?? ride.learnerId, tenant_id: "", plate_number: ride.vehiclePlate ?? "Bus", make_model: null, capacity: null, active: true,
      last_lat: l.lat, last_lng: l.lng, last_ping_at: l.recordedAt, speed_limit_kmh: 0, created_at: "",
    },
    driverName: ride.driverFirstName, driver: null, route: ride.route, stops: [], direction: null,
  };
}

const firstName = (full: string) => full.split(" ")[0] || full;

/**
 * The family view of the buses on the new API: one card per child with their route, their own stop, the bus and its driver's first name,
 * what the running trip says about them, and where the bus is. The API sends no stop coordinates and no route line, so the map shows the
 * buses only, and there is no arrival time. Refreshed every 15 seconds (there is no live feed on the API).
 */
export function ApiParentBus() {
  const { rides, error } = useRides();
  const now = useNow();
  const buses = useMemo(() => (rides ?? []).map(busOf).filter((b): b is BusOnRoute => b !== null), [rides]);
  const colors = useMemo(() => new Map(buses.map((b, i) => [b.vehicle.id, ROUTE_COLORS[i % ROUTE_COLORS.length]!])), [buses]);
  const one = rides && rides.length === 1 ? rides[0]! : null;

  return (
    <>
      <PageHead
        eyebrow="Transport"
        title={one ? `${firstName(one.learnerName)}'s bus` : "Your children's buses"}
        blurb="Where each bus is right now. It updates by itself every few seconds while this page is open."
      />
      <div className="px-7 py-6">
        {error && !rides ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load the buses: {error}
          </p>
        ) : !rides ? (
          <Skeleton className="h-[420px] rounded-xl md:h-[480px]" />
        ) : rides.length === 0 ? (
          <EmptyState title="No child linked" body="This account is not yet linked to a learner. Contact the school office." />
        ) : !rides.some((r) => r.assigned) ? (
          <EmptyState title="Not on a bus route" body="None of your children is linked to a transport route yet. Contact the school office if this seems wrong." />
        ) : (
          <>
            {error && <p role="status" className="mb-3 text-[12px] text-warn-ink">Could not refresh just now: {error}. Showing what was last read.</p>}
            {buses.length > 0 && (
              <LiveRouteMap
                buses={buses}
                selectedId={null}
                colorFor={(id) => colors.get(id) ?? ROUTE_COLORS[0]!}
                className="mb-4 h-[360px] rounded-xl border border-line md:h-[420px]"
              />
            )}
            <section className={`grid gap-3 ${rides.length > 1 ? "md:grid-cols-2" : ""}`} aria-label="Your children's buses">
              {rides.map((r) => <RideCard key={r.learnerId} ride={r} now={now} color={colors.get(r.trip?.id ?? r.learnerId) ?? "#A3ABA5"} />)}
            </section>
          </>
        )}
        {parentCapabilities().busUpdates && <TransportNotifications rides={rides} />}
      </div>
    </>
  );
}

function notificationDate(value: string): string {
  if (!value) return "Time unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function TransportNotifications({ rides }: { rides: FamilyRide[] | null }) {
  const [notifications, setNotifications] = useState<FamilyTransportNotification[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [marking, setMarking] = useState<string | null>(null);
  const [markError, setMarkError] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await apiFetchTransportNotifications();
      if (!alive.current) return;
      setNotifications(next);
      setError(null);
    } catch (err) {
      if (alive.current) setError(userMessage(err));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; };
  }, [load]);

  const markRead = async (notification: FamilyTransportNotification) => {
    setMarking(notification.id);
    setMarkError(null);
    try {
      await apiMarkTransportNotificationRead(notification.id);
      if (alive.current) {
        const readAt = new Date().toISOString();
        setNotifications((current) => current?.map((row) => row.id === notification.id ? { ...row, inAppReadAt: readAt } : row) ?? null);
      }
    } catch (err) {
      if (alive.current) setMarkError(userMessage(err));
    } finally {
      if (alive.current) setMarking(null);
    }
  };

  const learnerNames = useMemo(() => new Map((rides ?? []).map((ride) => [ride.learnerId, firstName(ride.learnerName)])), [rides]);

  return (
    <section className="mt-6 rounded-xl border border-line bg-white p-4" aria-label="Bus updates">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-semibold">Bus updates</h2>
          <p className="text-[11.5px] text-ink-muted">Messages sent about your children’s transport.</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading} className="rounded-md border border-line px-2.5 py-1.5 text-[11.5px] font-medium disabled:opacity-50">
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      {error && <p role="status" className="mb-3 text-[12px] text-warn-ink">Could not load bus updates: {error}{notifications ? ". Showing the last loaded updates." : ""}</p>}
      {markError && <p role="status" className="mb-3 text-[12px] text-warn-ink">Could not mark that update read: {markError}</p>}
      {loading && !notifications ? (
        <Skeleton className="h-20 rounded-lg" />
      ) : notifications?.length === 0 ? (
        <p className="rounded-lg bg-sunken px-3 py-4 text-center text-[12px] text-ink-muted">No bus updates yet.</p>
      ) : (
        <div className="divide-y divide-line-soft">
          {notifications?.map((notification) => (
            <article key={notification.id} className={`py-3 first:pt-0 last:pb-0 ${notification.inAppReadAt ? "" : "font-medium"}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-[12.5px]">{notification.title}</h3>
                  {notification.body && <p className="mt-0.5 whitespace-pre-wrap text-[12px] font-normal text-ink-muted">{notification.body}</p>}
                  <p className="mt-1 text-[10.5px] font-normal text-ink-faint">
                    {notification.learnerId && learnerNames.get(notification.learnerId) ? `${learnerNames.get(notification.learnerId)} · ` : ""}
                    {notificationDate(notification.createdAt)} · Delivery: {notification.deliveryStatus.replaceAll("_", " ")}
                  </p>
                </div>
                {notification.inAppReadAt ? (
                  <span className="shrink-0 text-[10.5px] font-normal text-ink-faint">Read</span>
                ) : (
                  <button type="button" onClick={() => void markRead(notification)} disabled={marking === notification.id} className="shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold text-accent disabled:opacity-50">
                    {marking === notification.id ? "Saving…" : "Mark read"}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function RideCard({ ride, now, color }: { ride: FamilyRide; now: number; color: string }) {
  const name = firstName(ride.learnerName);
  if (!ride.assigned) {
    return (
      <div className="rounded-xl border border-line-soft bg-white px-3.5 py-3">
        <div className="text-[13.5px] font-semibold">{name}</div>
        <div className="text-[12px] text-ink-muted">Not on a bus route.</div>
      </div>
    );
  }
  const loc = ride.location;
  const live = loc?.status === "live";
  return (
    <div className="rounded-xl border border-line-soft bg-white px-3.5 py-3" style={{ borderLeft: `4px solid ${color}` }}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[13.5px] font-semibold">{name}</div>
          <div className="truncate text-[11.5px] text-ink-muted">
            {ride.vehiclePlate ? <span className="font-mono font-semibold" style={{ color }}>{ride.vehiclePlate}</span> : <span>No bus assigned yet</span>}
            {ride.route ? ` · ${ride.route.name}` : ""}
          </div>
        </div>
        <LiveDot live={live} />
      </div>
      <dl className="mt-2 grid gap-0.5 text-[12.5px]">
        {ride.stop && <div className="flex gap-2"><dt className="w-16 shrink-0 text-ink-faint">Stop</dt><dd>{ride.stop.name}</dd></div>}
        {ride.driverFirstName && <div className="flex gap-2"><dt className="w-16 shrink-0 text-ink-faint">Driver</dt><dd>{ride.driverFirstName}</dd></div>}
      </dl>
      <p className="mt-2 text-[12.5px] text-ink-muted">{rideStatusText(ride)}</p>
      {loc && loc.status !== "live" && ride.trip && (
        <p className="mt-1 text-[11px] text-ink-faint">{loc.status === "stale" ? `Last seen: ${fmtAgo(loc.recordedAt, now)}` : "No position from the bus yet."}</p>
      )}
    </div>
  );
}
