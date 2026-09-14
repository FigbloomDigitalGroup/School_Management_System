import { Text, TouchableOpacity, View } from "react-native";
import { HIT } from "../theme";

/**
 * Two children, no confusion.
 *
 * Always visible in the header rather than hidden in a menu, and the initials
 * are shown rather than a generic avatar — a parent glancing at a balance must
 * never wonder which child it belongs to.
 */
export function ChildSwitcher({
  children, index, onChange, tint,
}: {
  children: { id: string; name: string; first: string }[];
  index: number;
  onChange: (i: number) => void;
  tint: string;
}) {
  return (
    <View style={{ flexDirection: "row", gap: 6 }}>
      {children.map((c, i) => {
        const on = i === index;
        return (
          <TouchableOpacity
            key={c.id}
            accessibilityRole="button"
            accessibilityLabel={c.name}
            accessibilityState={{ selected: on }}
            onPress={() => onChange(i)}
            style={{
              ...HIT,
              width: 40, height: 40, borderRadius: 13,
              alignItems: "center", justifyContent: "center",
              backgroundColor: on ? "#fff" : "rgba(255,255,255,0.18)",
            }}
          >
            <Text style={{ fontSize: 12, fontWeight: "700", color: on ? tint : "#fff" }}>
              {c.first[0]}{c.name.split(" ")[1]?.[0]}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}
