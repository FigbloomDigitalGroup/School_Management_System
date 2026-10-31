import { StyleSheet, Text, View } from "react-native";
import { ChevronRight } from "lucide-react-native";
import { fontSize } from "../theme";
import { useTheme } from "./ThemeContext";

/**
 * The "Open ›" at the end of a card that is a way into another screen. A drawn
 * chevron rather than the character, which looks different on every phone
 * maker's font. It is only a label: the card around it is the control.
 */
export function OpenLabel({ label = "Open", tint }: { label?: string; tint: string }) {
  const { accentInk } = useTheme();
  return (
    <View style={styles.row}>
      <Text style={[styles.text, { color: accentInk(tint) }]}>{label}</Text>
      <ChevronRight size={16} color={accentInk(tint)} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 2 },
  text: { fontSize: fontSize.small, fontWeight: "600" },
});
