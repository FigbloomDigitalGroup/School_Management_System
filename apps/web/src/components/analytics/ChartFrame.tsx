import { useEffect, useRef, useState, type ReactNode } from "react";
import "./charts.css";

/** Categorical slots, in fixed order: a series keeps its colour whatever else is on the chart. */
export const SERIES_COLORS = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)"] as const;
export const MAX_SERIES = SERIES_COLORS.length;

export interface LegendItem { name: string; color: string; line?: boolean }

/** The element's width, kept current as the layout changes, so the SVG draws at real size and text stays crisp. */
export function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

interface Props {
  title: string;
  /** One line under the title: what the chart is saying, in words. */
  summary?: string | null;
  legend?: LegendItem[];
  /** The same numbers as a table: the reading that never depends on colour. */
  table: ReactNode;
  /** Above the plot, beside the legend: a subject picker and the like. */
  controls?: ReactNode;
  children: ReactNode;
}

/**
 * A titled card holding one chart: legend and controls in one row above the
 * plot, and a "Show as table" switch that swaps the plot for its numbers.
 */
export function ChartFrame({ title, summary, legend, table, controls, children }: Props) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className="viz-root rounded-lg border border-line bg-white">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-body font-semibold">{title}</h2>
          {summary && <p className="mt-0.5 text-[12.5px] text-ink-muted">{summary}</p>}
        </div>
        <button
          type="button"
          onClick={() => setAsTable((v) => !v)}
          aria-pressed={asTable}
          className="shrink-0 rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1 text-[12px] text-ink hover:bg-page"
        >
          {asTable ? "Show as chart" : "Show as table"}
        </button>
      </header>
      {(controls || (legend && legend.length > 1)) && !asTable && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 pt-3">
          {legend && legend.length > 1 ? (
            <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-muted" aria-label="Legend">
              {legend.map((l) => (
                <li key={l.name} className="flex items-center gap-1.5">
                  <span className={`viz-swatch ${l.line ? "viz-swatch-line" : ""}`} style={{ background: l.color }} aria-hidden />
                  {l.name}
                </li>
              ))}
            </ul>
          ) : <span />}
          {controls}
        </div>
      )}
      <div className="px-4 pb-4 pt-3">{asTable ? <div className="overflow-x-auto">{table}</div> : children}</div>
    </section>
  );
}

/** A plain numbers table for ChartFrame's table view. */
export function ChartTable({ caption, head, rows }: { caption: string; head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="w-full min-w-[360px] border-collapse text-[12.5px]">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={h + i} scope="col" className={`border-b border-line px-2 py-1.5 font-mono text-micro font-normal tracking-[0.1em] text-ink-muted ${i ? "text-right" : "text-left"}`}>
              {h.toUpperCase()}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, ri) => (
          <tr key={ri} className="border-b border-line-soft last:border-0">
            {r.map((c, i) => (
              i === 0
                ? <th key={i} scope="row" className="px-2 py-1.5 text-left font-medium">{c}</th>
                : <td key={i} className="px-2 py-1.5 text-right font-mono tabular-nums">{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** "62", "62.5", or "—" for a gap. */
export const fmt = (v: number | null | undefined, digits = 1): string =>
  v === null || v === undefined ? "—" : String(Math.round(v * 10 ** digits) / 10 ** digits);

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
