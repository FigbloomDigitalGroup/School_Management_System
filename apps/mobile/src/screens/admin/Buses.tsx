import { useEffect, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import {
  FLEET_ALERT_LABEL, acknowledgeAlert, busStatusLine, busesLiveFirst, fetchFleetNow, fleetDateTime, isLive, subscribeVehicleAlerts, subscribeVehiclePositions,
  tripLine, tripTimes, withPosition, TRIP_DIRECTION_LABEL, type BusOnRoute, type Vehicle,
} from "@figbloom/shared";
import { Section } from "../../components/AdminCards";
import { BusMap } from "../../components/BusMap";
import { ScreenHeader } from "../../components/ScreenHeader";
import { Skeleton } from "../../components/Skeleton";
import { useLoad } from "../../lib/useLoad";
import { useRouteTrace } from "../../lib/useRouteTrace";
import type { StaffSession } from "../../lib/staffSession";
import { accentFor, fontSize } from "../../theme";
import { Button } from "../../ui/Button";
import { EmptyState, ErrorState } from "../../ui/StateView";
import { useTheme } from "../../ui/ThemeContext";

/** "Updated 2 min ago" and the on-the-road dot are re-worked this often between positions. */
const CLOCK_MS = 15_000;

/** A bus's route on the map, with the road it drives once that is known. */
function BusOnMap({ bus, tint }: { bus: BusOnRoute; tint: string }) {
  const path = useRouteTrace(bus.stops);
  return <BusMap bus={bus} tint={tint} height={220} path={path} />;
}

/**
 * The school's buses on the move, for the transport office and the principal: which are on the road now (positions
 * arrive as the buses report them), a bus's route and position on the map, what the database has flagged (speeding, off
 * route, a breakdown, children still aboard) with a way to acknowledge it, and the latest trips. Adding vehicles and
 * routes and assigning drivers are on the web console. Pull down to read it all again.
 */
export function Buses({ session }: { session: StaffSession }) {
  const { t, s } = useTheme();
  const a = accentFor(session.accent);
  const { data, error, loading, refreshing, refresh, retry } = useLoad(() => fetchFleetNow(session.tenantId), session.tenantId);
  /** Positions that arrived since the last read, by vehicle. */
  const [moved, setMoved] = useState<Record<string, Vehicle>>({});
  const [now, setNow] = useState(() => Date.now());
  const [openId, setOpenId] = useState<string | null>(null);
  const [acking, setAcking] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    // The bus moves as each position lands, and a new alert is read at once; the pull-down is the safety net.
    const offPositions = subscribeVehiclePositions(session.tenantId, (v) => { setMoved((m) => ({ ...m, [v.id]: v })); setNow(Date.now()); });
    const offAlerts = subscribeVehicleAlerts(session.tenantId, () => void refresh());
    const clock = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => { offPositions(); offAlerts(); clearInterval(clock); };
  }, [session.tenantId, refresh]);

  // A fresh read replaces what the feed told us before it.
  useEffect(() => { setMoved({}); }, [data]);

  const buses = data ? busesLiveFirst(Object.values(moved).reduce((all, v) => withPosition(all, v), data.buses), now) : [];
  const onTheRoad = buses.filter((b) => isLive(b.vehicle.last_ping_at, now)).length;

  async function acknowledge(id: string) {
    setAcking(id);
    setProblem(null);
    try {
      await acknowledgeAlert(id, session.profileId);
      void refresh();
    } catch (err) {
      setProblem(`Could not acknowledge: ${err instanceof Error ? err.message : "try again."}`);
    } finally {
      setAcking(null);
    }
  }

  return (
    <View style={s.screen}>
      <ScreenHeader title="Buses" sub="On the road now, alerts and recent trips" color={a.deep} back />
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}>
        {!!problem && <Text accessibilityRole="alert" style={{ fontSize: fontSize.small, color: t.status.badInk, marginBottom: 10 }}>{problem}</Text>}

        {error && !data ? (
          <ErrorState title="Couldn't load the buses" body={error} onRetry={retry} />
        ) : loading || !data ? (
          <View style={{ gap: 8 }}>
            {[0, 1, 2].map((i) => (
              <View key={i} style={[s.card, { padding: 14, gap: 8 }]}><Skeleton width="45%" height={14} /><Skeleton width="60%" height={11} /></View>
            ))}
          </View>
        ) : (
          <>
            {!!error && <Text style={[s.faint, { marginBottom: 8 }]}>Couldn't refresh: {error}</Text>}

            {data.alerts.length > 0 && (
              <View accessibilityRole="alert" style={{ borderWidth: 2, borderRadius: t.radius.lg, padding: 14, gap: 10, borderColor: t.status.warnInk, backgroundColor: t.status.warnBg }}>
                <Text style={{ fontSize: fontSize.body, fontWeight: "700", color: t.status.warnInk }}>
                  {data.alerts.length === 1 ? "1 alert to look at" : `${data.alerts.length} alerts to look at`}
                </Text>
                {data.alerts.map((al) => (
                  <View key={al.id} accessibilityLabel={`${al.vehicle?.plate_number ?? "Vehicle"}, ${FLEET_ALERT_LABEL[al.kind] ?? "Alert"}`} style={{ gap: 4 }}>
                    <Text style={{ fontSize: fontSize.small, fontWeight: "700", color: t.status.warnInk }}>
                      {al.vehicle?.plate_number ?? "Vehicle"} · {FLEET_ALERT_LABEL[al.kind] ?? "Alert"} · {fleetDateTime(al.created_at)}
                    </Text>
                    {!!al.detail && <Text style={{ fontSize: fontSize.small, color: t.status.warnInk }}>{al.detail}</Text>}
                    <Button variant="secondary" label="Acknowledge" loading={acking === al.id} disabled={acking !== null} onPress={() => void acknowledge(al.id)} style={{ alignSelf: "flex-start" }} />
                  </View>
                ))}
              </View>
            )}

            <Section title={`Buses · ${onTheRoad} of ${buses.length} on the road`}>
              {buses.length === 0 ? (
                <EmptyState title="No buses yet" body="Vehicles are added on the web console, with their routes and drivers." />
              ) : buses.map((b) => {
                const live = isLive(b.vehicle.last_ping_at, now);
                const open = openId === b.vehicle.id;
                const hasMap = b.vehicle.last_lat != null || b.stops.length > 0;
                return (
                  <View key={b.vehicle.id} accessibilityLabel={`Bus ${b.vehicle.plate_number}`} style={{ paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.appSurface.lineSoft }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: live ? t.status.okDot : t.appSurface.inkFaint }} />
                      <Text style={{ flex: 1, fontSize: fontSize.body, fontWeight: "700", color: t.appSurface.ink }}>{b.vehicle.plate_number}{b.vehicle.make_model ? ` · ${b.vehicle.make_model}` : ""}</Text>
                    </View>
                    <Text style={[s.small, { marginTop: 2 }]}>{busStatusLine(b.vehicle, now)}</Text>
                    <Text style={[s.faint, { marginTop: 2 }]}>
                      {b.route?.name ?? "No route"} · {b.driverName ?? "No driver assigned"}{b.direction ? ` · ${TRIP_DIRECTION_LABEL[b.direction]}` : ""}
                    </Text>
                    {hasMap && (
                      <Button
                        variant="secondary" label={open ? "Hide the map" : "Show on the map"} accessibilityHint={`${open ? "Closes" : "Opens"} the map for ${b.vehicle.plate_number}`}
                        onPress={() => setOpenId(open ? null : b.vehicle.id)} style={{ marginTop: 8, alignSelf: "flex-start" }}
                      />
                    )}
                    {open && hasMap && <View style={{ marginTop: 10 }}><BusOnMap bus={b} tint={a.deep} /></View>}
                  </View>
                );
              })}
            </Section>

            <Section title="Recent trips">
              {data.trips.length === 0 ? (
                <EmptyState title="No trips yet" body="Each trip a driver starts is listed here, newest first." />
              ) : data.trips.map((tr) => (
                <View key={tr.id} style={{ paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.appSurface.lineSoft }}>
                  <Text style={{ fontSize: fontSize.body, fontWeight: "600", color: t.appSurface.ink }}>{tr.vehicle?.plate_number ?? "A bus"}</Text>
                  <Text style={s.small}>{tripLine(tr)}</Text>
                  <Text style={s.faint}>{tripTimes(tr)}{tr.alertCount > 0 ? ` · ${tr.alertCount} ${tr.alertCount === 1 ? "alert" : "alerts"}` : ""}</Text>
                </View>
              ))}
            </Section>

            <Text style={[s.faint, { marginTop: 16 }]}>Vehicles, routes and drivers are set up on the web console, with the same login.</Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}
