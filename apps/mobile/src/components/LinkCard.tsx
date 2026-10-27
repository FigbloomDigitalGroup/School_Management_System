import { Text, TouchableOpacity, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { s } from "../theme";

/** A way into a screen that has no tab: a small card on a home screen (the tab bars are already full). */
export function LinkCard({ label, blurb, tint, to }: { label: string; blurb: string; tint: string; to: string }) {
  const nav = useNavigation<any>();
  return (
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={label} onPress={() => nav.navigate(to)} style={[s.card, { marginTop: 10, padding: 14 }]}>
      <View style={[s.row, { justifyContent: "space-between" }]}>
        <Text style={s.eyebrow}>{label.toUpperCase()}</Text>
        <Text style={{ fontSize: 13, fontWeight: "600", color: tint }}>Open ›</Text>
      </View>
      <Text style={[s.small, { marginTop: 4 }]}>{blurb}</Text>
    </TouchableOpacity>
  );
}
