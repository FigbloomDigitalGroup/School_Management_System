import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Skeleton } from "./Skeleton";

export interface StatLinkProps {
  label: string;
  value: string;
  sub?: ReactNode;
  /** Only for genuinely bad numbers. */
  alarming?: boolean;
  loading?: boolean;
  /** Where the card goes: its own page with the full list or chart. */
  to: string;
  /** A sparkline, severity badges: under the figure. */
  children?: ReactNode;
  /** Read out with the link: "Open the low stock list". */
  action?: string;
}

/**
 * A StatCard that is a link: the overview widgets on the stock screens, each
 * opening a page of its own. The whole card is one link with a visible arrow,
 * so it reads as one, by mouse, keyboard or screen reader.
 */
export function StatLink({ label, value, sub, alarming, loading, to, children, action }: StatLinkProps) {
  return (
    <Link
      to={to}
      aria-label={loading ? `${label}, loading` : `${label}: ${value}. ${action ?? "Open"}`}
      className="group flex min-w-0 flex-col rounded-lg border border-line bg-white px-4 py-3.5 transition-colors hover:border-[#9DB5A6] hover:bg-page focus-visible:border-[#9DB5A6]"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-micro tracking-[0.1em] text-ink-faint">{label.toUpperCase()}</span>
        <span aria-hidden className="text-[13px] text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-ink">→</span>
      </div>
      {loading ? (
        <>
          <Skeleton className="mt-2.5 h-6 w-20" />
          <Skeleton className="mt-2 h-2.5 w-28" />
        </>
      ) : (
        <>
          <div className="mt-1.5 font-mono text-2xl tracking-tight" style={{ color: alarming ? "#D9550C" : undefined }}>{value}</div>
          {sub && <div className="mt-0.5 text-[11.5px] text-ink-faint">{sub}</div>}
          {children && <div className="mt-2">{children}</div>}
        </>
      )}
    </Link>
  );
}

/** Widgets flow like StatRow, a little wider so a sparkline fits. */
export function StatLinkGrid({ children }: { children: ReactNode }) {
  return <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>{children}</div>;
}
