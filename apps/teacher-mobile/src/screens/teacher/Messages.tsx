import { Text, View } from "react-native";
import { accentFor, s } from "../../theme";
import type { TeacherSession } from "../../navigation";

/** Real class messaging (reusing the announcements table, per the web
 *  teacher Messages screen) lands in FIG-321. */
export function TeacherMessages({ session }: { session: TeacherSession }) {
  const a = accentFor(session.accent);

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep }]}>
        <Text style={s.headerTitle}>Messages</Text>
      </View>
      <View style={{ padding: 16 }}>
        <View style={s.card}>
          <Text style={s.small}>Class messaging coming soon (FIG-321).</Text>
        </View>
      </View>
    </View>
  );
}
