import { useState } from "react";
import type { Distribution } from "@figbloom/shared";
import { ChartFrame, ChartTable, truncate, useWidth, type LegendItem } from "./ChartFrame";

/** Best band first and strongest; four-band rubrics use the first four. */
const BAND_COLORS = ["var(--viz-band-1)", "var(--viz-band-2)", "var(--viz-band-3)", "var(--viz-band-4)", "var(--viz-band-5)"];

interface Props {
  title: string;
  summary?: string | null;
  /** Band names, best first: "A".."E", or "EE".."BE". */
  bands: string[];
  rows: Distribution[];
  /** What a count is: "marks", "judgements". */
  noun: string;
}

const BAR = 20;
const ROW = 38;
const LABEL_W = 116;
const TOTAL_W = 56;
const GAP = 2;

/**
 * Grade (or rubric level) distribution over time: one 100%-stacked bar per
 * exam or month, oldest at the top, bands in a single ordered blue ramp with
 * a 2px gap between segments.
 */
export function DistributionChart({ title, summary, bands, rows, noun }: Props) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ row: number; band: number; x: number; y: number } | null>(null);
  const barW = Math.max(width - LABEL_W - TOTAL_W, 40);
  const legend: LegendItem[] = bands.map((b, i) => ({ name: b, color: BAND_COLORS[i]! }));

  const table = (
    <ChartTable
      caption={title}
      head={["", ...bands, "Total"]}
      rows={rows.map((r) => [r.sublabel ? `${r.label} · ${r.sublabel}` : r.label, ...r.counts.map((c) => `${c} (${pct(c, r.total)}%)`), r.total])}
    />
  );

  return (
    <ChartFrame title={title} summary={summary} legend={legend} table={table}>
      <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
        {width > 0 && (
          <svg width={width} height={rows.length * ROW} role="img" aria-label={`${title}. ${rows.map((r) => `${r.label}: ${bands.map((b, i) => `${b} ${pct(r.counts[i]!, r.total)}%`).join(", ")}`).join("; ")}.`}>
            {rows.map((r, ri) => {
              let at = LABEL_W;
              const y = ri * ROW + (ROW - BAR) / 2;
              const live = r.counts.filter((c) => c > 0).length;
              const usable = barW - GAP * Math.max(live - 1, 0);
              return (
                <g key={r.key}>
                  <text x={0} y={y + BAR / 2 - (r.sublabel ? 5 : 0)} dy="0.32em" fontSize={12} fill="var(--viz-ink)">{truncate(r.label, 17)}</text>
                  {r.sublabel && <text x={0} y={y + BAR / 2 + 8} dy="0.32em" fontSize={10} fill="var(--viz-muted)">{truncate(r.sublabel, 19)}</text>}
                  {r.counts.map((c, bi) => {
                    if (c === 0) return null;
                    const w = (c / r.total) * usable;
                    const segX = at;
                    at += w + GAP;
                    return (
                      <rect
                        key={bi}
                        data-mark
                        x={segX}
                        y={y}
                        width={Math.max(w, 1)}
                        height={BAR}
                        rx={bi === firstLive(r.counts) || bi === lastLive(r.counts) ? 4 : 0}
                        fill={BAND_COLORS[bi]}
                        opacity={hover && (hover.row !== ri || hover.band !== bi) ? 0.55 : 1}
                        onMouseEnter={() => setHover({ row: ri, band: bi, x: segX + w / 2, y })}
                      />
                    );
                  })}
                  <text x={width} y={y + BAR / 2} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--viz-muted)" style={{ fontVariantNumeric: "tabular-nums" }}>{r.total}</text>
                </g>
              );
            })}
          </svg>
        )}
        {hover && rows[hover.row] && (
          <div className="viz-tooltip" role="status" style={{ left: Math.min(Math.max(hover.x - 75, 0), Math.max(width - 170, 0)), top: hover.y + BAR + 6 }}>
            <div className="font-semibold">{rows[hover.row]!.label}{rows[hover.row]!.sublabel ? ` · ${rows[hover.row]!.sublabel}` : ""}</div>
            <div className="mt-1 flex items-center gap-1.5">
              <span className="viz-swatch" style={{ background: BAND_COLORS[hover.band] }} aria-hidden />
              <span>{bands[hover.band]}</span>
              <span className="ml-auto font-mono font-semibold tabular-nums">{rows[hover.row]!.counts[hover.band]} {noun}</span>
            </div>
            <div className="text-[11px]" style={{ color: "var(--viz-muted)" }}>
              {pct(rows[hover.row]!.counts[hover.band]!, rows[hover.row]!.total)}% of {rows[hover.row]!.total}
            </div>
          </div>
        )}
      </div>
      <p className="mt-1 text-right text-[11px] text-ink-faint">Total {noun} per bar on the right</p>
    </ChartFrame>
  );
}

const pct = (n: number, total: number) => (total ? Math.round((n / total) * 100) : 0);
const firstLive = (counts: number[]) => counts.findIndex((c) => c > 0);
const lastLive = (counts: number[]) => counts.length - 1 - [...counts].reverse().findIndex((c) => c > 0);
