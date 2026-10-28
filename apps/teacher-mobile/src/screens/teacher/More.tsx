import { Text, TouchableOpacity, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { useChatSession } from "../../lib/chatSession";
import { visitQueue } from "@figbloom/shared";
import { useChatUnread } from "../../lib/chatUnread";
import { useDayVisits } from "../../lib/useDayVisits";
import { accentFor, HIT, s, t } from "../../theme";
import type { TeacherSession } from "../../navigation";

const ITEMS: { to: "Timetable" | "Homework" | "Chats" | "Visitors" | "Performance" | "ReportCards" | "Bloom" | "Classes" | "Leave" | "Buses" | "Account"; label: string; glyph: string }[] = [
  { to: "Chats", label: "Chats", glyph: "✉" },
  { to: "Visitors", label: "Your visitors", glyph: "⌂" },
  { to: "Performance", label: "Performance", glyph: "↗" },
  { to: "Bloom", label: "Bloom (AI assistant)", glyph: "✦" },
  { to: "ReportCards", label: "Report cards", glyph: "▤" },
  { to: "Timetable", label: "Timetable", glyph: "◷" },
  { to: "Homework", label: "Homework", glyph: "✎" },
  { to: "Classes", label: "My classes", glyph: "▨" },
  { to: "Leave", label: "Leave", glyph: "⚑" },
  { to: "Buses", label: "School buses", glyph: "🚌" },
  { to: "Account", label: "Account", glyph: "◎" },
];

/** The tab bar has room for 5 — everything past Attendance/Gradebook/
 *  Messages/Notices lives here instead of crowding it further. */
export function TeacherMore({ session }: { session: TeacherSession }) {
  const a = accentFor(session.accent);
  const navigation = useNavigation<{ navigate: (screen: string) => void }>();
  const chat = useChatSession();
  const unreadChats = useChatUnread(chat?.tenantId ?? null);
  const { visits } = useDayVisits(session.tenantId);
  const visitorsHere = visits ? visitQueue(visits).length : 0;
  /** Unread chats, and visitors still on the premises who asked for this teacher. */
  const badgeFor = (to: string) => (to === "Chats" ? unreadChats : to === "Visitors" ? visitorsHere : 0);

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
            {badgeFor(item.to) > 0 && (
              <View style={{ minWidth: 20, height: 20, borderRadius: 10, backgroundColor: t.brand.orange, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 }}>
                <Text style={{ color: "#fff", fontSize: 11, fontWeight: "700" }}>{badgeFor(item.to)}</Text>
              </View>
            )}
            <Text style={{ color: t.appSurface.inkFaint }}>›</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}
