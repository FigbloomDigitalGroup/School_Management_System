import { useState, type KeyboardEvent } from "react";
import { ChartFrame, ChartTable, fmt, SERIES_COLORS, truncate, useWidth, type LegendItem } from "./ChartFrame";

export interface LinePoint { label: string; sublabel?: string }
export interface LineSeries { key: string; name: string; values: (number | null)[] }

interface Props {
  title: string;
  summary?: string | null;
  /** The x axis, oldest first: one per exam or semester. */
  points: LinePoint[];
  /** At most four; each takes the next colour slot in order. */
  series: LineSeries[];
  yMin?: number;
  yMax?: number;
  yTicks?: number[];
  /** Digits after the point in labels and the table. */
  digits?: number;
  unit?: string;
  controls?: React.ReactNode;
}

const H = 240;
const PAD = { top: 14, right: 16, bottom: 40, left: 34 };
const LABEL_GAP = 14;

/**
 * Change over time: 2px lines over exams, a gap where there's no value (a
 * paper not sat is not a zero), end dots carrying direct labels, and a
 * crosshair + tooltip on hover or arrow keys.
 */
export function LineChart({ title, summary, points, series, yMin = 0, yMax = 100, yTicks = [0, 25, 50, 75, 100], digits = 1, unit = "", controls }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const shown = series.slice(0, SERIES_COLORS.length);
  // Room on the right for the end labels when they're drawn.
  const labelled = shown.length <= 4;
  const right = labelled ? Math.min(140, Math.max(...shown.map((s) => s.name.length), 0) * 6.6 + 18) : PAD.right;
  const plotW = Math.max(width - PAD.left - right, 40);
  const plotH = H - PAD.top - PAD.bottom;
  const step = points.length > 1 ? plotW / (points.length - 1) : 0;
  const x = (i: number) => PAD.left + (points.length > 1 ? i * step : plotW / 2);
  const y = (v: number) => PAD.top + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const legend: LegendItem[] = shown.map((s, i) => ({ name: s.name, color: SERIES_COLORS[i]!, line: true }));

  // End labels at each series' last value, nudged apart so none overlap.
  const ends = shown
    .map((s, i) => {
      const last = s.values.reduce<number | null>((acc, v, idx) => (v === null ? acc : idx), null);
      return last === null ? null : { i, idx: last, v: s.values[last]!, y: y(s.values[last]!) };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) {
    if (ends[k]!.y - ends[k - 1]!.y < LABEL_GAP) ends[k]!.y = ends[k - 1]!.y + LABEL_GAP;
  }

  function onKey(e: KeyboardEvent) {
    if (!points.length) return;
    if (e.key === "ArrowRight") { e.preventDefault(); setActive((a) => Math.min((a ?? -1) + 1, points.length - 1)); }
    if (e.key === "ArrowLeft") { e.preventDefault(); setActive((a) => Math.max((a ?? points.length) - 1, 0)); }
    if (e.key === "Escape") setActive(null);
  }

  // Thin out x labels so they never collide: about one per 70px.
  const every = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotW / 70))));
  const table = (
    <ChartTable
      caption={title}
      head={["Exam", ...shown.map((s) => s.name)]}
      rows={points.map((p, i) => [p.sublabel ? `${p.label} · ${p.sublabel}` : p.label, ...shown.map((s) => fmt(s.values[i], digits))])}
    />
  );

  const describe = `${title}. ${shown.map((s) => {
    const vals = s.values.filter((v): v is number => v !== null);
    return vals.length ? `${s.name}: from ${fmt(vals[0], digits)} to ${fmt(vals[vals.length - 1], digits)}${unit}` : `${s.name}: no values`;
  }).join("; ")}. Use the arrow keys to read each point, or Show as table.`;

  return (
    <ChartFrame title={title} summary={summary} legend={legend} table={table} controls={controls}>
      <div ref={ref} className="relative" onMouseLeave={() => setActive(null)}>
        {width > 0 && (
          <svg
            width={width}
            height={H}
            role="img"
            aria-label={describe}
            tabIndex={0}
            onKeyDown={onKey}
            onBlur={() => setActive(null)}
            className="block outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f26a1b]"
          >
            {yTicks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={PAD.left + plotW} y1={y(t)} y2={y(t)} stroke={t === yMin ? "var(--viz-axis)" : "var(--viz-grid)"} strokeWidth={1} />
                <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--viz-muted)" style={{ fontVariantNumeric: "tabular-nums" }}>{t}</text>
              </g>
            ))}
            {points.map((p, i) => (i % every === 0 || i === points.length - 1) && (
              <g key={i}>
                <text x={x(i)} y={H - PAD.bottom + 16} textAnchor="middle" fontSize={11} fill="var(--viz-ink-2)">{truncate(p.label, 14)}</text>
                {p.sublabel && <text x={x(i)} y={H - PAD.bottom + 30} textAnchor="middle" fontSize={10} fill="var(--viz-muted)">{truncate(p.sublabel, 16)}</text>}
              </g>
            ))}
            {active !== null && (
              <line x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--viz-axis)" strokeWidth={1} />
            )}
            {shown.map((s, si) => (
              <g key={s.key} data-mark>
                {segments(s.values).map((seg, k) => (
                  seg.length > 1
                    ? <polyline key={k} points={seg.map((i) => `${x(i)},${y(s.values[i]!)}`).join(" ")} fill="none" stroke={SERIES_COLORS[si]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                    : <circle key={k} cx={x(seg[0]!)} cy={y(s.values[seg[0]!]!)} r={4} fill={SERIES_COLORS[si]} stroke="var(--viz-surface)" strokeWidth={2} />
                ))}
                {active !== null && s.values[active] !== null && s.values[active] !== undefined && (
                  <circle cx={x(active)} cy={y(s.values[active]!)} r={5} fill={SERIES_COLORS[si]} stroke="var(--viz-surface)" strokeWidth={2} />
                )}
              </g>
            ))}
            {labelled && ends.map((e) => (
              <g key={e.i}>
                <circle cx={x(e.idx)} cy={y(e.v)} r={4} fill={SERIES_COLORS[e.i]} stroke="var(--viz-surface)" strokeWidth={2} data-mark />
                <text x={x(e.idx) + 9} y={e.y} dy="0.32em" fontSize={11} fill="var(--viz-ink-2)">
                  {truncate(shown[e.i]!.name, 16)} <tspan fontWeight={600} fill="var(--viz-ink)">{fmt(e.v, digits)}</tspan>
                </text>
              </g>
            ))}
            {/* Hit columns wider than any mark: hovering anywhere over an exam reads it. */}
            {points.map((_, i) => (
              <rect
                key={i}
                x={points.length > 1 ? x(i) - step / 2 : PAD.left}
                width={points.length > 1 ? step : plotW}
                y={PAD.top}
                height={plotH}
                fill="transparent"
                onMouseEnter={() => setActive(i)}
              />
            ))}
          </svg>
        )}
        {active !== null && points[active] && (
          <div
            className="viz-tooltip"
            style={{ left: Math.min(Math.max(x(active) + 12, 0), Math.max(width - 200, 0)), top: PAD.top }}
            role="status"
          >
            <div className="font-semibold">{points[active]!.label}</div>
            {points[active]!.sublabel && <div className="text-[11px]" style={{ color: "var(--viz-muted)" }}>{points[active]!.sublabel}</div>}
            <ul className="mt-1.5 space-y-0.5">
              {shown.map((s, si) => (
                <li key={s.key} className="flex items-center gap-1.5">
                  <span className="viz-swatch viz-swatch-line" style={{ background: SERIES_COLORS[si] }} aria-hidden />
                  <span className="min-w-0 flex-1 truncate" style={{ color: "var(--viz-ink-2)" }}>{s.name}</span>
                  <span className="font-mono font-semibold tabular-nums">{fmt(s.values[active], digits)}{s.values[active] !== null && s.values[active] !== undefined ? unit : ""}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </ChartFrame>
  );
}

/** Runs of consecutive indices that have a value; a null breaks the line. */
function segments(values: (number | null)[]): number[][] {
  const out: number[][] = [];
  let run: number[] = [];
  values.forEach((v, i) => {
    if (v === null) { if (run.length) out.push(run); run = []; }
    else run.push(i);
  });
  if (run.length) out.push(run);
  return out;
}
