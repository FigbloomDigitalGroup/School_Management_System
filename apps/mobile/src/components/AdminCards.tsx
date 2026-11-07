import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { fontSize } from "../theme";
import { useTheme } from "../ui/ThemeContext";

/** A titled card whose rows run edge to edge: the admin screens' lists (a class's register, a learner's balance). */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  const { t, s } = useTheme();
  return (
    <View style={[s.card, { padding: 0, overflow: "hidden", marginTop: 14 }]}>
      <View style={{ paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: t.appSurface.lineSoft }}>
        <Text style={s.h2}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

/** One figure with what it is and a line of context; two sit side by side in a wrapping row. */
export function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  const { t, s } = useTheme();
  return (
    <View accessible accessibilityLabel={`${label}: ${value}. ${sub}`} style={[s.card, { flexBasis: "47%", flexGrow: 1, padding: 14 }]}>
      <Text style={s.faint}>{label}</Text>
      <Text style={{ fontSize: fontSize.header + 3, fontWeight: "700", color: t.appSurface.ink, marginTop: 4 }}>{value}</Text>
      <Text style={[s.faint, { marginTop: 2 }]}>{sub}</Text>
    </View>
  );
}
