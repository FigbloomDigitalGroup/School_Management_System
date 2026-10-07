import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase, syncLabel, type Trip, type TripDirection } from "@figbloom/shared";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";
import { useOnline } from "../../lib/useOnline";
import { queue } from "../../lib/queue";
import {
  endTrip, fmtDistance, listBusesOnRoutes, locationPingRow, myActiveTrip, myAssignment, pingLocation, routeProgress, startTrip, stopsInTravelOrder,
  type AssignmentRow, type BusOnRoute,
} from "@figbloom/shared";
import { Avatar } from "../../components/Avatar";
import { Eta, LiveRouteMap, MapSheet, busPosition, fmtEta, useLiveBuses, type LatLng } from "../../components/fleet/LiveRouteMap";

/** Don't write a location row on every watchPosition tick (it can fire many
 *  times a second) — only once this much time has passed since the last one. */
const PING_MIN_INTERVAL_MS = 10_000;

interface DriverState {
  assignment: AssignmentRow | null;
  /** Resumed from the database on load, in case the driver refreshed mid-trip. */
  activeTrip: Trip | null;
  /** This driver's bus with its route's stops, for the map. */
  bus: BusOnRoute | null;
}

async function loadDriverState(driverId: string, tenantId: string): Promise<DriverState> {
  const assignment = await myAssignment(driverId);
  if (!assignment) return { assignment: null, activeTrip: null, bus: null };
  const [activeTrip, buses] = await Promise.all([myActiveTrip(driverId), listBusesOnRoutes(tenantId)]);
  return { assignment, activeTrip, bus: buses.find((b) => b.vehicle.id === assignment.vehicle_id) ?? null };
}

