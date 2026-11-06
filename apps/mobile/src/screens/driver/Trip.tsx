import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import {
  endTrip, listRouteStops, locationPingRow, myActiveTrip, myAssignment, pingLocation, startTrip, stopsInTravelOrder,
  type AssignmentRow, type RouteStop, type Trip, type TripDirection,
} from "@figbloom/shared";
import { accentFor } from "../../theme";
import { FingerprintSetting } from "../../components/FingerprintSetting";
import { PrivacyLinks } from "../../components/PrivacyLinks";
import { queue } from "../../storage";
import { signOutOfThisPhone } from "../../lib/signOut";
import { checkLocationSwitch, ensureLocationPermissions, startLocationTracking, stopLocationTracking, type LocationTick } from "./locationTask";
import { RefusedPings } from "./RefusedPings";
import { ReportBreakdown } from "./ReportBreakdown";
import { TripMap } from "./TripMap";
import { TripRiders } from "./TripRiders";
import { RIPPLE_ON_DARK } from "../../ui/color";
import { Tap } from "../../ui/Tap";
import { AppearanceSetting } from "../../ui/AppearanceSetting";
import { useTheme } from "../../ui/ThemeContext";

const DIRECTION_LABEL: Record<TripDirection, string> = { to_school: "To school", from_school: "From school" };

/** End trip waits this long for held location updates to go out, then ends the trip anyway: no signal must not trap a driver on a live trip. */
export const HELD_SEND_MS = 8_000;

/** Sends what is held, giving up after HELD_SEND_MS; never throws. */
function sendHeldPings(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, HELD_SEND_MS);
    queue.flush().then(() => {}, () => {}).finally(() => { clearTimeout(timer); resolve(); });
  });
}

/** Said before a trip is created: with Location switched off the trip would go live and the bus would never move (FIG-1491). */
export const LOCATION_OFF_MESSAGE = "Location is switched off on this phone, so the bus cannot be tracked. Swipe down from the top of the screen, tap Location to switch it on, then start the trip again.";
/** Said when a trip has run this long with no fix at all. */
export const NO_FIX_MESSAGE = "No location yet. Is Location switched on? Swipe down from the top of the screen and check the Location button.";
export const NO_FIX_AFTER_MS = 20_000;
/** Said when a trip that is already live cannot get its tracking started again, and what to do about it (FIG-1488). */
export const TRACKING_NOT_RUNNING = "Tracking is not running";
export const LOCATION_OFF_RESUME_MESSAGE = "Location is switched off on this phone, so the bus cannot be tracked. Swipe down from the top of the screen, tap Location to switch it on, then tap Resume tracking.";
export const RESUME_TRACKING = "Resume tracking";

