import { useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { formatDueLabel, type WorkItem } from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { useStudentData } from "../../studentData";

const TAG: Record<WorkItem["state"], { bg: string; ink: string }> = {
  late: { bg: t.status.warnBg, ink: t.status.warnInk },
  open: { bg: "#F1EDEC", ink: "#6B605F" },
  done: { bg: t.status.okBg, ink: t.status.okInk },
};

/**
 * Overdue stays at the top in orange rather than hiding behind a filter.
 * "Mark as handed in" flips local state only, same as the web version's
 * plain (no-attachment) path — telling the teacher, not uploading a file.
 */
export function StudentWork() {
  const { data, accent } = useStudentData();
  const a = accentFor(accent);
  const [done, setDone] = useState<Record<string, boolean>>({});

  const work = data.work;
  const toHandIn = work.filter((w) => w.state !== "done" && !done[w.id]).length;

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep }]}>
        <Text style={s.headerTitle}>Work</Text>
        <Text style={s.headerSub}>{toHandIn} to hand in</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {work.length === 0 ? (
          <View style={[s.card, { alignItems: "center", padding: 24 }]}>
            <Text style={s.small}>Nothing set yet. Anything your teachers set appears here the moment they set it.</Text>
          </View>
        ) : (
          work.map((w) => {
            const state: WorkItem["state"] = done[w.id] ? "done" : w.state;
            const tag = TAG[state];
            return (
              <View key={w.id} style={[s.card, { marginBottom: 10, borderColor: state === "late" ? t.brand.orangeLine : t.appSurface.line }]}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14.5, fontWeight: "600", lineHeight: 20 }}>{w.title}</Text>
                    <Text style={[s.faint, { marginTop: 4 }]}>{w.subject} · {w.teacher}</Text>
                  </View>
                  <View style={[s.pill, { backgroundColor: tag.bg }]}>
                    <Text style={[s.pillLabel, { color: tag.ink }]}>
                      {state === "done" ? "Done" : formatDueLabel(w.dueOn, state === "late")}
                    </Text>
                  </View>
                </View>

                {state !== "done" && (
                  <TouchableOpacity
                    onPress={() => setDone((d) => ({ ...d, [w.id]: true }))}
                    style={[s.primary, { backgroundColor: a.deep, marginTop: 12, paddingVertical: 12 }]}
                  >
                    <Text style={s.primaryLabel}>Mark as handed in</Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          })
        )}
        <Text style={[s.faint, { marginTop: 8, lineHeight: 18 }]}>
          Marking work as handed in tells your teacher you have finished it. It does not upload anything.
        </Text>
      </ScrollView>
    </View>
  );
}
