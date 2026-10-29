import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from "react-native";
import {
  endTrip, locationPingRow, myActiveTrip, myAssignment, pingLocation, startTrip, supabase,
  type AssignmentRow, type Trip, type TripDirection,
} from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { queue } from "../../storage";
import { ensureLocationPermissions, startLocationTracking, stopLocationTracking, type LocationTick } from "./locationTask";

const DIRECTION_LABEL: Record<TripDirection, string> = { to_school: "To school", from_school: "From school" };

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
  const a = accentFor(accent);
  const [loading, setLoading] = useState(true);
  const [assignment, setAssignment] = useState<AssignmentRow | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [direction, setDirection] = useState<TripDirection>("to_school");
  const [starting, setStarting] = useState(false);
  const [ending, setEnding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastPing, setLastPing] = useState<{ at: Date; lat: number; lng: number } | null>(null);
  const [held, setHeld] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const tripRef = useRef<Trip | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const found = await myAssignment(driverId);
      if (!alive) return;
      setAssignment(found);
      if (found) {
        const active = await myActiveTrip(driverId);
        if (!alive) return;
        if (active) { setTrip(active); tripRef.current = active; setDirection(active.direction); }
      }
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [driverId]);

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

  async function handleStart() {
    if (!assignment) return;
    setActionError(null);
    setStarting(true);
    try {
      const perm = await ensureLocationPermissions();
      if (!perm.ok) { setActionError(perm.message ?? "Location permission is required to start a trip."); return; }

      const newTrip = await startTrip({
        tenantId, vehicleId: assignment.vehicle_id, routeId: assignment.route_id, driverId, direction,
      });
      setTrip(newTrip);
      tripRef.current = newTrip;
      setLastPing(null);

      await startLocationTracking((tick: LocationTick) => {
        const active = tripRef.current;
        if (!active) return;
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
      });
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
      await endTrip(trip.id);
      setTrip(null);
      tripRef.current = null;
      setLastPing(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not end the trip.");
    } finally {
      setEnding(false);
    }
  }

  async function handleSignOut() {
    await stopLocationTracking();
    await supabase().auth.signOut({ scope: "local" });
  }

  if (loading) {
    return (
      <View style={[s.screen, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator size="large" color={a.deep} />
      </View>
    );
  }

  if (!assignment) {
    return (
      <View style={[s.screen, { alignItems: "center", justifyContent: "center", padding: 24 }]}>
        <Text style={{ fontSize: 16, fontWeight: "600", textAlign: "center" }}>You are not assigned to a vehicle yet</Text>
        <Text style={[s.small, { textAlign: "center", marginTop: 8 }]}>Contact the school office to be assigned to a bus and route.</Text>
        <TouchableOpacity onPress={() => void handleSignOut()} style={[s.primary, { marginTop: 20, borderWidth: 1, borderColor: t.appSurface.line }]}>
          <Text style={{ fontSize: 15, fontWeight: "600" }}>Sign out</Text>
        </TouchableOpacity>
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
        <TouchableOpacity onPress={() => void handleSignOut()} style={{ borderWidth: 1, borderColor: "rgba(255,255,255,0.4)", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 }}>
          <Text style={{ color: "#fff", fontSize: 12.5, fontWeight: "600" }}>Sign out</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={[s.card, { marginTop: -10 }]}>
          <Text style={s.eyebrow}>VEHICLE · ROUTE</Text>
          <Text style={{ fontSize: 24, fontWeight: "700", marginTop: 4 }}>{assignment.vehicle?.plate_number ?? "—"}</Text>
          <Text style={s.small}>{assignment.route?.name ?? "No route assigned"}</Text>
        </View>

        {!!actionError && <Text style={{ fontSize: 12.5, color: t.status.warnInk, marginTop: 12 }}>{actionError}</Text>}

        {!trip ? (
          <>
            <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>Direction</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              {(["to_school", "from_school"] as const).map((d) => {
                const on = direction === d;
                return (
                  <TouchableOpacity
                    key={d}
                    onPress={() => setDirection(d)}
                    style={[s.card, { flex: 1, alignItems: "center", padding: 16, borderWidth: 1.5, borderColor: on ? a.deep : t.appSurface.line, backgroundColor: on ? a.deep : t.appSurface.card }]}
                  >
                    <Text style={{ fontSize: 15, fontWeight: "600", color: on ? "#fff" : t.appSurface.ink }}>{DIRECTION_LABEL[d]}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <TouchableOpacity
              disabled={starting}
              onPress={() => void handleStart()}
              style={[s.primary, { backgroundColor: a.deep, marginTop: 24, paddingVertical: 20, opacity: starting ? 0.6 : 1 }]}
            >
              <Text style={[s.primaryLabel, { fontSize: 17 }]}>{starting ? "Starting…" : "Start trip"}</Text>
            </TouchableOpacity>
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

            <Text style={[s.small, { marginTop: 12 }]}>
              {lastPing
                ? `Last sent: ${lastPing.at.toLocaleTimeString()} · ${lastPing.lat.toFixed(4)}, ${lastPing.lng.toFixed(4)}`
                : "Waiting for the first location fix…"}
            </Text>
            {held > 0 && (
              <Text style={[s.faint, { marginTop: 4 }]}>
                {held} location update{held === 1 ? "" : "s"} saved on this phone, sending when you have signal
              </Text>
            )}

            <TouchableOpacity
              disabled={ending}
              onPress={() => void handleEnd()}
              style={[s.primary, { backgroundColor: t.status.warnInk, marginTop: 24, paddingVertical: 20, opacity: ending ? 0.6 : 1 }]}
            >
              <Text style={[s.primaryLabel, { fontSize: 17 }]}>{ending ? "Ending…" : "End trip"}</Text>
            </TouchableOpacity>
          </>
        )}

        <Text style={[s.faint, { marginTop: 20, lineHeight: 18 }]}>
          A notification stays visible while a trip is active — that is what keeps location sharing running with the
          screen locked.
        </Text>
      </ScrollView>
    </View>
  );
}
