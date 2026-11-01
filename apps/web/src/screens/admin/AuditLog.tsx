import { useState, type FormEvent } from "react";
import {
  AUDIT_CATEGORIES, AUDIT_PAGE_SIZE, auditChanges, auditValue, fetchAuditEvents,
  type AuditEvent, type AuditFilters,
} from "@figbloom/shared";
import { PageHead } from "../../components/ConsoleShell";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Cell, DataTable, Mono } from "../../components/ui/DataTable";
import { SelectField, TextField } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { TableSkeleton } from "../../components/ui/Skeleton";
import { useToast } from "../../components/ui/Toast";
import { useAsync } from "../../lib/useAsync";
import { useTenantSession } from "../../lib/sessionContext";

const CATEGORY_LABEL = Object.fromEntries(AUDIT_CATEGORIES.map((c) => [c.value, c.label])) as Record<AuditEvent["category"], string>;

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * The school's audit log: every change made in the console, written by the
 * database (20261104000000), newest first. Full admins, and anyone given the
 * "Audit log" area on Access & roles. Read only: nothing here can be changed
 * or removed, by anyone.
 */
export function AdminAuditLog() {
  const toast = useToast();
  const { tenant } = useTenantSession();
  const [filters, setFilters] = useState<AuditFilters>({ category: "", search: "", since: "" });
  const [searchDraft, setSearchDraft] = useState("");
  const { data: firstPage, loading, error } = useAsync(
    () => fetchAuditEvents(tenant.id, filters),
    [tenant.id, filters.category, filters.search, filters.since],
  );
  // later pages, for the filters they were loaded under
  const [more, setMore] = useState<{ key: string; rows: AuditEvent[]; done: boolean }>({ key: "", rows: [], done: false });
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<AuditEvent | null>(null);

  const key = `${tenant.id}|${filters.category}|${filters.search}|${filters.since}`;
  const extra = more.key === key ? more : { key, rows: [], done: false };
  const seen = new Set<string>();
  const rows = [...(firstPage ?? []), ...extra.rows].filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  const mayHaveMore = (firstPage?.length ?? 0) === AUDIT_PAGE_SIZE && !extra.done;

  async function loadMore() {
    setLoadingMore(true);
    try {
      const next = await fetchAuditEvents(tenant.id, filters, rows.length);
      setMore({ key, rows: [...extra.rows, ...next], done: next.length < AUDIT_PAGE_SIZE });
    } catch (err) {
      toast(err instanceof Error ? `Could not load more: ${err.message}` : "Could not load more.", "error");
    } finally {
      setLoadingMore(false);
    }
  }

  function search(e: FormEvent) {
    e.preventDefault();
    setFilters((f) => ({ ...f, search: searchDraft.trim() }));
  }

  const changes = open ? auditChanges(open.metadata) : [];

  return (
    <>
      <PageHead
        eyebrow="School"
        title="Audit log"
        blurb="Every change made in the school: who did it, when, and what changed. Read only: nothing here can be edited or removed. Give it to others from Access & roles."
      />

      <div className="px-7 py-6">
        {error ? (
          <p className="flex items-center gap-1.5 rounded-lg border border-warn-ink/30 bg-warn-ink/5 px-3 py-2.5 text-[12.5px] text-warn-ink">
            <span aria-hidden>✕</span>Could not load the audit log: {error.message}
          </p>
        ) : (
          <>
            <form onSubmit={search} className="mb-4 grid items-end gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
              <SelectField
                id="audit-category"
                label="Category"
                value={filters.category ?? ""}
                onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value as AuditFilters["category"] }))}
                options={[{ value: "", label: "Everything" }, ...AUDIT_CATEGORIES]}
              />
              <TextField
                id="audit-since"
                label="From"
                type="date"
                value={filters.since ?? ""}
                onChange={(e) => setFilters((f) => ({ ...f, since: e.target.value }))}
              />
              <TextField
                id="audit-search"
                label="Search"
                placeholder="A name, or what was done"
                value={searchDraft}
                onChange={(e) => setSearchDraft(e.target.value)}
              />
              <Button type="submit">Search</Button>
            </form>

            {loading && !firstPage ? (
              <TableSkeleton rows={8} />
            ) : (
              <DataTable
                title={`${rows.length.toLocaleString()}${mayHaveMore ? "+" : ""} events`}
                columns={[
                  { key: "when", header: "When", width: "1fr", render: (r: AuditEvent) => <Mono>{fmtWhen(r.created_at)}</Mono> },
                  { key: "who", header: "Who", width: "1.2fr", render: (r: AuditEvent) => <span className="text-[13px]">{r.actor_label}</span> },
                  { key: "what", header: "What", width: "2.4fr", render: (r: AuditEvent) => <Cell>{r.event}</Cell> },
                  {
                    key: "category", header: "", align: "right", width: "0.9fr",
                    render: (r: AuditEvent) => <Badge tone={r.category === "financial" ? "warn" : "info"}>{CATEGORY_LABEL[r.category] ?? r.category}</Badge>,
                  },
                ]}
                rows={rows}
                rowKey={(r) => r.id}
                onRowClick={setOpen}
                minWidth="760px"
                empty={{
                  title: filters.category || filters.search || filters.since ? "Nothing matches" : "Nothing logged yet",
                  body: filters.category || filters.search || filters.since
                    ? "Try another category, an earlier date, or a different search."
                    : "Changes made in the console appear here as they happen.",
                }}
              />
            )}

            {mayHaveMore && (
              <div className="mt-3 flex justify-center">
                <Button disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? "Loading…" : "Show older events"}</Button>
              </div>
            )}
          </>
        )}
      </div>

      <Modal
        open={open !== null}
        onClose={() => setOpen(null)}
        eyebrow={open ? `${CATEGORY_LABEL[open.category] ?? open.category} · ${fmtWhen(open.created_at)}` : undefined}
        title={open?.event ?? ""}
        blurb={open ? `By ${open.actor_label}` : undefined}
        width={720}
      >
        {changes.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead className="text-[11px] font-semibold text-ink-faint">
                <tr><th className="py-1.5 pr-3">Field</th><th className="py-1.5 pr-3">Was</th><th className="py-1.5">Now</th></tr>
              </thead>
              <tbody>
                {changes.map((c, i) => (
                  <tr key={i} className="border-t border-line align-top">
                    <td className="py-1.5 pr-3 font-medium">{c.field}</td>
                    {c.hidden ? (
                      <td colSpan={2} className="py-1.5 text-ink-faint">Changed (the value is kept out of the log)</td>
                    ) : (
                      <>
                        <td className="py-1.5 pr-3 break-all">{auditValue(c.from)}</td>
                        <td className="py-1.5 break-all">{auditValue(c.to)}</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <pre className="max-h-[360px] overflow-auto rounded-md bg-sunken p-3 text-[11.5px] leading-relaxed">
            {JSON.stringify(open?.metadata ?? {}, null, 2)}
          </pre>
        )}
      </Modal>
    </>
  );
}
