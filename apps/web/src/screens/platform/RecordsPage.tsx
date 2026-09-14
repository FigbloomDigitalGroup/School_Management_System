import { useState, type ReactNode } from "react";
import { Badge, type Tone } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, Mono, type Column } from "../../components/ui/DataTable";
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
 */
export function RecordsPage({ spec }: { spec: RecordsSpec }) {
  const chips = spec.chips ?? [];
  const [active, setActive] = useState(chips[0]?.label ?? "All");
  const toast = useToast();

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
