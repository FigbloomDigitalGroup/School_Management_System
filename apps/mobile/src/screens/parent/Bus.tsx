import { useCallback, useEffect, useState } from "react";
import { AppState, Image, RefreshControl, ScrollView, Text, View } from "react-native";
import { isLive, listBusUpdates, myChildBus, subscribeBusUpdates, type BusOnRoute, type BusUpdate } from "@figbloom/shared";
import { accentFor, s } from "../../theme";
import { useChild, useChildren, useTenantId } from "../../data";

/** A child and the bus they ride, if any. */
interface Ride { childId: string; first: string; bus: BusOnRoute | null; routeName: string | null; stopName: string | null }

const ICON: Record<BusUpdate["kind"], string> = { trip_started: "🚌", distance: "📍", arrived: "✅", delay: "⏱" };
/** Bus position and "on the road" state refresh this often while the tab is open. */
const REFRESH_MS = 30_000;

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function ago(iso: string | null, now: number): string {
  if (!iso) return "No location yet";
  const min = Math.round((now - Date.parse(iso)) / 60_000);
  return min < 1 ? "Updated just now" : min < 60 ? `Updated ${min} min ago` : `Last seen ${new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * Every child's bus at once (no switching between children, same as the web
 * family view), with today's updates for each: "left school", "1 km away",
 * "at your stop", "running late". The same updates arrive as push
 * notifications from bus-tick with the app closed; this is the trail.
 */
export function ParentBus() {
  const children = useChildren();
  const tenantId = useTenantId();
  const { accent, index } = useChild();
  const a = accentFor(accent);
  const tint = index === 0 ? a.deep : a.hex;

  const [rides, setRides] = useState<Ride[] | null>(null);
  const [updates, setUpdates] = useState<BusUpdate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const ids = children.map((c) => c.id);
  const key = ids.join(",");

  const load = useCallback(async () => {
    try {
      const [r, u] = await Promise.all([
        Promise.all(children.map(async (c) => {
          const b = await myChildBus(c.id);
          return { childId: c.id, first: c.first, bus: b?.bus ?? null, routeName: b?.routeName ?? null, stopName: b?.stop?.name ?? null };
        })),
        listBusUpdates(ids, startOfToday()),
      ]);
      setRides(r);
      setUpdates(u);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the buses.");
    }
    setNow(Date.now());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- children are keyed by id
  }, [key]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    // Coming back to the app (say, from a push notification): catch up at once.
    const sub = AppState.addEventListener("change", (st) => { if (st === "active") void load(); });
    const off = subscribeBusUpdates(tenantId, (u) => {
      if (u.student_ids.some((id) => ids.includes(id))) setUpdates((prev) => [u, ...prev.filter((p) => p.id !== u.id)]);
    });
    return () => { clearInterval(timer); sub.remove(); off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by id list
  }, [load, tenantId]);

  const refresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: tint }]}>
        <Text style={s.headerTitle}>{children.length === 1 ? `${children[0]!.first}'s bus` : "Buses"}</Text>
        <Text style={s.headerSub}>You'll get a notification as the bus gets close</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}>
        {error && <Text style={[s.small, { color: "#B4472B" }]}>{error}</Text>}
        {!rides && !error && <Text style={s.small}>Loading…</Text>}
        {rides?.map((r) => (
          <RideCard key={r.childId} ride={r} now={now} tint={tint} updates={updates.filter((u) => u.student_ids.includes(r.childId))} />
        ))}
      </ScrollView>
    </View>
  );
}

function RideCard({ ride, now, tint, updates }: { ride: Ride; now: number; tint: string; updates: BusUpdate[] }) {
  const { bus } = ride;
  if (!bus) {
    return (
      <View style={[s.card, { padding: 14 }]}>
        <Text style={{ fontSize: 14, fontWeight: "600" }}>{ride.first}</Text>
        <Text style={[s.small, { marginTop: 2 }]}>
          {ride.routeName ? `${ride.routeName} has no bus assigned yet.` : "Not on a bus route. Contact the school office if this seems wrong."}
        </Text>
      </View>
    );
  }
  const live = isLive(bus.vehicle.last_ping_at, now);
  const d = bus.driver;

  return (
    <View style={[s.card, { padding: 14, borderLeftWidth: 4, borderLeftColor: tint }]}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ fontSize: 14, fontWeight: "600" }}>{ride.first}</Text>
          <Text numberOfLines={1} style={[s.small, { marginTop: 2 }]}>
            <Text style={[s.mono, { fontWeight: "700", color: tint }]}>{bus.vehicle.plate_number}</Text>
            {bus.route ? ` · ${bus.route.name}` : ""}
          </Text>
          {ride.stopName && <Text style={[s.faint, { marginTop: 2 }]}>Stop: {ride.stopName}</Text>}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: live ? "#2EA45A" : "#A3ABA5" }} />
          <Text style={[s.faint, { fontWeight: "600", color: live ? "#1E7A43" : undefined }]}>{live ? "On the road" : "Not on the road"}</Text>
        </View>
      </View>
      <Text style={[s.faint, { marginTop: 6 }]}>{ago(bus.vehicle.last_ping_at, now)}</Text>

      {updates.length > 0 && (
        <View style={{ marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: "#EEEAE8", gap: 8 }}>
          <Text style={s.eyebrow}>Today</Text>
          {updates.slice(0, 5).map((u) => (
            <View key={u.id} style={{ flexDirection: "row", gap: 8 }}>
              <Text style={{ width: 18, textAlign: "center" }}>{ICON[u.kind]}</Text>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 13, fontWeight: "600", color: u.kind === "delay" ? "#B4472B" : undefined }}>{u.title}</Text>
                <Text style={s.small}>{u.body}</Text>
              </View>
              <Text style={s.faint}>{new Date(u.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</Text>
            </View>
          ))}
        </View>
      )}

      {d && (
        <View style={{ marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: "#EEEAE8", flexDirection: "row", alignItems: "center", gap: 10 }}>
          {d.avatarUrl ? (
            <Image source={{ uri: d.avatarUrl }} style={{ width: 36, height: 36, borderRadius: 18 }} accessibilityLabel={`Photo of ${d.name}`} />
          ) : (
            <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: "#F1EDEC", alignItems: "center", justifyContent: "center" }}>
              <Text style={{ fontSize: 13, fontWeight: "700", color: "#6B605F" }}>{d.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}</Text>
            </View>
          )}
          <View>
            <Text style={{ fontSize: 13, fontWeight: "600" }}>{d.name}</Text>
            <Text style={s.faint}>{d.title ?? "Driver"}</Text>
          </View>
        </View>
      )}
    </View>
  );
}
