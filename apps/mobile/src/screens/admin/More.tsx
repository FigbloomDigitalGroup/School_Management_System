import { ScrollView, Text, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import type { AdminScreen } from "../../adminScreens";
import type { StaffSession } from "../../lib/staffSession";
import { accentFor } from "../../theme";
import { Tap } from "../../ui/Tap";
import { useTheme } from "../../ui/ThemeContext";

/**
 * Everything on the admin side that is not the front page: one row for each screen this person's areas open. The
 * tab bar has room for three tabs, so the screens live here instead of each taking one, as the teacher's do.
 */
export function AdminMore({ session, screens, onOpen }: { session: StaffSession; screens: readonly AdminScreen[]; onOpen: (to: AdminScreen["to"]) => void }) {
  const { t, s } = useTheme();
  const a = accentFor(session.accent);

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep }]}>
        <Text style={s.headerTitle}>More</Text>
        <Text style={s.headerSub}>{session.school.name}</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {screens.map((screen) => {
          const Icon = screen.icon;
          return (
            <Tap
              key={screen.to}
              accessibilityLabel={screen.label}
              onPress={() => onOpen(screen.to)}
              style={[s.card, { marginBottom: 8, padding: 12, flexDirection: "row", alignItems: "center", gap: 12 }]}
            >
              <View style={{ width: 36, height: 36, borderRadius: 12, backgroundColor: a.deep, alignItems: "center", justifyContent: "center" }}>
                <Icon size={19} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14.5, fontWeight: "500", color: t.appSurface.ink }}>{screen.label}</Text>
                <Text style={s.faint}>{screen.blurb}</Text>
              </View>
              <ChevronRight size={18} color={t.appSurface.inkFaint} />
            </Tap>
          );
        })}
        <Text style={[s.faint, { marginTop: 8 }]}>The rest of the school's admin is on the web console, with the same login.</Text>
      </ScrollView>
    </View>
  );
}
