import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { QueuedWrite } from "@figbloom/shared";
import { queue } from "../../storage";
import { Tap } from "../../ui/Tap";
import { useTheme } from "../../ui/ThemeContext";

/** How often to look for location updates the server has refused. */
const WATCH_MS = 4_000;

/**
 * Location updates the server refused for good (a trip ended from the office, a bus
 * reassigned): the phone sets those aside instead of sending them again, so without this
 * the driver would keep driving a bus the school can no longer see, with nothing on screen
 * to say so. Only this driver's are shown (the queue is scoped to whoever is signed in),
 * whether or not a trip is running. Held-for-signal pings are a different thing, said on
 * the trip card; these will never go out.
 */
export function RefusedPings() {
  const { t, s } = useTheme();
  const [refused, setRefused] = useState<QueuedWrite[]>([]);

  useEffect(() => {
    let alive = true;
    const look = async () => {
      const rejected = await queue.rejected();
      if (alive) setRefused(rejected.filter((w) => w.table === "vehicle_locations"));
    };
    void look().catch(() => {});
    const timer = setInterval(() => { void look().catch(() => {}); }, WATCH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  if (refused.length === 0) return null;

  const count = refused.reduce((n, w) => n + w.rows.length, 0);

  async function dismiss() {
    await Promise.all(refused.map((w) => queue.discard(w.id)));
    setRefused([]);
  }

  return (
    <View style={[s.card, { marginTop: 12, gap: 6, borderColor: t.status.warnInk }]} accessibilityRole="alert">
      <Text style={{ fontSize: 13.5, fontWeight: "600", color: t.status.warnInk }}>
        {count === 1 ? "A location update" : `${count} location updates`} could not be sent
      </Text>
      <Text style={s.small}>
        The school's system turned {count === 1 ? "it" : "them"} down, so the office may not see this bus on its map.
        If this keeps happening, tell the school office. ({refused[0]?.rejected?.message})
      </Text>
      <Tap accessibilityRole="button" onPress={() => void dismiss()} style={{ minHeight: 44, justifyContent: "center" }}>
        <Text style={{ fontSize: 13.5, fontWeight: "600", color: t.brand.orange }}>Dismiss</Text>
      </Tap>
    </View>
  );
}
