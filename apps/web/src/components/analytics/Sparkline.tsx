import "./charts.css";

interface Props {
  values: number[];
  /** Read out instead of the picture: "Use by week, 12 to 30 kg". */
  label: string;
  width?: number;
  height?: number;
  /** Bars instead of a line: for counts per period where a line would suggest a trend between them. */
  bars?: boolean;
}

/**
 * A word-sized trend (use per item by week, spend by month). Decorative to a
 * screen reader except for its label; the numbers it summarises are always
 * written next to it, so nothing depends on seeing it.
 */
export function Sparkline({ values, label, width = 84, height = 24, bars = false }: Props) {
  if (values.length === 0) return <span className="text-ink-faint">—</span>;
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pad = 2;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const x = (i: number) => pad + (values.length > 1 ? (i / (values.length - 1)) * w : w / 2);
  const y = (v: number) => pad + h - ((v - min) / span) * h;
  const last = values.length - 1;
  return (
    <svg className="viz-root inline-block align-middle" width={width} height={height} role="img" aria-label={label}>
      <title>{label}</title>
      {bars ? values.map((v, i) => {
        const bw = Math.max(2, w / values.length - 2);
        const bx = pad + (i * w) / values.length + 1;
        const bh = Math.max(v > 0 ? 1.5 : 0, ((v - min) / span) * h);
        return <rect key={i} x={bx} y={pad + h - bh} width={bw} height={bh} rx={1} fill={i === last ? "var(--viz-1)" : "var(--viz-band-4, var(--viz-1))"} />;
      }) : (
        <>
          <polyline points={values.map((v, i) => `${x(i)},${y(v)}`).join(" ")} fill="none" stroke="var(--viz-1)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={x(last)} cy={y(values[last]!)} r={2.5} fill="var(--viz-1)" />
        </>
      )}
    </svg>
  );
}
