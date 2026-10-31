import { ScrollView, Text, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import {
  Bus, CalendarOff, ChevronRight, Clock, DoorOpen, FileText, FolderOpen, MessageSquare, Package, PencilLine, Sparkles, TrendingUp, UserRound, Users, Video,
  type LucideIcon,
} from "lucide-react-native";
import { useChatSession } from "../../lib/chatSession";
import { visitQueue } from "@figbloom/shared";
import { useChatUnread } from "../../lib/chatUnread";
import { useDayVisits } from "../../lib/useDayVisits";
import { accentFor } from "../../theme";
import { Tap } from "../../ui/Tap";
import type { TeacherSession } from "../../navigation";
import { useTheme } from "../../ui/ThemeContext";

const ITEMS: { to: "Timetable" | "Homework" | "Materials" | "Chats" | "Visitors" | "Performance" | "ReportCards" | "Bloom" | "LiveClass" | "Classes" | "Leave" | "Items" | "Buses" | "Account"; label: string; icon: LucideIcon }[] = [
  { to: "Chats", label: "Chats", icon: MessageSquare },
  { to: "Visitors", label: "Your visitors", icon: DoorOpen },
  { to: "Performance", label: "Performance", icon: TrendingUp },
  { to: "LiveClass", label: "Live class", icon: Video },
  { to: "Bloom", label: "Bloom (AI assistant)", icon: Sparkles },
  { to: "ReportCards", label: "Report cards", icon: FileText },
  { to: "Timetable", label: "Timetable", icon: Clock },
  { to: "Homework", label: "Homework", icon: PencilLine },
  { to: "Materials", label: "Learning materials", icon: FolderOpen },
  { to: "Classes", label: "My classes", icon: Users },
  { to: "Leave", label: "Leave", icon: CalendarOff },
  { to: "Items", label: "My items", icon: Package },
  { to: "Buses", label: "School buses", icon: Bus },
  { to: "Account", label: "Account", icon: UserRound },
];

/** The tab bar has room for 5 — everything past Attendance/Gradebook/
 *  Messages/Notices lives here instead of crowding it further. */
export function TeacherMore({ session }: { session: TeacherSession }) {
  const { t, s } = useTheme();
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
      {/* Twelve rows are taller than a small phone's screen: this has to scroll, or the last ones can't be reached. */}
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {ITEMS.map((item) => {
          const Icon = item.icon;
          const badge = badgeFor(item.to);
          return (
            <Tap
              key={item.to}
              accessibilityLabel={badge > 0 ? `${item.label}, ${badge} new` : item.label}
              onPress={() => navigation.navigate(item.to)}
              style={[s.card, { marginBottom: 8, padding: 12, flexDirection: "row", alignItems: "center", gap: 12 }]}
            >
              <View style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: a.deep, alignItems: "center", justifyContent: "center" }}>
                <Icon size={19} color="#fff" />
              </View>
              <Text style={{ flex: 1, fontSize: 14.5, fontWeight: "500", color: t.appSurface.ink }}>{item.label}</Text>
              {badge > 0 && (
                <View style={{ minWidth: 20, height: 20, borderRadius: 10, backgroundColor: t.brand.orange, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 }}>
                  <Text style={{ color: "#fff", fontSize: 11, fontWeight: "700" }}>{badge}</Text>
                </View>
              )}
              <ChevronRight size={18} color={t.appSurface.inkFaint} />
            </Tap>
          );
        })}
      </ScrollView>
    </View>
  );
}
