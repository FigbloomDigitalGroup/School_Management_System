import { Text, View } from "react-native";
import { accentFor, s } from "../../theme";
import type { TeacherSession } from "../../navigation";

/** Real class roster + attendance marking lands in FIG-319. */
export function TeacherAttendance({ session }: { session: TeacherSession }) {
  const a = accentFor(session.accent);

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep }]}>
        <Text style={s.headerTitle}>Attendance</Text>
      </View>
      <View style={{ padding: 16 }}>
        <View style={s.card}>
          <Text style={s.small}>Class roster and attendance marking coming soon (FIG-319).</Text>
        </View>
      </View>
    </View>
  );
}
