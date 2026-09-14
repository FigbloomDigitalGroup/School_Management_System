import { useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";
import type { Weekday } from "@figbloom/shared";
import { accentFor, HIT, s, t } from "../../theme";
import { useStudentData } from "../../studentData";

const DAYS: Weekday[] = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const DAY_LABEL: Record<Weekday, string> = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday" };
const TODAY: Weekday = DAYS[(new Date().getDay() + 6) % 7] ?? "Mon";

/** One day at a time — a phone has no room for the desktop's full-week grid. */
export function StudentTimetable() {
  const { data, timetable, accent } = useStudentData();
  const a = accentFor(accent);
  const [day, setDay] = useState<Weekday>(TODAY);
  const rows = timetable[day];

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep }]}>
        <Text style={s.headerTitle}>Timetable</Text>
        <Text style={s.headerSub}>{data.className}</Text>
      </View>

      <View style={{ flexDirection: "row", gap: 6, paddingHorizontal: 16, paddingTop: 14 }}>
        {DAYS.map((d) => {
          const on = d === day;
          return (
            <TouchableOpacity
              key={d}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              onPress={() => setDay(d)}
              style={{
                ...HIT, flex: 1, borderRadius: 10, alignItems: "center", justifyContent: "center",
                backgroundColor: on ? a.deep : t.appSurface.lineSoft,
              }}
            >
              <Text style={{ fontSize: 12.5, fontWeight: "600", color: on ? "#fff" : t.appSurface.inkMuted }}>{d}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {rows.length === 0 ? (
          <View style={[s.card, { alignItems: "center", padding: 24 }]}>
            <Text style={s.small}>No periods set for {DAY_LABEL[day]} yet.</Text>
          </View>
        ) : (
          rows.map(([time, subject, room], i) => (
            <View key={`${time}-${i}`} style={[s.card, { marginBottom: 8, padding: 14, flexDirection: "row", alignItems: "center", gap: 12 }]}>
              <Text style={[s.mono, { width: 44, color: t.appSurface.inkMuted }]}>{time}</Text>
              <View style={{ width: 3, height: 28, borderRadius: 2, backgroundColor: t.appSurface.line }} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: "500" }}>{subject}</Text>
                {!!room && <Text style={s.faint}>{room}</Text>}
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}
