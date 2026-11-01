import { StyleSheet, Text, View } from "react-native";
import { Check, Moon, Smartphone, Sun, type LucideIcon } from "lucide-react-native";
import { Tap } from "./Tap";
import { useTheme, type ThemePref } from "./ThemeContext";

const OPTIONS: { value: ThemePref; label: string; hint: string; icon: LucideIcon }[] = [
  { value: "system", label: "Same as phone", hint: "Light or dark, whichever the phone is set to.", icon: Smartphone },
  { value: "light", label: "Light", hint: "A bright page, easiest to read in daylight.", icon: Sun },
  { value: "dark", label: "Dark", hint: "A dim page, gentler on the eyes at night.", icon: Moon },
];

/**
 * The "Appearance" section of an Account screen: follow the phone, or stay light or dark. It is a radio
 * group, so a screen reader says which is chosen, and the choice shows as a check mark as well as a colour.
 * The change is immediate and remembered.
 */
export function AppearanceSetting({ tint }: { tint: string }) {
  const { t, s, pref, setPref, accentInk } = useTheme();
  const accent = accentInk(tint);

  return (
    <>
      <Text style={[s.h2, { marginTop: 20, marginBottom: 8 }]}>Appearance</Text>
      <View accessibilityRole="radiogroup" style={[s.card, styles.group]}>
        {OPTIONS.map((option, i) => {
          const on = pref === option.value;
          const Icon = option.icon;
          return (
            <Tap
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={`${option.label}. ${option.hint}`}
              onPress={() => setPref(option.value)}
              pressedScale={1}
              style={[styles.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.appSurface.line }]}
            >
              <Icon size={20} color={on ? accent : t.appSurface.inkMuted} />
              <View style={styles.text}>
                <Text style={{ fontSize: 13.5, fontWeight: on ? "700" : "500", color: t.appSurface.ink }}>{option.label}</Text>
                <Text style={s.faint}>{option.hint}</Text>
              </View>
              {on && <Check size={20} color={accent} />}
            </Tap>
          );
        })}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  // The card's padding moves into the rows, so a row's press ripple reaches the card's edges.
  group: { padding: 0, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, minHeight: 56 },
  text: { flex: 1 },
});
