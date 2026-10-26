import { useState } from "react";
import { ChartFrame, ChartTable, fmt, truncate, useWidth } from "./ChartFrame";

export interface Bar { key: string; label: string; value: number; detail?: string }

interface Props {
  title: string;
  summary?: string | null;
  /** In the order to draw them: callers sort. */
  bars: Bar[];
  max?: number;
  valueHeader: string;
}

const ROW = 30;
const BAR = 18;
const LABEL_W = 132;
const VALUE_W = 44;

/**
 * Comparing one measure across categories (subjects in one exam): horizontal
 * bars from a shared zero, one hue, each value labelled at its end.
 */
export function BarList({ title, summary, bars, max = 100, valueHeader }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const plotW = Math.max(width - LABEL_W - VALUE_W, 40);

  const table = (
    <ChartTable caption={title} head={["", valueHeader, ...(bars.some((b) => b.detail) ? [""] : [])]} rows={bars.map((b) => [b.label, fmt(b.value), ...(b.detail ? [b.detail] : [])])} />
  );

  return (
    <ChartFrame title={title} summary={summary} table={table}>
      <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={bars.length * ROW} role="img" aria-label={`${title}. ${bars.map((b) => `${b.label} ${fmt(b.value)}`).join(", ")}.`}>
            <line x1={LABEL_W} x2={LABEL_W} y1={0} y2={bars.length * ROW} stroke="var(--viz-axis)" strokeWidth={1} />
            {bars.map((b, i) => {
              const w = Math.max((b.value / max) * plotW, 6);
              const y = i * ROW + (ROW - BAR) / 2;
              return (
                <g key={b.key} onMouseEnter={() => setHover(i)}>
                  <rect x={0} y={i * ROW} width={width} height={ROW} fill="transparent" />
                  <text x={LABEL_W - 10} y={y + BAR / 2} dy="0.32em" textAnchor="end" fontSize={12} fill="var(--viz-ink)">{truncate(b.label, 18)}</text>
                  {/* Square at the baseline, rounded at the data end. */}
                  <path
                    data-mark
                    d={`M${LABEL_W},${y} h${w - 4} a4,4 0 0 1 4,4 v${BAR - 8} a4,4 0 0 1 -4,4 h${-(w - 4)} z`}
                    fill="var(--viz-1)"
                    opacity={hover !== null && hover !== i ? 0.55 : 1}
                  />
                  <text x={LABEL_W + w + 6} y={y + BAR / 2} dy="0.32em" fontSize={11} fontWeight={600} fill="var(--viz-ink)" style={{ fontVariantNumeric: "tabular-nums" }}>{fmt(b.value)}</text>
                </g>
              );
            })}
          </svg>
        )}
        {hover !== null && bars[hover]?.detail && (
          <div className="viz-tooltip" role="status" style={{ left: LABEL_W, top: (hover + 1) * ROW }}>
            <div className="font-semibold">{bars[hover]!.label}</div>
            <div>{valueHeader}: <span className="font-mono font-semibold">{fmt(bars[hover]!.value)}</span></div>
            <div className="text-[11px]" style={{ color: "var(--viz-muted)" }}>{bars[hover]!.detail}</div>
          </div>
        )}
      </div>
    </ChartFrame>
  );
}
