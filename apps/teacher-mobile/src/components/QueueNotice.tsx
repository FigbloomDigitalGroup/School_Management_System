import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { QueuedWrite } from "@figbloom/shared";
import { HIT } from "../theme";
import { queue } from "../storage";
import { Tap } from "../ui/Tap";
import { useTheme } from "../ui/ThemeContext";

const WHAT: Record<string, string> = {
  attendance: "A register",
  marks: "Marks",
  announcements: "A message",
  cbe_results: "CBE results",
  cbe_assessment_comments: "CBE comments",
};

/**
 * Something saved on this phone that the server refused. Waiting won't fix it,
 * so the queue set it aside: say what and why, and let the teacher discard it
 * once they have seen it (or entered it again) rather than carrying it silently.
 */
export function QueueNotice() {
  const { t, s } = useTheme();
  const [refused, setRefused] = useState<QueuedWrite[]>([]);

  useEffect(() => {
    let alive = true;
    const load = () => { void queue.rejected().then((r) => { if (alive) setRefused(r); }).catch(() => {}); };
    load();
    const timer = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const first = refused[0];
  if (!first) return null;
  return (
    <View style={[s.card, { marginBottom: 12, gap: 6, borderColor: t.status.warnInk }]} accessibilityRole="alert">
      <Text style={{ fontSize: 13.5, fontWeight: "600", color: t.status.warnInk }}>
        {WHAT[first.table] ?? "Something"} saved on this phone could not be sent{refused.length > 1 ? ` (and ${refused.length - 1} more)` : ""}
      </Text>
      <Text style={s.small}>{first.rejected?.message}. Check it, enter it again if you still need it, then discard this notice.</Text>
      <Tap
        accessibilityRole="button"
        onPress={() => { void queue.discard(first.id).then(() => queue.rejected()).then(setRefused); }}
        style={{ ...HIT, justifyContent: "center" }}
      >
        <Text style={{ fontSize: 13.5, fontWeight: "600", color: t.brand.orange }}>Discard</Text>
      </Tap>
    </View>
  );
}
