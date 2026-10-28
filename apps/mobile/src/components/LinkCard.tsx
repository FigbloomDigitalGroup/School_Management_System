import { Text, TouchableOpacity, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import { s, t } from "../theme";

/** A way into a screen that has no tab: a small card on a home screen (the tab bars are already full). */
export function LinkCard({ label, blurb, tint, to, badge }: { label: string; blurb: string; tint: string; to: string; badge?: number }) {
  const nav = useNavigation<any>();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={badge ? `${label}, ${badge} new` : label}
      onPress={() => nav.navigate(to)}
      style={[s.card, { marginTop: 10, padding: 14 }]}
    >
      <View style={[s.row, { justifyContent: "space-between" }]}>
        <View style={[s.row, { gap: 8 }]}>
          <Text style={s.eyebrow}>{label.toUpperCase()}</Text>
          {!!badge && (
            <View style={{ minWidth: 18, height: 18, borderRadius: 9, backgroundColor: t.brand.orange, alignItems: "center", justifyContent: "center", paddingHorizontal: 5 }}>
              <Text style={{ color: "#fff", fontSize: 10.5, fontWeight: "700" }}>{badge}</Text>
            </View>
          )}
        </View>
        <Text style={{ fontSize: 13, fontWeight: "600", color: tint }}>Open ›</Text>
      </View>
      <Text style={[s.small, { marginTop: 4 }]}>{blurb}</Text>
    </TouchableOpacity>
  );
}
