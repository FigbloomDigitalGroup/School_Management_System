import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Image, RefreshControl, ScrollView, Text, View } from "react-native";
import { isLive, listBusesOnRoutes, subscribeVehiclePositions, type BusOnRoute } from "@figbloom/shared";
import { accentFor } from "../../theme";
import { ScreenHeader } from "../../components/ScreenHeader";
import type { TeacherSession } from "../../navigation";
import { useTheme } from "../../ui/ThemeContext";

function ago(iso: string | null, now: number): string {
  if (!iso) return "Not reporting yet";
  const min = Math.round((now - Date.parse(iso)) / 60_000);
  if (min < 1) return "Updated just now";
  if (min < 60) return `Updated ${min} min ago`;
  return `Last seen ${new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * Every school bus, live and read-only — same information as the web teacher
 * console's Buses screen (apps/web/src/screens/teacher/Buses.tsx, a live map),
 * as a card list here instead: the mobile apps have no maps library yet, the
 * same tradeoff apps/mobile's parent Bus screen already made. Position
 * updates stream in over the same Realtime channel the web map uses, so a
 * teacher glancing at this at dismissal sees it move without pulling to
 * refresh.
 */
export function TeacherBuses({ session }: { session: TeacherSession }) {
  const { t, s, accentInk } = useTheme();
  const a = accentFor(session.accent);
  const [buses, setBuses] = useState<BusOnRoute[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const data = await listBusesOnRoutes(session.tenantId);
      setBuses(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the buses.");
    }
    setNow(Date.now());
  }, [session.tenantId]);

  useEffect(() => {
    void load();
    return subscribeVehiclePositions(session.tenantId, (v) =>
      setBuses((prev) => prev?.map((b) => (b.vehicle.id === v.id ? { ...b, vehicle: { ...b.vehicle, ...v } } : b)) ?? prev));
  }, [load, session.tenantId]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  if (!buses && !error) {
    return (
      <View style={[s.screen, { alignItems: "center", justifyContent: "center" }]}>
        <ActivityIndicator size="large" color={accentInk(a.deep)} />
      </View>
    );
  }

  return (
    <View style={s.screen}>
      <ScreenHeader title="School buses" sub="Where every bus is right now, and who's driving it" color={a.deep} back />
      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 10 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      >
        {!!error && <Text style={[s.small, { color: t.status.badText }]}>{error}</Text>}
        {buses?.length === 0 && !error && (
          <View style={s.card}>
            <Text style={s.small}>No buses added yet.</Text>
          </View>
        )}
        {buses?.map((bus) => <BusCard key={bus.vehicle.id} bus={bus} now={now} accent={a.deep} />)}
      </ScrollView>
    </View>
  );
}

function BusCard({ bus, now, accent }: { bus: BusOnRoute; now: number; accent: string }) {
  const { t, s } = useTheme();
  const live = isLive(bus.vehicle.last_ping_at, now);
  const d = bus.driver;

  return (
    <View style={[s.card, { padding: 14, borderLeftWidth: 4, borderLeftColor: accent }]}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Text style={[{ color: t.appSurface.ink }, s.mono, { fontSize: 15, fontWeight: "700" }]}>{bus.vehicle.plate_number}</Text>
          <Text style={[s.small, { marginTop: 2 }]}>{bus.route?.name ?? "No route assigned"}</Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: live ? t.status.liveDot : t.status.idleDot }} />
          <Text style={[s.faint, { fontWeight: "600", color: live ? t.status.liveInk : t.appSurface.inkFaint }]}>{live ? "On the road" : "Not on the road"}</Text>
        </View>
      </View>
      <Text style={[s.faint, { marginTop: 6 }]}>{ago(bus.vehicle.last_ping_at, now)}</Text>

      {d ? (
        <View style={{ marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: t.appSurface.line, flexDirection: "row", alignItems: "center", gap: 10 }}>
          {d.avatarUrl ? (
            <Image source={{ uri: d.avatarUrl }} style={{ width: 32, height: 32, borderRadius: 16 }} accessibilityLabel={`Photo of ${d.name}`} />
          ) : (
            <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: t.appSurface.lineSoft, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ fontSize: 12, fontWeight: "700", color: t.appSurface.inkMuted }}>{d.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}</Text>
            </View>
          )}
          <View>
            <Text style={{ color: t.appSurface.ink, fontSize: 13, fontWeight: "600" }}>{d.name}</Text>
            <Text style={s.faint}>{d.title ?? "Driver"}</Text>
          </View>
        </View>
      ) : (
        <Text style={[s.faint, { marginTop: 8 }]}>No driver assigned</Text>
      )}
    </View>
  );
}
