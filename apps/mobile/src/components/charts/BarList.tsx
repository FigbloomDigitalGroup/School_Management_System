import { Text, View } from "react-native";
import { fmt, SERIES_COLORS } from "./tokens";
import { useTheme } from "../../ui/ThemeContext";

export interface Bar { key: string; label: string; value: number; detail?: string }

/** Marks compared side by side, strongest first as given: a name, a bar out of 100, and the mean. */
export function BarList({ title, summary, bars }: { title: string; summary?: string | null; bars: Bar[] }) {
  const { t, s } = useTheme();
  return (
    <View style={s.card}>
      <Text style={s.h2}>{title}</Text>
      {!!summary && <Text style={[s.small, { marginTop: 2 }]}>{summary}</Text>}
      <View style={{ marginTop: 10, gap: 10 }}>
        {bars.map((b) => (
          <View key={b.key} accessible accessibilityLabel={`${b.label}: mean ${fmt(b.value)}${b.detail ? `, ${b.detail}` : ""}`}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 13, color: t.appSurface.ink }}>{b.label}</Text>
              <Text style={[s.mono, { color: t.appSurface.ink, fontWeight: "600" }]}>{fmt(b.value)}</Text>
            </View>
            <View style={{ height: 8, borderRadius: 4, backgroundColor: t.appSurface.lineSoft, marginTop: 4, overflow: "hidden" }}>
              <View style={{ height: 8, borderRadius: 4, width: `${Math.min(Math.max(b.value, 0), 100)}%`, backgroundColor: SERIES_COLORS[0] }} />
            </View>
            {!!b.detail && <Text style={[s.faint, { marginTop: 2 }]}>{b.detail}</Text>}
          </View>
        ))}
      </View>
    </View>
  );
}
