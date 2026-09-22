import { Text, View } from "react-native";
import { accentFor, s } from "../../theme";
import type { TeacherSession } from "../../navigation";

/** Real gradebook/assignment entry lands in FIG-320. */
export function TeacherGradebook({ session }: { session: TeacherSession }) {
  const a = accentFor(session.accent);

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep }]}>
        <Text style={s.headerTitle}>Gradebook</Text>
      </View>
      <View style={{ padding: 16 }}>
        <View style={s.card}>
          <Text style={s.small}>Gradebook and assignments coming soon (FIG-320).</Text>
        </View>
      </View>
    </View>
  );
}
