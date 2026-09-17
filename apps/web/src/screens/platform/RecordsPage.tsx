import { useState, type ReactNode } from "react";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, Mono, type Column } from "../../components/ui/DataTable";
import { Skeleton, TableSkeleton } from "../../components/ui/Skeleton";
import { StatRow, type Stat } from "../../components/ui/StatCard";
import { PageHead } from "../../components/ConsoleShell";
import { useToast } from "../../components/ui/Toast";

export interface RecordRow {
  id: string;
  cells: ReactNode[];
  /** Chip filters match on these, so a chip can never contradict a stat card. */
  tags: string[];
}

export interface RecordsSpec {
  eyebrow: string;
  title: string;
  blurb: string;
  stats: Stat[];
  actions?: { label: string; primary?: boolean; onClick: () => void }[];
  columns: { key: string; header: string; align?: "left" | "right"; width?: string }[];
  rows: RecordRow[];
  chips?: { label: string; match?: string[] }[];
  minWidth?: string;
  extra?: ReactNode;
  empty?: { title: string; body: string; action?: ReactNode };
}

/**
 * Every cross-tenant list in the console is this shape: figures, optional
 * detail band, then one table. Consistency here is what lets a support agent
 * move between Invoices and Incidents without re-reading the page.
 *
 * `loading`/`error` are separate from `spec` on purpose — a caller mid-fetch
 * has no real stats/columns/rows yet, and passing empty arrays for those used
 * to fall straight through to the table's "nothing matches" empty state
 * (wrong: that copy means "you filtered everything out", not "still
 * loading"). While `loading` is true, only `eyebrow`/`title` from `spec` are
 * read — the rest can be empty placeholders.
 */
export function RecordsPage({ spec, loading, error }: { spec: RecordsSpec; loading?: boolean; error?: string }) {
  const chips = spec.chips ?? [];
  const [active, setActive] = useState(chips[0]?.label ?? "All");
  const toast = useToast();

  if (loading) {
    return (
      <>
        <PageHead eyebrow={spec.eyebrow} title={spec.title} />
        <div className="px-7 py-6">
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            {Array.from({ length: spec.stats.length || 4 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-lg" />)}
          </div>
          <div className="mt-5"><TableSkeleton rows={6} /></div>
        </div>
      </>
    );
  }

  if (error) {
    return (
      <>
        <PageHead eyebrow={spec.eyebrow} title={spec.title} />
        <div className="px-7 py-6">
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load: {error}
          </p>
        </div>
      </>
    );
  }

  const chip = chips.find((c) => c.label === active);
  const rows = !chip || !chip.match ? spec.rows : spec.rows.filter((r) => chip.match!.some((m) => r.tags.includes(m)));

  const columns: Column<RecordRow>[] = spec.columns.map((c, i) => ({
    ...c,
    render: (row) => row.cells[i],
  }));

  return (
    <>
      <PageHead
        eyebrow={spec.eyebrow}
        title={spec.title}
        blurb={spec.blurb}
        actions={spec.actions?.map((a) => (
          <Button key={a.label} variant={a.primary ? "accent" : "secondary"} onClick={a.onClick}>{a.label}</Button>
        ))}
      />
      <div className="px-7 py-6">
        <StatRow stats={spec.stats} />
        {spec.extra && <div className="mt-5">{spec.extra}</div>}
        <div className="mt-5">
          <DataTable
            title={spec.title}
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            minWidth={spec.minWidth}
            empty={spec.empty ?? {
              title: "Nothing matches this filter",
              body: "That is usually good news. Switch back to the first filter to see everything.",
            }}
            filters={
              chips.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {chips.map((c) => (
                    <button
                      key={c.label}
                      onClick={() => setActive(c.label)}
                      className="rounded-full px-2.5 py-1 text-[11.5px]"
                      style={active === c.label ? { background: "#17402A", color: "#fff" } : { background: "#EEF1EE", color: "#5F6B62" }}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              )
            }
          />
        </div>
      </div>
      <span className="hidden">{/* keeps toast in scope for row actions */}{typeof toast}</span>
    </>
  );
}

export { Badge, Cell, Mono, Button };
export type { Tone };
