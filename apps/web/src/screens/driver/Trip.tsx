import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase, syncLabel, type Trip, type TripDirection } from "@figbloom/shared";
import { useTenantSession } from "../../lib/sessionContext";
import { useAsync } from "../../lib/useAsync";
import { useOnline } from "../../lib/useOnline";
import { queue } from "../../lib/queue";
import { endTrip, locationPingRow, myActiveTrip, myAssignment, pingLocation, startTrip, type AssignmentRow } from "@figbloom/shared";

/** Don't write a location row on every watchPosition tick (it can fire many
 *  times a second) — only once this much time has passed since the last one. */
const PING_MIN_INTERVAL_MS = 10_000;

interface DriverState {
  assignment: AssignmentRow | null;
  /** Resumed from the database on load, in case the driver refreshed mid-trip. */
  activeTrip: Trip | null;
}

async function loadDriverState(driverId: string): Promise<DriverState> {
  const assignment = await myAssignment(driverId);
  if (!assignment) return { assignment: null, activeTrip: null };
  const activeTrip = await myActiveTrip(driverId);
  return { assignment, activeTrip };
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
  const { data, loading, error } = useAsync(() => loadDriverState(profile.id), [profile.id]);

  const [trip, setTrip] = useState<Trip | null>(null);
  const [direction, setDirection] = useState<TripDirection>("to_school");
  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [lastPing, setLastPing] = useState<{ at: Date; lat: number; lng: number } | null>(null);
  const [queuedPings, setQueuedPings] = useState(0);
  const [now, setNow] = useState(() => Date.now());

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
        <button
          onClick={() => void handleSignOut()}
          className="hit rounded-lg border border-line px-5 py-2.5 text-small font-semibold text-ink-muted"
        >
          Sign out
        </button>
      </div>
    );
  }

  const assignment = data.assignment;

  return (
    <div className="flex min-h-screen flex-col bg-page">
      <header className="flex shrink-0 items-center justify-between gap-3 bg-forest px-5 py-4 text-white">
        <div className="min-w-0">
          <div className="truncate text-lead font-semibold tracking-tight">{profile.full_name}</div>
          <div className="font-mono text-micro tracking-[0.12em] text-white/70">{tenant.name.toUpperCase()} · DRIVER</div>
        </div>
        <button
          onClick={() => void handleSignOut()}
          className="hit shrink-0 rounded-lg border border-white/30 px-3.5 py-2 text-small font-semibold text-white"
        >
          Sign out
        </button>
      </header>

      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-5 px-5 py-6">
        <div className="rounded-xl border border-line bg-white p-4">
          <div className="font-mono text-micro tracking-[0.12em] text-ink-faint">VEHICLE · ROUTE</div>
          <div className="mt-1 text-[26px] font-bold tracking-tight text-ink">{assignment.vehicle?.plate_number ?? "—"}</div>
          <div className="text-body text-ink-muted">{assignment.route?.name ?? "No route assigned"}</div>
        </div>

        {actionError && <p className="text-small leading-relaxed text-warn-ink">{actionError}</p>}

        {!trip ? (
          <>
            <div>
              <div className="mb-2 text-small font-semibold text-ink-muted">Direction</div>
              <div className="flex gap-2">
                {(["to_school", "from_school"] as const).map((d) => (
                  <button
                    key={d}
                    onClick={() => setDirection(d)}
                    aria-pressed={direction === d}
                    className={`hit flex-1 rounded-xl border-[1.5px] py-3.5 text-body font-semibold transition-colors ${
                      direction === d ? "border-forest bg-forest text-white" : "border-line text-ink-muted"
                    }`}
                  >
                    {DIRECTION_LABEL[d]}
                  </button>
                ))}
              </div>
            </div>

            <button
              onClick={() => void handleStart()}
              disabled={starting}
              className="hit w-full rounded-2xl bg-forest py-6 text-lead font-bold text-white disabled:opacity-60"
            >
              {starting ? "Starting…" : "Start trip"}
            </button>
          </>
        ) : (
          <>
            <div className="rounded-xl border border-ok-bg bg-ok-bg p-4">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-ok-dot" />
                <span className="text-body font-semibold text-ok-ink">Trip in progress · {DIRECTION_LABEL[trip.direction]}</span>
              </div>
              <div className="mt-1.5 font-mono text-[28px] tracking-tight text-ok-ink">{formatElapsed(trip.started_at, now)}</div>
            </div>

            {geoError && <p className="text-small leading-relaxed text-warn-ink">{geoError}</p>}

            {queuedPings > 0 && (
              <p className="text-small leading-relaxed text-warn-ink">{syncLabel(queuedPings, online)}</p>
            )}

            <div className="text-small text-ink-muted">
              {lastPing
                ? `${queuedPings > 0 ? "Last fix" : "Last sent"}: ${lastPing.at.toLocaleTimeString()} · ${lastPing.lat.toFixed(4)}, ${lastPing.lng.toFixed(4)}`
                : "Waiting for the first location fix…"}
            </div>

            <button
              onClick={() => void handleEnd()}
              disabled={ending}
              className="hit w-full rounded-2xl bg-warn-ink py-6 text-lead font-bold text-white disabled:opacity-60"
            >
              {ending ? "Ending…" : "End trip"}
            </button>
          </>
        )}

        <p className="mt-auto pt-4 text-small leading-relaxed text-ink-faint">
          Keep this page open while driving. Locking your phone or switching apps stops location sharing — this is a
          browser tab, not an app, so it can only report your position while it is open and in front of you.
        </p>
      </main>
    </div>
  );
}
