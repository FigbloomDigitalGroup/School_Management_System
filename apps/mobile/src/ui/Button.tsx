import { ActivityIndicator, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { LucideIcon } from "lucide-react-native";
import { CONTROL_FONT_SCALE, fontSize, HIT, s, t } from "../theme";
import { Tap } from "./Tap";

/**
 * The fill of a primary button, in one place on purpose. The brand orange is a
 * design decision, not a code fix: white on #F26A1B is 3.06:1, under the 4.5:1
 * a 15px label needs. When that is settled, change this line (t.status.warnInk
 * is 5.36:1 and the same hue family).
 */
export const CTA_FILL = t.brand.orange;

/** Link-style buttons use the same hue as the CTA, dark enough (5.4:1) to read as text. */
const LINK_INK = t.status.warnInk;

type Variant = "primary" | "secondary" | "quiet";

/**
 * Primary is the one thing a screen wants done; secondary is the way back or
 * the alternative; quiet is a text link. `loading` keeps the label in place
 * (hidden) under the spinner, so the button never changes width and a screen
 * reader still hears what it is. `disabled` is dimmed; `loading` is not, since
 * it is working, not off.
 */
export function Button({ label, onPress, variant = "primary", tint, loading = false, disabled = false, icon: Icon, style, accessibilityHint }: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  /** Fill for primary, label colour for quiet. Defaults to the CTA colour / link colour. */
  tint?: string;
  loading?: boolean;
  disabled?: boolean;
  icon?: LucideIcon;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}) {
  const inactive = disabled || loading;
  const fill = variant === "primary" ? tint ?? CTA_FILL : variant === "secondary" ? t.appSurface.lineSoft : "transparent";
  const ink = variant === "primary" ? "#fff" : variant === "secondary" ? t.appSurface.ink : tint ?? LINK_INK;

  return (
    <Tap
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      style={[variant === "primary" ? s.primary : styles.flat, { backgroundColor: fill }, disabled && styles.off, style]}
    >
      <View style={[styles.content, loading && styles.hidden]}>
        {Icon && <Icon size={18} color={ink} />}
        <Text maxFontSizeMultiplier={CONTROL_FONT_SCALE} style={{ fontSize: fontSize.lead, fontWeight: "600", color: ink }}>{label}</Text>
      </View>
      {loading && (
        <View pointerEvents="none" style={styles.spinner}>
          <ActivityIndicator color={ink} />
        </View>
      )}
    </Tap>
  );
}

const styles = StyleSheet.create({
  flat: { ...HIT, borderRadius: t.radius.lg, paddingVertical: 15, paddingHorizontal: 16, alignItems: "center", justifyContent: "center" },
  content: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  hidden: { opacity: 0 },
  spinner: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" },
  off: { opacity: 0.5 },
});
