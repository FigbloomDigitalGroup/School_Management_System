import { useState } from "react";
import { ChartFrame, ChartTable, truncate, useWidth } from "./ChartFrame";

export interface Column { key: string; label: string; value: number; detail?: string }

interface Props {
  title: string;
  summary?: string | null;
  /** Oldest first. */
  columns: Column[];
  valueHeader: string;
  /** How a value reads in labels, the tooltip and the table ("KES 12,400"). */
  format: (v: number) => string;
  /** A short form for the labels above the bars ("12.4k"); defaults to format. */
  short?: (v: number) => string;
  /** Mark one column (this month) a little stronger. */
  highlight?: string;
  height?: number;
}

const PAD = { top: 22, right: 8, bottom: 28, left: 8 };

/**
 * One measure over time (spend per month): vertical bars from a shared zero,
 * one hue, every value written above its bar so the chart reads without
 * colour, and Show as table for the numbers.
 */
export function ColumnChart({ title, summary, columns, valueHeader, format, short = format, highlight, height = 200 }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...columns.map((c) => c.value));
  const plotW = Math.max(width - PAD.left - PAD.right, 40);
  const plotH = height - PAD.top - PAD.bottom;
  const slot = columns.length ? plotW / columns.length : plotW;
  const barW = Math.min(44, slot * 0.62);
  const table = <ChartTable caption={title} head={["", valueHeader, ...(columns.some((c) => c.detail) ? [""] : [])]} rows={columns.map((c) => [c.label, format(c.value), ...(c.detail ? [c.detail] : [])])} />;
  return (
    <ChartFrame title={title} summary={summary} table={table}>
      <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={`${title}. ${columns.map((c) => `${c.label} ${format(c.value)}`).join(", ")}.`}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke="var(--viz-axis)" strokeWidth={1} />
            {columns.map((c, i) => {
              const h = c.value > 0 ? Math.max((c.value / max) * plotH, 4) : 0;
              const x = PAD.left + i * slot + (slot - barW) / 2;
              const y = PAD.top + plotH - h;
              const strong = highlight === c.key;
              return (
                <g key={c.key} onMouseEnter={() => setHover(i)}>
                  <rect x={PAD.left + i * slot} y={0} width={slot} height={height} fill="transparent" />
                  {h > 0 && (
                    <path data-mark
                      d={`M${x},${y + h} v${-(h - 4)} a4,4 0 0 1 4,-4 h${barW - 8} a4,4 0 0 1 4,4 v${h - 4} z`}
                      fill={strong ? "var(--viz-band-1, var(--viz-1))" : "var(--viz-1)"}
                      opacity={hover !== null && hover !== i ? 0.55 : 1} />
                  )}
                  <text x={x + barW / 2} y={y - 6} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--viz-ink)" style={{ fontVariantNumeric: "tabular-nums" }}>{short(c.value)}</text>
                  <text x={x + barW / 2} y={height - 10} textAnchor="middle" fontSize={11} fill="var(--viz-ink-2)" fontWeight={strong ? 600 : 400}>{truncate(c.label, 10)}</text>
                </g>
              );
            })}
          </svg>
        )}
        {hover !== null && columns[hover] && (
          <div className="viz-tooltip" role="status" style={{ left: Math.min(PAD.left + hover * slot + slot / 2, Math.max(width - 180, 0)), top: 4 }}>
            <div className="font-semibold">{columns[hover]!.label}</div>
            <div>{valueHeader}: <span className="font-mono font-semibold">{format(columns[hover]!.value)}</span></div>
            {columns[hover]!.detail && <div className="text-[11px]" style={{ color: "var(--viz-muted)" }}>{columns[hover]!.detail}</div>}
          </div>
        )}
      </div>
    </ChartFrame>
  );
}

/** "12.4k", "1.2M", "830": short enough to sit above a bar. */
export function shortNumber(v: number): string {
  const a = Math.abs(v);
  if (a >= 1_000_000) return `${(v / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}M`;
  if (a >= 1_000) return `${(v / 1_000).toFixed(a >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(v));
}
