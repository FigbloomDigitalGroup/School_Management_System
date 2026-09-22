import { Text, TouchableOpacity, View } from "react-native";
import { supabase } from "@figbloom/shared";
import { accentFor, HIT, s, t } from "../../theme";
import type { TeacherSession } from "../../navigation";

export function TeacherAccount({ session }: { session: TeacherSession }) {
  const a = accentFor(session.accent);

  return (
    <View style={s.screen}>
      <View style={[s.header, { backgroundColor: a.deep }]}>
        <Text style={s.headerTitle}>Account</Text>
        <Text style={s.headerSub}>{session.fullName}</Text>
      </View>

      <View style={{ padding: 16 }}>
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => void supabase().auth.signOut()}
          style={[s.primary, { ...HIT, backgroundColor: t.brand.orange }]}
        >
          <Text style={s.primaryLabel}>Sign out</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
