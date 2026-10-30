import { StyleSheet, Text } from "react-native";
import { ChevronLeft } from "lucide-react-native";
import { CONTROL_FONT_SCALE, fontSize } from "../theme";
import { RIPPLE_ON_DARK } from "./color";
import { Tap } from "./Tap";

const ON_COLOUR = "rgba(255,255,255,0.9)";

/**
 * The way back. White by default, for a coloured header; pass `color` for one
 * in the page itself (it then gets the dark ripple a light surface needs). The
 * touch area reaches past the text (hitSlop) so it clears 44dp without making
 * the row taller, and a screen reader hears "Go back" rather than a chevron
 * character.
 */
export function BackLink({ label = "Back", onPress, color }: { label?: string; onPress: () => void; color?: string }) {
  const ink = color ?? ON_COLOUR;
  return (
    <Tap
      accessibilityLabel={label === "Back" ? "Go back" : label}
      hitSlop={{ top: 8, bottom: 8, right: 16 }}
      onPress={onPress}
      pressedScale={1}
      ripple={color ? undefined : RIPPLE_ON_DARK}
      style={styles.link}
    >
      <ChevronLeft size={20} color={ink} />
      <Text maxFontSizeMultiplier={CONTROL_FONT_SCALE} style={[styles.label, { color: ink }]}>{label}</Text>
    </Tap>
  );
}

const styles = StyleSheet.create({
  link: { flexDirection: "row", alignItems: "center", alignSelf: "flex-start", gap: 2, paddingVertical: 6, paddingRight: 8, marginLeft: -4, marginBottom: 4, borderRadius: 8 },
  label: { fontSize: fontSize.small, fontWeight: "600" },
});
