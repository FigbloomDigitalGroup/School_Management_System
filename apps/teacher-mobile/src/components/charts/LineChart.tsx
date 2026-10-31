import { useState } from "react";
import { GestureResponderEvent, Text, TouchableWithoutFeedback, View } from "react-native";
import Svg, { Circle, G, Line, Polyline, Text as SvgText } from "react-native-svg";
import { labelEvery, lastValueIndex, nearestIndex, spreadLabels, valueRuns } from "@figbloom/shared";
import { fmt, SERIES_COLORS, truncate, VIZ } from "./tokens";
import { useTheme } from "../../ui/ThemeContext";

export interface LinePoint { label: string; sublabel?: string }
export interface LineSeries { key: string; name: string; values: (number | null)[] }

const H = 200;
const PAD = { top: 12, right: 40, bottom: 38, left: 30 };
const LABEL_GAP = 13;
const TICKS = [0, 25, 50, 75, 100];

/**
 * Change over time, as on the web: 2px lines over exams, a gap where there is
 * no value (a paper not sat is not a zero), end dots with their value, a
 * legend, and a readout of one exam (tap the chart to read another; it starts
 * on the latest). Marks run 0 to 100.
 */
export function LineChart({ title, summary, points, series, digits = 1 }: {
  title: string;
  summary?: string | null;
  /** The x axis, oldest first: one per exam. */
  points: LinePoint[];
  /** At most four; each takes the next colour in order. */
  series: LineSeries[];
  digits?: number;
}) {
  const { t, s, scheme } = useTheme();
  const viz = VIZ[scheme];
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const shown = series.slice(0, SERIES_COLORS.length);

  const plotW = Math.max(width - PAD.left - PAD.right, 40);
  const plotH = H - PAD.top - PAD.bottom;
  const step = points.length > 1 ? plotW / (points.length - 1) : 0;
  const x = (i: number) => PAD.left + (points.length > 1 ? i * step : plotW / 2);
  const y = (v: number) => PAD.top + plotH - (Math.min(Math.max(v, 0), 100) / 100) * plotH;
  const active = Math.min(picked ?? points.length - 1, points.length - 1);

  const ends = shown.map((sr, i) => ({ i, idx: lastValueIndex(sr.values) })).filter((e): e is { i: number; idx: number } => e.idx !== null);
  const endYs = spreadLabels(ends.map((e) => y(shown[e.i]!.values[e.idx]!)), LABEL_GAP);
  const every = labelEvery(points.length, plotW, 64);

  function onPress(e: GestureResponderEvent) {
    setPicked(nearestIndex(e.nativeEvent.locationX, PAD.left, step, points.length));
  }

  const describe = `${title}. ${shown.map((sr) => {
    const vals = sr.values.filter((v): v is number => v !== null);
    return vals.length ? `${sr.name}: from ${fmt(vals[0], digits)} to ${fmt(vals[vals.length - 1], digits)}` : `${sr.name}: no values`;
  }).join("; ")}.`;
  const at = points[active];

  return (
    <View style={s.card}>
      <Text style={s.h2}>{title}</Text>
      {!!summary && <Text style={[s.small, { marginTop: 2 }]}>{summary}</Text>}

      <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)} style={{ marginTop: 10 }}>
        {width > 0 && points.length > 0 && (
          <TouchableWithoutFeedback onPress={onPress} accessibilityRole="image" accessibilityLabel={describe}>
            <View>
              <Svg width={width} height={H}>
                {TICKS.map((tick) => (
                  <G key={tick}>
                    <Line x1={PAD.left} x2={PAD.left + plotW} y1={y(tick)} y2={y(tick)} stroke={tick === 0 ? viz.axis : viz.grid} strokeWidth={1} />
                    <SvgText x={PAD.left - 6} y={y(tick) + 4} textAnchor="end" fontSize={10} fill={viz.muted}>{tick}</SvgText>
                  </G>
                ))}
                {points.map((p, i) => (i % every === 0 || i === points.length - 1) && (
                  <G key={i}>
                    <SvgText x={x(i)} y={H - PAD.bottom + 14} textAnchor="middle" fontSize={10} fill={viz.ink2}>{truncate(p.label, 12)}</SvgText>
                    {!!p.sublabel && <SvgText x={x(i)} y={H - PAD.bottom + 26} textAnchor="middle" fontSize={9} fill={viz.muted}>{truncate(p.sublabel, 14)}</SvgText>}
                  </G>
                ))}
                {points.length > 1 && <Line x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + plotH} stroke={viz.axis} strokeWidth={1} />}
                {shown.map((sr, si) => valueRuns(sr.values).map((run, k) => (
                  run.length > 1
                    ? <Polyline key={`${sr.key}-${k}`} points={run.map((i) => `${x(i)},${y(sr.values[i]!)}`).join(" ")} fill="none" stroke={SERIES_COLORS[si]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                    : <Circle key={`${sr.key}-${k}`} cx={x(run[0]!)} cy={y(sr.values[run[0]!]!)} r={4} fill={SERIES_COLORS[si]} stroke={viz.surface} strokeWidth={2} />
                )))}
                {shown.map((sr, si) => sr.values[active] !== null && sr.values[active] !== undefined && (
                  <Circle key={`on-${sr.key}`} cx={x(active)} cy={y(sr.values[active]!)} r={5} fill={SERIES_COLORS[si]} stroke={viz.surface} strokeWidth={2} />
                ))}
                {ends.map((e, k) => (
                  <G key={e.i}>
                    <Circle cx={x(e.idx)} cy={y(shown[e.i]!.values[e.idx]!)} r={3.5} fill={SERIES_COLORS[e.i]} stroke={viz.surface} strokeWidth={1.5} />
                    <SvgText x={x(e.idx) + 8} y={endYs[k]! + 4} fontSize={11} fontWeight="600" fill={viz.ink}>{fmt(shown[e.i]!.values[e.idx], digits)}</SvgText>
                  </G>
                ))}
              </Svg>
            </View>
          </TouchableWithoutFeedback>
        )}
      </View>

      {!!at && (
        <View style={{ marginTop: 6, paddingTop: 8, borderTopWidth: 1, borderTopColor: t.appSurface.lineSoft }} accessibilityLiveRegion="polite">
          <Text style={{ fontSize: 12.5, fontWeight: "600", color: t.appSurface.ink }}>
            {at.label}{at.sublabel ? ` · ${at.sublabel}` : ""}
          </Text>
          {shown.map((sr, si) => (
            <View key={sr.key} style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 }}>
              <View style={{ width: 14, height: 3, borderRadius: 2, backgroundColor: SERIES_COLORS[si] }} />
              <Text numberOfLines={1} style={{ flex: 1, fontSize: 12.5, color: t.appSurface.inkMuted }}>{sr.name}</Text>
              <Text style={[s.mono, { color: t.appSurface.ink, fontWeight: "600" }]}>{fmt(sr.values[active], digits)}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}