function formatElapsed(startedAt: string, nowMs: number): string {
  const totalSec = Math.max(0, Math.floor((nowMs - new Date(startedAt).getTime()) / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

const DIRECTION_LABEL: Record<TripDirection, string> = {
  to_school: "To school",
  from_school: "From school",
};

/**
 * Fleet tracking, phase 2: the driver's own screen. A GPS-tracked bus, driven
 * by a plain browser tab on the driver's phone — no native app, so it only
 * reports location while this exact page is open and in the foreground. That
 * limitation is real, not a footnote, and is stated in the copy below.
 *
 * Rendered without ConsoleShell on purpose (see App.tsx) — this owns the
 * whole viewport, one big screen for someone glancing at it while driving.
 */
export function DriverTrip() {
  const { profile, tenant } = useTenantSession();
  const navigate = useNavigate();
  const online = useOnline();
  const { data, loading, error } = useAsync(() => loadDriverState(profile.id, tenant.id), [profile.id, tenant.id]);

  const [trip, setTrip] = useState<Trip | null>(null);
  const [direction, setDirection] = useState<TripDirection>("to_school");
  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [lastPing, setLastPing] = useState<{ at: Date; lat: number; lng: number } | null>(null);
  const [queuedPings, setQueuedPings] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  /** Every GPS fix, for the map. Pings to the database stay throttled below. */
  const [selfPos, setSelfPos] = useState<LatLng | null>(null);

  const lastPingAtRef = useRef(0);

  // Pick up any pings held from a dead zone (this session or an earlier one where the tab
  // was closed offline), and keep watching while any are queued — queue.ts drains them via
  // its own "online" listener, this just reflects that draining on screen as it happens.
  useEffect(() => {
    let cancelled = false;
    const check = () => void queue.pendingFor("vehicle_locations").then((p) => { if (!cancelled) setQueuedPings(p.length); });
    check();
    const id = window.setInterval(check, 4_000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  // Resume an in-progress trip found on load (e.g. the driver refreshed mid-trip).
  useEffect(() => {
    if (data?.activeTrip) {
      setTrip(data.activeTrip);
      setDirection(data.activeTrip.direction);
    }
  }, [data]);

  // Ticking clock for the elapsed-time readout.
  useEffect(() => {
    if (!trip) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [trip]);

  // Live location while a trip is active, throttled to one write per PING_MIN_INTERVAL_MS.
  useEffect(() => {
    if (!trip) return;
    if (!("geolocation" in navigator)) {
      setGeoError("This browser does not support location — the trip cannot be tracked from here.");
      return;
    }
    setGeoError(null);
    lastPingAtRef.current = 0;

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setSelfPos({ lat: position.coords.latitude, lng: position.coords.longitude });
        const nowMs = Date.now();
        if (nowMs - lastPingAtRef.current < PING_MIN_INTERVAL_MS) return;
        lastPingAtRef.current = nowMs;

        const { latitude, longitude, speed, heading } = position.coords;
        // The Geolocation API reports speed in metres/second — convert to km/h at the boundary.
        const pingInput = {
          tenantId: tenant.id,
          vehicleId: trip.vehicle_id,
          tripId: trip.id,
          lat: latitude,
          lng: longitude,
          speedKmh: speed != null ? speed * 3.6 : undefined,
          heading: heading ?? undefined,
        };

        if (online) {
          pingLocation(pingInput)
            .then(() => setLastPing({ at: new Date(), lat: latitude, lng: longitude }))
            .catch((err: unknown) => {
              setActionError(err instanceof Error ? `Could not send a location update: ${err.message}` : "Could not send a location update.");
            });
        } else {
          // No signal — hold the ping on the phone rather than drop it. History still needs
          // it even though the live map's "where is it now" cache only resumes once we're back.
          void queue.enqueue("vehicle_locations", [locationPingRow(pingInput)])
            .then(() => queue.pendingFor("vehicle_locations"))
            .then((p) => setQueuedPings(p.length));
          setLastPing({ at: new Date(), lat: latitude, lng: longitude });
        }
      },
      (err) => setGeoError(err.message || "Location permission was denied. Allow location access to keep tracking this trip."),
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 15_000 },
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [trip, tenant.id, online]);

  async function handleStart() {
    if (!data?.assignment) return;
    setActionError(null);
    setStarting(true);
    try {
      const newTrip = await startTrip({
        tenantId: tenant.id,
        vehicleId: data.assignment.vehicle_id,
        routeId: data.assignment.route_id,
        driverId: profile.id,
        direction,
      });
      setLastPing(null);
      setTrip(newTrip);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not start the trip.");
    } finally {
      setStarting(false);
    }
  }

  async function handleEnd() {
    if (!trip) return;
    setActionError(null);
    setEnding(true);
    try {
      await endTrip(trip.id);
      setTrip(null);
      setLastPing(null);
      setGeoError(null);
      setSelfPos(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not end the trip.");
    } finally {
      setEnding(false);
    }
  }

  async function handleSignOut() {
    await supabase().auth.signOut();
    navigate("/signin", { replace: true });
  }

  if (loading) {
    return (
      <div className="grid min-h-screen place-items-center bg-page">
        <p className="text-body text-ink-muted">Loading…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="grid min-h-screen place-items-center bg-page px-6 text-center">
        <p className="text-body text-warn-ink">Could not load your assignment: {error.message}</p>
      </div>
    );
  }

  if (!data?.assignment) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-page px-6 text-center">
        <div className="max-w-sm">
          <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-full bg-warn-bg text-2xl text-warn-ink">!</div>
          <h1 className="text-lead font-semibold text-ink">You are not assigned to a vehicle yet</h1>
          <p className="mt-2 text-body text-ink-muted">Contact the school office to be assigned to a bus and route.</p>
        </div>
        <div className="flex gap-2">
          <Link to="profile" className="hit rounded-lg border border-line px-5 py-2.5 text-small font-semibold text-ink-muted">My profile</Link>
          <button
            onClick={() => void handleSignOut()}
            className="hit rounded-lg border border-line px-5 py-2.5 text-small font-semibold text-ink-muted"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  const assignment = data.assignment;

  return (
    <div className="flex h-[100dvh] flex-col bg-page">
      <header className="flex shrink-0 items-center justify-between gap-3 bg-forest px-5 py-3.5 text-white">
        <div className="min-w-0">
          <div className="truncate text-lead font-semibold tracking-tight">{profile.full_name}</div>
          <div className="font-mono text-micro tracking-[0.12em] text-white/70">{tenant.name.toUpperCase()} · DRIVER</div>
        </div>
        <Link
          to="profile"
          className="hit flex shrink-0 items-center gap-2 rounded-full border border-white/30 py-1 pl-1 pr-3 text-small font-semibold text-white"
          aria-label="My profile"
        >
          <Avatar id={profile.id} name={profile.full_name} url={profile.avatar_url} size={30} />
          Profile
        </Link>
      </header>

      <DriverMap tenantId={tenant.id} bus={data.bus} selfPos={trip ? selfPos : null} direction={trip?.direction ?? direction}>
        {(next, stopNo, stopCount, pos, offRouteM) => (
          <MapSheet className="md:w-[400px]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-mono text-[22px] font-bold leading-tight tracking-tight text-ink">{assignment.vehicle?.plate_number ?? "—"}</div>
                <div className="truncate text-body text-ink-muted">{assignment.route?.name ?? "No route assigned"}</div>
              </div>
              {trip && (
                <div className="shrink-0 text-right">
                  <div className="flex items-center justify-end gap-1.5 text-[11.5px] font-semibold text-ok-ink">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-ok-dot" />
                    {DIRECTION_LABEL[trip.direction]}
                  </div>
                  <div className="font-mono text-[20px] tracking-tight text-ink">{formatElapsed(trip.started_at, now)}</div>
                </div>
              )}
            </div>

            {actionError && <p className="mt-2 text-small leading-relaxed text-warn-ink">{actionError}</p>}

            {!trip ? (
              <>
                <div className="mt-3 flex gap-2">
                  {(["to_school", "from_school"] as const).map((d) => (
                    <button
                      key={d}
                      onClick={() => setDirection(d)}
                      aria-pressed={direction === d}
                      className={`hit flex-1 rounded-xl border-[1.5px] py-3 text-body font-semibold transition-colors ${
                        direction === d ? "border-forest bg-forest text-white" : "border-line text-ink-muted"
                      }`}
                    >
                      {DIRECTION_LABEL[d]}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => void handleStart()}
                  disabled={starting}
                  className="hit mt-3 w-full rounded-2xl bg-forest py-5 text-lead font-bold text-white disabled:opacity-60"
                >
                  {starting ? "Starting…" : "Start trip"}
                </button>
              </>
            ) : (
              <>
                {next ? (
                  <div className="mt-3 flex items-center justify-between gap-3 rounded-xl bg-page px-3.5 py-3">
                    <div className="min-w-0">
                      <div className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">
                        {offRouteM != null ? `Head to the route · ${fmtDistance(offRouteM)} away` : `Next stop · ${stopNo} of ${stopCount}`}
                      </div>
                      <div className="truncate text-[16px] font-semibold">{next.name}</div>
                    </div>
                    <Eta from={pos} to={next}>{(eta) => <div className="shrink-0 text-[22px] font-bold text-forest">{fmtEta(eta)}</div>}</Eta>
                  </div>
                ) : (
                  <div className="mt-3 rounded-xl bg-page px-3.5 py-3 text-body text-ink-muted">
                    {selfPos ? "Last stop reached. End the trip when everyone is off." : "Waiting for the first location fix…"}
                  </div>
                )}

                {geoError && <p className="mt-2 text-small leading-relaxed text-warn-ink">{geoError}</p>}
                {queuedPings > 0 && <p className="mt-2 text-small leading-relaxed text-warn-ink">{syncLabel(queuedPings, online)}</p>}
                <div className="mt-2 text-[11.5px] text-ink-faint">
                  {lastPing ? `${queuedPings > 0 ? "Last fix" : "Last sent"} ${lastPing.at.toLocaleTimeString()}` : "Sharing your location once the first fix arrives"}
                </div>

                <button
                  onClick={() => void handleEnd()}
                  disabled={ending}
                  className="hit mt-3 w-full rounded-2xl bg-warn-ink py-5 text-lead font-bold text-white disabled:opacity-60"
                >
                  {ending ? "Ending…" : "End trip"}
                </button>
              </>
            )}

            <p className="mt-3 text-[11px] leading-relaxed text-ink-faint">
              Keep this page open while driving. Locking your phone or switching apps stops location sharing.
            </p>
          </MapSheet>
        )}
      </DriverMap>
    </div>
  );
}

/**
 * The driver's map: their route along the roads, their bus (following their
 * own GPS during a trip), and, handed to the sheet, the next stop in the
 * direction they're driving.
 */
function DriverMap({ tenantId, bus: initial, selfPos, direction, children }: {
  tenantId: string;
  bus: BusOnRoute | null;
  selfPos: LatLng | null;
  direction: TripDirection;
  children: (next: { name: string; lat: number; lng: number } | null, stopNo: number, stopCount: number, pos: LatLng | null, offRouteM: number | null) => ReactNode;
}) {
  const live = useLiveBuses(tenantId, useMemo(() => (initial ? [initial] : []), [initial]));
  const bus = live[0] ? { ...live[0], direction } : null;
  const pos = selfPos ?? (bus ? busPosition(bus) : null);
  const ordered = bus ? stopsInTravelOrder(bus.stops, direction) : [];
  const progress = pos ? routeProgress(ordered, pos) : null;
  const nextIndex = progress?.nextIndex ?? null;
  const next = selfPos && nextIndex != null ? ordered[nextIndex]! : null;

  return (
    <LiveRouteMap buses={bus ? [bus] : []} selectedId={bus?.vehicle.id ?? null} selfPos={selfPos} className="flex-1">
      {children(next, (nextIndex ?? 0) + 1, ordered.length, pos, selfPos ? (progress?.offRouteM ?? null) : null)}
    </LiveRouteMap>
  );
}
