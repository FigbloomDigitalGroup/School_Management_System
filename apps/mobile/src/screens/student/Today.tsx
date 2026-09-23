import { ScrollView, Text, View } from "react-native";
import { currentPeriodIndex, todayWeekday } from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";
import { useStudentData } from "../../studentData";

/** Where am I meant to be, and what is late. Nothing else above the fold. */
export function StudentToday() {
  const { data, timetable, accent } = useStudentData();
  const a = accentFor(accent);

  const day = todayWeekday();
  const rows = day ? timetable[day] : [];
  const nowIdx = currentPeriodIndex(rows);
  const now = rows[nowIdx];
  const next = rows[nowIdx + 1];
  const restOfDay = rows.slice(nowIdx + 1);
  const overdue = data.work.filter((w) => w.state === "late");

  const today = new Date();
  const dayLabel = today.toLocaleDateString("en-GB", { weekday: "long" });
  const dateLabel = today.toLocaleDateString("en-GB", { day: "numeric", month: "long" });

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep }]}>
        <Text style={s.headerTitle}>{dayLabel}</Text>
        <Text style={s.headerSub}>{dateLabel}{data.className ? ` · ${data.className}` : ""}</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={[s.card, now ? { borderLeftWidth: 4, borderLeftColor: a.deep } : null]}>
          {now ? (
            <>
              <Text style={[s.eyebrow, { color: a.deep }]}>NOW</Text>
              <Text style={{ fontSize: 19, fontWeight: "600", marginTop: 8 }}>{now[1]}</Text>
              <Text style={s.small}>{[now[2], now[3]].filter(Boolean).join(" · ")} · {now[0]}</Text>
            </>
          ) : (
            <Text style={s.small}>{day ? "No lesson recorded for now" : "No school today"}</Text>
          )}
          {next && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: t.appSurface.lineSoft }}>
              <Text style={[s.eyebrow, { letterSpacing: 1 }]}>NEXT</Text>
              <Text style={{ fontSize: 13, fontWeight: "500" }}>{next[1]}</Text>
              <Text style={[s.small, { marginLeft: "auto" }]}>{[next[0], next[2], next[3]].filter(Boolean).join(" · ")}</Text>
            </View>
          )}
        </View>

        {overdue.length > 0 && (
          <View style={[s.banner, { marginTop: 16 }]}>
            <View style={{ width: 24, height: 24, borderRadius: 8, backgroundColor: t.brand.orange, alignItems: "center", justifyContent: "center" }}>
              <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>!</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[s.bannerText, { fontWeight: "600", fontSize: 13.5 }]}>
                {overdue.length === 1 ? `${overdue[0]!.subject} work is late` : `${overdue.length} pieces of work are late`}
              </Text>
              <Text style={[s.bannerText, { marginTop: 4 }]}>
                {overdue.length === 1
                  ? `${overdue[0]!.title} — hand it in at the next lesson. Late work is still marked.`
                  : `${overdue.map((w) => w.subject).join(", ")} — hand these in at the next lesson. Late work is still marked.`}
              </Text>
            </View>
          </View>
        )}

        <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>Rest of today</Text>
        {restOfDay.length === 0 ? (
          <View style={[s.card, { alignItems: "center", padding: 24 }]}>
            <Text style={s.small}>That's it for today.</Text>
          </View>
        ) : (
          restOfDay.map(([time, subject, room, teacher]) => (
            <View key={time} style={[s.card, { marginBottom: 8, padding: 14, flexDirection: "row", alignItems: "center", gap: 12 }]}>
              <Text style={[s.mono, { width: 44, color: t.appSurface.inkMuted }]}>{time}</Text>
              <View style={{ width: 3, height: 28, borderRadius: 2, backgroundColor: a.hex }} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, fontWeight: "500" }}>{subject}</Text>
                <Text style={s.faint}>{[room, teacher].filter(Boolean).join(" · ")}</Text>
              </View>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}
