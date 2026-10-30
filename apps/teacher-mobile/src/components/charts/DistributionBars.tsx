import { Text, View } from "react-native";
import type { Distribution } from "@figbloom/shared";
import { s, t } from "../../theme";
import { BAND_COLORS } from "./tokens";

const pct = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 100) : 0);

/**
 * How marks spread across grade bands, one stacked bar per exam (oldest at the
 * top): the bands run along one blue ramp, best grade darkest, with the band
 * names in a legend and the counts written out so colour is never the only cue.
 */
export function DistributionBars({ title, summary, bands, rows, noun }: {
  title: string;
  summary?: string | null;
  bands: string[];
  rows: Distribution[];
  noun: string;
}) {
  return (
    <View style={s.card}>
      <Text style={s.h2}>{title}</Text>
      {!!summary && <Text style={[s.small, { marginTop: 2 }]}>{summary}</Text>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 8 }}>
        {bands.map((b, i) => (
          <View key={b} style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
            <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: BAND_COLORS[i] }} />
            <Text style={s.small}>{b}</Text>
          </View>
        ))}
      </View>
      <View style={{ marginTop: 10, gap: 12 }}>
        {rows.map((r) => (
          <View
            key={r.key}
            accessible
            accessibilityLabel={`${r.label}: ${bands.map((b, i) => `${b} ${pct(r.counts[i]!, r.total)}%`).join(", ")}, ${r.total} ${noun}`}
          >
            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 12.5, color: t.appSurface.ink }}>
                {r.label}<Text style={s.faint}>{r.sublabel ? `  ${r.sublabel}` : ""}</Text>
              </Text>
              <Text style={[s.faint, s.mono]}>{r.total}</Text>
            </View>
            <View style={{ flexDirection: "row", height: 14, borderRadius: 4, overflow: "hidden", marginTop: 4, backgroundColor: t.appSurface.lineSoft }}>
              {r.counts.map((c, i) => c > 0 && <View key={bands[i]} style={{ flex: c, backgroundColor: BAND_COLORS[i] }} />)}
            </View>
            <Text style={[s.faint, { marginTop: 3 }]}>
              {r.counts.map((c, i) => (c > 0 ? `${bands[i]} ${c}` : null)).filter(Boolean).join(" · ")}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
