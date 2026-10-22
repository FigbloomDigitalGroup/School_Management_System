import { Skeleton } from "./Skeleton";

export interface Stat {
  label: string;
  value: string;
  sub?: string;
  /** Only for genuinely bad numbers — not for decoration. */
  alarming?: boolean;
  /** The figure is still loading: show a placeholder, never a 0 or "—" that reads as a real answer. */
  loading?: boolean;
}

export function StatCard({ label, value, sub, alarming, loading }: Stat) {
  if (loading) {
    return (
      <div className="min-w-0 rounded-lg border border-line bg-white px-4 py-3.5" aria-busy="true">
        <div className="font-mono text-micro tracking-[0.1em] text-ink-faint">{label.toUpperCase()}</div>
        <Skeleton className="mt-2.5 h-6 w-20" />
        {sub !== undefined && <Skeleton className="mt-2 h-2.5 w-28" />}
      </div>
    );
  }
  return (
    <div className="min-w-0 rounded-lg border border-line bg-white px-4 py-3.5">
      <div className="font-mono text-micro tracking-[0.1em] text-ink-faint">{label.toUpperCase()}</div>
      <div
        className="mt-1.5 font-mono text-2xl tracking-tight"
        style={{ color: alarming ? "#D9550C" : undefined }}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-[11.5px] text-ink-faint">{sub}</div>}
    </div>
  );
}

/** Never forces four across — cards flow and stop squishing at 180px. */
export function StatRow({ stats }: { stats: Stat[] }) {
  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
      {stats.map((s) => <StatCard key={s.label} {...s} />)}
    </div>
  );
}
