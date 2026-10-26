import {
  daysOverdue, formatShortDate, isOverdue, ISSUE_STATUS_LABEL, ITEM_CONDITION_LABEL, sortIssues, type InventoryIssueRow,
} from "@figbloom/shared";
import { Badge } from "./ui/Badge";
import { Cell, DataTable } from "./ui/DataTable";
import { TableSkeleton } from "./ui/Skeleton";
import { StatRow } from "./ui/StatCard";

/**
 * What someone has been issued from the school's inventory, read-only: a
 * teacher's own, or a learner's (for the learner and their family). Out
 * first with anything overdue on top, then what's been handed back.
 */
export function IssuedItems({ rows, loading, error, whose }: {
  rows: InventoryIssueRow[] | null;
  loading: boolean;
  error: Error | null;
  /** "you" or a learner's first name, for the empty state. */
  whose: string;
}) {
  if (error) {
    return (
      <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
        <span aria-hidden>✕</span>Could not load issued items: {error.message}
      </p>
    );
  }
  if (loading || !rows) return <TableSkeleton rows={4} />;

  const sorted = sortIssues(rows);
  const out = sorted.filter((r) => r.status === "out");
  const overdue = out.filter((r) => isOverdue(r));
  const issuedOn = (iso: string) => formatShortDate(iso.slice(0, 10));
  const yourself = whose === "you";

  return (
    <div className="grid gap-5">
      <StatRow stats={[
        { label: "With " + (yourself ? "you" : whose), value: out.reduce((a, r) => a + r.quantity, 0).toLocaleString(), sub: "items out now" },
        { label: "Overdue", value: overdue.length.toLocaleString(), sub: "past their return date", alarming: overdue.length > 0 },
      ]} />
      <DataTable
        columns={[
          { key: "item", header: "Item", width: "1.6fr", render: (r: InventoryIssueRow) => <Cell sub={r.assetTag ?? undefined}>{r.itemName}{r.quantity > 1 ? ` × ${r.quantity}` : ""}</Cell> },
          { key: "issued", header: "Issued", render: (r: InventoryIssueRow) => <span className="text-[13px]">{issuedOn(r.issued_at)}</span> },
          {
            key: "due", header: "Due back",
            render: (r: InventoryIssueRow) => {
              if (r.status !== "out") return <span className="text-[13px] text-ink-faint">{r.closed_at ? issuedOn(r.closed_at) : "—"}</span>;
              const late = daysOverdue(r);
              return late > 0
                ? <Badge tone="warn">{late} day{late === 1 ? "" : "s"} overdue</Badge>
                : <span className="text-[13px]">{r.due_on ? formatShortDate(r.due_on) : "No date"}</span>;
            },
          },
          {
            key: "status", header: "", align: "right",
            render: (r: InventoryIssueRow) => (
              <Badge tone={r.status === "out" ? "info" : r.status === "returned" ? "ok" : "warn"}>
                {ISSUE_STATUS_LABEL[r.status]}{r.returned_condition && r.status !== "lost" ? ` · ${ITEM_CONDITION_LABEL[r.returned_condition].toLowerCase()}` : ""}
              </Badge>
            ),
          },
        ]}
        rows={sorted}
        rowKey={(r) => r.id}
        minWidth="560px"
        empty={{
          title: "Nothing issued",
          body: yourself
            ? "Textbooks, equipment and anything else the school hands you will be listed here."
            : `Textbooks and anything else the school hands ${whose} will be listed here, with when it's due back.`,
        }}
      />
    </div>
  );
}
