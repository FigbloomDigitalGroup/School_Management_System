import { ScrollView, Text, View } from "react-native";
import { DEMO_TIMETABLE } from "@figbloom/shared";
import { accentFor, s, t } from "../../theme";

const NOW = 2;
const ACCENT = "#7A1F2B";

/** Where am I meant to be, and what is late. Nothing else above the fold. */
export function StudentToday() {
  const a = accentFor(ACCENT);
  const rows = DEMO_TIMETABLE.Tue!;
  const now = rows[NOW]!;
  const next = rows[NOW + 1]!;

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep }]}>
        <Text style={s.headerTitle}>Tuesday</Text>
        <Text style={s.headerSub}>2 September · Term 3, week 8</Text>
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={s.card}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={s.eyebrow}>NOW · PERIOD 3</Text>
            <Text style={[s.mono, { color: a.deep, fontSize: 11 }]}>18 min left</Text>
          </View>
          <Text style={{ fontSize: 19, fontWeight: "600", marginTop: 8 }}>{now[1]}</Text>
          <Text style={s.small}>{now[2]} · ends 10:00</Text>
          <View style={{ height: 6, borderRadius: 4, backgroundColor: t.appSurface.lineSoft, marginTop: 12, overflow: "hidden" }}>
            <View style={{ height: 6, borderRadius: 4, width: "62%", backgroundColor: a.deep }} />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: t.appSurface.lineSoft }}>
            <Text style={[s.eyebrow, { letterSpacing: 1 }]}>NEXT</Text>
            <Text style={{ fontSize: 13, fontWeight: "500" }}>{next[1]}</Text>
            <Text style={[s.small, { marginLeft: "auto" }]}>{next[0]} · {next[2]}</Text>
          </View>
        </View>

        <View style={[s.banner, { marginTop: 16 }]}>
          <View style={{ width: 24, height: 24, borderRadius: 8, backgroundColor: t.brand.orange, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: "#fff", fontWeight: "700", fontSize: 13 }}>!</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[s.bannerText, { fontWeight: "600", fontSize: 13.5 }]}>Kiswahili work is late</Text>
            <Text style={[s.bannerText, { marginTop: 4 }]}>
              Insha kuhusu mazingira — hand it in at the next lesson. Late work is still marked.
            </Text>
          </View>
        </View>

        <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>Rest of today</Text>
        {rows.slice(NOW + 1).map(([time, subject, room]) => (
          <View key={time} style={[s.card, { marginBottom: 8, padding: 14, flexDirection: "row", alignItems: "center", gap: 12 }]}>
            <Text style={[s.mono, { width: 44, color: t.appSurface.inkMuted }]}>{time}</Text>
            <View style={{ width: 3, height: 28, borderRadius: 2, backgroundColor: t.appSurface.line }} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: "500" }}>{subject}</Text>
              <Text style={s.faint}>{room}</Text>
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
