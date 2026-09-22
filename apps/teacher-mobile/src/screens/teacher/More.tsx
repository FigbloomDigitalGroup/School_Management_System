import { Text, TouchableOpacity, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { accentFor, HIT, s, t } from "../../theme";
import type { TeacherSession } from "../../navigation";

const ITEMS: { to: "Timetable" | "Classes" | "Leave" | "Account"; label: string; glyph: string }[] = [
  { to: "Timetable", label: "Timetable", glyph: "◷" },
  { to: "Classes", label: "My classes", glyph: "▨" },
  { to: "Leave", label: "Leave", glyph: "⚑" },
  { to: "Account", label: "Account", glyph: "◎" },
];

/** The tab bar has room for 5 — everything past Attendance/Gradebook/
 *  Messages/Notices lives here instead of crowding it further. */
export function TeacherMore({ session }: { session: TeacherSession }) {
  const a = accentFor(session.accent);
  const navigation = useNavigation<{ navigate: (screen: string) => void }>();

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep }]}>
        <Text style={s.headerTitle}>More</Text>
        <Text style={s.headerSub}>{session.fullName}</Text>
      </View>
      <View style={{ padding: 16 }}>
        {ITEMS.map((item) => (
          <TouchableOpacity
            key={item.to}
            accessibilityRole="button"
            onPress={() => navigation.navigate(item.to)}
            style={[s.card, { ...HIT, marginBottom: 8, padding: 14, flexDirection: "row", alignItems: "center", gap: 12 }]}
          >
            <Text style={{ fontSize: 17, width: 22, textAlign: "center" }}>{item.glyph}</Text>
            <Text style={{ flex: 1, fontSize: 14.5, fontWeight: "500" }}>{item.label}</Text>
            <Text style={{ color: t.appSurface.inkFaint }}>›</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}
