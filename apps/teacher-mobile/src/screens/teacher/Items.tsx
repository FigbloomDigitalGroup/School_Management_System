import { ScrollView, View } from "react-native";
import { accentFor } from "../../theme";
import { IssuedItemsView } from "../../components/IssuedItems";
import { ScreenHeader } from "../../components/ScreenHeader";
import type { TeacherSession } from "../../navigation";
import { useTheme } from "../../ui/ThemeContext";

/** What the school has issued this teacher: a laptop, lab keys, a class set they're holding. Returns are recorded by the office. */
export function TeacherItems({ session }: { session: TeacherSession }) {
  const { s } = useTheme();
  const a = accentFor(session.accent);
  return (
    <View style={s.screen}>
      <ScreenHeader title="My items" sub="Things the school has issued you, and when they're due back" color={a.deep} back />
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <IssuedItemsView holder={{ kind: "staff", profileId: session.profileId }} whose="you" tint={a.deep} />
      </ScrollView>
    </View>
  );
}
