import { useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import { accentFor, s, t } from "../../theme";

const ACCENT = "#7A1F2B";

const WORK = [
  { id: "t5", title: "Insha kuhusu mazingira", subject: "Kiswahili", teacher: "Bw. Mutua", due: "Overdue since Friday", state: "late" },
  { id: "t1", title: "Organic chemistry problem set 4", subject: "Chemistry", teacher: "Mr Otieno", due: "Today 16:00", state: "today" },
  { id: "t2", title: "Essay: causes of the Mau Mau uprising", subject: "History", teacher: "Mrs Wanjiru", due: "Tomorrow", state: "open" },
  { id: "t3", title: "Read Chapter 6 and answer the review questions", subject: "Biology", teacher: "Ms Njeri", due: "Thursday", state: "open" },
];

const TAG: Record<string, { bg: string; ink: string }> = {
  late: { bg: t.status.warnBg, ink: t.status.warnInk },
  today: { bg: t.brand.orangeSoft, ink: t.brand.orangeInk },
  open: { bg: "#F1EDEC", ink: "#6B605F" },
  done: { bg: t.status.okBg, ink: t.status.okInk },
};

/** Overdue stays at the top in orange rather than hiding behind a filter. */
export function StudentWork() {
  const a = accentFor(ACCENT);
  const [done, setDone] = useState<Record<string, boolean>>({});

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep }]}>
        <Text style={s.headerTitle}>Work</Text>
        <Text style={s.headerSub}>
          {WORK.filter((w) => !done[w.id]).length} to hand in
        </Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {WORK.map((w) => {
          const state = done[w.id] ? "done" : w.state;
          const tag = TAG[state]!;
          return (
            <View key={w.id} style={[s.card, { marginBottom: 10, borderColor: state === "late" ? t.brand.orangeLine : t.appSurface.line }]}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14.5, fontWeight: "600", lineHeight: 20 }}>{w.title}</Text>
                  <Text style={[s.faint, { marginTop: 4 }]}>{w.subject} · {w.teacher}</Text>
                </View>
                <View style={[s.pill, { backgroundColor: tag.bg }]}>
                  <Text style={[s.pillLabel, { color: tag.ink }]}>
                    {state === "done" ? "Done" : state === "late" ? "Overdue" : w.due}
                  </Text>
                </View>
              </View>

              {!done[w.id] && (
                <TouchableOpacity
                  onPress={() => setDone((d) => ({ ...d, [w.id]: true }))}
                  style={[s.primary, { backgroundColor: a.deep, marginTop: 12, paddingVertical: 12 }]}
                >
                  <Text style={s.primaryLabel}>Mark as handed in</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        })}
        <Text style={[s.faint, { marginTop: 8, lineHeight: 18 }]}>
          Marking work as handed in tells your teacher you have finished it. It does not upload anything.
        </Text>
      </ScrollView>
    </View>
  );
}