function formatElapsed(startedAt: string, nowMs: number): string {
  const totalSec = Math.max(0, Math.floor((nowMs - new Date(startedAt).getTime()) / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

interface DriverProps {
  driverId: string;
  tenantId: string;
  accent: string;
  fullName: string;
}

/**
 * Fleet tracking, native phase: the same lifecycle as the web driver screen
 * (apps/web/src/screens/driver/Trip.tsx), but backed by a foreground service
 * so a locked phone in a driver's pocket keeps reporting position — the
 * browser-tab version could not do that at all.
 */
export function DriverTrip({ driverId, tenantId, accent, fullName }: DriverProps) {
  const { t, s, accentInk } = useTheme();
  const a = accentFor(accent);
  // Marks and pings held on this phone belong to this driver. Set while rendering, so the
  // flush on mount below already knows who is signed in.
  queue.setUser(driverId);
  const [loading, setLoading] = useState(true);
  const [assignment, setAssignment] = useState<AssignmentRow | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [direction, setDirection] = useState<TripDirection>("to_school");
  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastPing, setLastPing] = useState<{ at: Date; lat: number; lng: number } | null>(null);
  /** Every GPS fix, sent or not: the map and the next-stop time follow the bus even through a dead zone. */
  const [selfPos, setSelfPos] = useState<{ lat: number; lng: number } | null>(null);
  const [held, setHeld] = useState(0);
  const [routeStops, setRouteStops] = useState<RouteStop[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [noFix, setNoFix] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  /** Why a live trip has no tracking (permission, Location switched off, the service would not start); null when there is nothing to say. */
  const [trackingProblem, setTrackingProblem] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const tripRef = useRef<Trip | null>(null);

  // A trip that is live but has had no GPS fix for a while: say what to check instead of waiting in silence.
  const hasFix = selfPos !== null;
  const tripId = trip?.id ?? null;
  useEffect(() => {
    setNoFix(false);
    if (!tripId || hasFix) return;
    const id = setTimeout(() => setNoFix(true), NO_FIX_AFTER_MS);
    return () => clearTimeout(id);
  }, [tripId, hasFix]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const found = await myAssignment(driverId);
      if (!alive) return;
      setAssignment(found);
      if (found) {
        const active = await myActiveTrip(driverId);
        if (!alive) return;
        if (active) {
          setTrip(active); tripRef.current = active; setDirection(active.direction);
          // Opening the app during a trip: whatever was tracking it died with the app, so start it again (FIG-1488).
          void resume.current();
        }
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [driverId]);

  useEffect(() => {
    let alive = true;
    if (!assignment?.route_id) { setRouteStops([]); return; }
    listRouteStops(assignment.route_id)
      .then((r) => { if (alive) setRouteStops(r); })
      .catch(() => {});
    return () => { alive = false; };
  }, [assignment?.route_id]);

  useEffect(() => {
    if (!trip) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [trip]);

  // Stop the foreground service if the screen unmounts mid-trip (e.g. sign-out).
  useEffect(() => () => { void stopLocationTracking(); }, []);

  // Pings queued from a dead zone on a previous trip (one that outlasted the trip itself)
  // get one more chance to go out as soon as this screen is back on screen.
  useEffect(() => {
    void queue.flush().then(() => queue.pendingFor("vehicle_locations")).then((p) => setHeld(p.length));
  }, []);

  /** What happens with each GPS reading of the live trip: send it, or keep it on the phone if it cannot go. */
  function onTick(tick: LocationTick) {
    const active = tripRef.current;
    if (!active) return;
    setSelfPos({ lat: tick.lat, lng: tick.lng });
    const input = {
      tenantId, vehicleId: active.vehicle_id, tripId: active.id,
      lat: tick.lat, lng: tick.lng, speedKmh: tick.speedKmh, heading: tick.heading, recordedAt: tick.recordedAt,
    };
    (async () => {
      try {
        await pingLocation(input);
        setLastPing({ at: new Date(tick.recordedAt), lat: tick.lat, lng: tick.lng });
      } catch {
        // No signal (or a transient failure): keep the fix on disk rather than lose it,
        // same fallback the teacher app's attendance register uses. It goes out, in order
        // with its original time, next time this trip (or the next one) gets a signal.
        await queue.enqueue("vehicle_locations", [locationPingRow(input)]);
      }
      const pending = await queue.flush().then(() => queue.pendingFor("vehicle_locations"));
      setHeld(pending.length);
    })().catch((err: unknown) => {
      setActionError(err instanceof Error ? `Could not send a location update: ${err.message}` : "Could not send a location update.");
    });
  }

  /**
   * A trip is already live but nothing is tracking it: the app was closed or restarted during the trip, which stops the
   * tracker, and the screen would otherwise say "Trip in progress" while the bus never moved on the map (FIG-1488).
   * Starts the tracker again for the same trip, or says what is in the way, with a button to try again.
   */
  async function resumeTracking() {
    setTrackingProblem(null);
    setResuming(true);
    try {
      const perm = await ensureLocationPermissions();
      if (!perm.ok) { setTrackingProblem(perm.message ?? "Location permission is required to track this trip."); return; }
      if ((await checkLocationSwitch()) === "off") { setTrackingProblem(LOCATION_OFF_RESUME_MESSAGE); return; }
      await startLocationTracking(onTick);
    } catch (err) {
      setTrackingProblem(err instanceof Error ? `Tracking could not be started: ${err.message}` : "Tracking could not be started.");
    } finally {
      setResuming(false);
    }
  }
  // The effect that finds the live trip on opening is set up once; it calls whichever copy is current.
  const resume = useRef(resumeTracking);
  resume.current = resumeTracking;

  async function handleStart() {
    if (!assignment) return;
    setActionError(null);
    setTrackingProblem(null);
    setStarting(true);
    try {
      const perm = await ensureLocationPermissions();
      if (!perm.ok) { setActionError(perm.message ?? "Location permission is required to start a trip."); return; }
      if ((await checkLocationSwitch()) === "off") { setActionError(LOCATION_OFF_MESSAGE); return; }

      const newTrip = await startTrip({
        tenantId, vehicleId: assignment.vehicle_id, routeId: assignment.route_id, driverId, direction,
      });
      setTrip(newTrip);
      tripRef.current = newTrip;
      setLastPing(null);
      setSelfPos(null);

      await startLocationTracking(onTick);
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
      await stopLocationTracking();
      // The server only takes a position for a trip that is still active, so what the phone is holding from a dead
      // zone has to go out BEFORE the trip ends: sent afterwards it is refused and set aside (FIG-1490).
      await sendHeldPings();
      await endTrip(trip.id);
      setTrip(null);
      tripRef.current = null;
      setLastPing(null);
      setSelfPos(null);
      setTrackingProblem(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not end the trip.");
    } finally {
      setEnding(false);
    }
  }

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await stopLocationTracking();
      await signOutOfThisPhone();
    } finally {
      setSigningOut(false);
    }
  }

  if (loading) {
    return (
      <View style={[s.screen, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator size="large" color={accentInk(a.deep)} />
      </View>
    );
  }

  if (!assignment) {
    return (
      <View style={[s.screen, { alignItems: "center", justifyContent: "center", padding: 24 }]}>
        <Text style={{ color: t.appSurface.ink, fontSize: 16, fontWeight: "600", textAlign: "center" }}>You are not assigned to a vehicle yet</Text>
        <Text style={[s.small, { textAlign: "center", marginTop: 8 }]}>Contact the school office to be assigned to a bus and route.</Text>
        <Tap disabled={signingOut} onPress={() => void handleSignOut()} style={[s.primary, { marginTop: 20, borderWidth: 1, borderColor: t.appSurface.line, opacity: signingOut ? 0.6 : 1 }]}>
          <Text style={{ color: t.appSurface.ink, fontSize: 15, fontWeight: "600" }}>{signingOut ? "Signing out…" : "Sign out"}</Text>
        </Tap>
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep, flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }]}>
        <View>
          <Text style={s.headerTitle}>{fullName}</Text>
          <Text style={s.headerSub}>DRIVER</Text>
        </View>
        <Tap disabled={signingOut} onPress={() => void handleSignOut()} ripple={RIPPLE_ON_DARK} style={{ borderWidth: 1, borderColor: "rgba(255,255,255,0.4)", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, opacity: signingOut ? 0.6 : 1 }}>
          <Text style={{ color: "#fff", fontSize: 12.5, fontWeight: "600" }}>{signingOut ? "Signing out…" : "Sign out"}</Text>
        </Tap>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={[s.card, { marginTop: -10 }]}>
          <Text style={s.eyebrow}>VEHICLE · ROUTE</Text>
          <Text style={{ color: t.appSurface.ink, fontSize: 24, fontWeight: "700", marginTop: 4 }}>{assignment.vehicle?.plate_number ?? "—"}</Text>
          <Text style={s.small}>{assignment.route?.name ?? "No route assigned"}</Text>
        </View>

        <RefusedPings />

        {!!actionError && <Text style={{ fontSize: 12.5, color: t.status.warnInk, marginTop: 12 }}>{actionError}</Text>}

        {!trip ? (
          <>
            <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>Direction</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              {(["to_school", "from_school"] as const).map((d) => {
                const on = direction === d;
                return (
                  <Tap
                    key={d}
                    onPress={() => setDirection(d)}
                    style={[s.card, { flex: 1, alignItems: "center", padding: 16, borderWidth: 1.5, borderColor: on ? accentInk(a.deep) : t.appSurface.line, backgroundColor: on ? a.deep : t.appSurface.card }]}
                  >
                    <Text style={{ fontSize: 15, fontWeight: "600", color: on ? "#fff" : t.appSurface.ink }}>{DIRECTION_LABEL[d]}</Text>
                  </Tap>
                );
              })}
            </View>

            <Tap
              disabled={starting}
              onPress={() => void handleStart()}
              style={[s.primary, { backgroundColor: a.deep, marginTop: 24, paddingVertical: 20, opacity: starting ? 0.6 : 1 }]}
            >
              <Text style={[s.primaryLabel, { fontSize: 17 }]}>{starting ? "Starting…" : "Start trip"}</Text>
            </Tap>
          </>
        ) : (
          <>
            <View style={[s.card, { marginTop: 16, backgroundColor: t.status.okBg, borderColor: t.status.okBg }]}>
              <View style={s.row}>
                <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: t.status.okDot }} />
                <Text style={{ fontSize: 14, fontWeight: "600", color: t.status.okInk }}>
                  Trip in progress · {DIRECTION_LABEL[trip.direction]}
                </Text>
              </View>
              <Text style={[s.mono, { fontSize: 26, color: t.status.okInk, marginTop: 6 }]}>{formatElapsed(trip.started_at, now)}</Text>
            </View>

            {trackingProblem && (
              <View style={[s.card, { marginTop: 12, gap: 6, borderColor: t.status.warnInk }]} accessibilityRole="alert">
                <Text style={{ fontSize: 13.5, fontWeight: "600", color: t.status.warnInk }}>{TRACKING_NOT_RUNNING}</Text>
                <Text style={s.small}>{trackingProblem}</Text>
                <Tap accessibilityRole="button" disabled={resuming} onPress={() => void resumeTracking()} style={{ minHeight: 44, justifyContent: "center" }}>
                  <Text style={{ fontSize: 13.5, fontWeight: "600", color: t.brand.orange }}>{resuming ? "Starting…" : RESUME_TRACKING}</Text>
                </Tap>
              </View>
            )}

            <Text style={[s.small, { marginTop: 12 }]}>
              {lastPing
                ? `Last sent: ${lastPing.at.toLocaleTimeString()} · ${lastPing.lat.toFixed(4)}, ${lastPing.lng.toFixed(4)}`
                : noFix && !selfPos ? NO_FIX_MESSAGE : "Waiting for the first location fix…"}
            </Text>
            {held > 0 && (
              <Text style={[s.faint, { marginTop: 4 }]}>
                {held} location update{held === 1 ? "" : "s"} saved on this phone, sending when you have signal
              </Text>
            )}

            <TripMap direction={trip.direction} stops={routeStops} plate={assignment.vehicle?.plate_number ?? "—"} pos={selfPos} tint={a.deep} />

            <TripRiders trip={trip} tenantId={tenantId} stops={stopsInTravelOrder(routeStops, trip.direction)} tint={a.deep} />

            <ReportBreakdown tripId={trip.id} lat={lastPing?.lat ?? null} lng={lastPing?.lng ?? null} />

            <Tap
              disabled={ending}
              onPress={() => void handleEnd()}
              style={[s.primary, { backgroundColor: t.status.warnInk, marginTop: 24, paddingVertical: 20, opacity: ending ? 0.6 : 1 }]}
            >
              <Text style={[s.primaryLabel, { fontSize: 17 }]}>{ending ? "Ending…" : "End trip"}</Text>
            </Tap>
          </>
        )}

        <Text style={[s.faint, { marginTop: 20, lineHeight: 18 }]}>
          A notification stays visible while a trip is active — that is what keeps location sharing running with the
          screen locked.
        </Text>

        <AppearanceSetting tint={a.deep} />
        <FingerprintSetting tint={a.deep} />

        <PrivacyLinks tint={a.deep} />
      </ScrollView>
    </View>
  );
}
