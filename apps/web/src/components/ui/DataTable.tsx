import { useEffect, useState, type ReactNode } from "react";
import { Pagination } from "./Pagination";

/** Lists longer than this page by themselves. */
export const DEFAULT_PAGE_SIZE = 15;

export interface Column<T> {
  key: string;
  header: string;
  align?: "left" | "right";
  /** Grid fraction, e.g. "1.6fr". */
  width?: string;
  render: (row: T) => ReactNode;
}

interface Props<T> {
  title?: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Rendered when rows is empty — always in product voice, never "No data". */
  empty: { title: string; body: string; action?: ReactNode };
  filters?: ReactNode;
  minWidth?: string;
  /**
   * Rows per page once the list is longer than that (15 by default). 0 turns
   * paging off: a list the caller pages on the server, or one that must be
   * seen whole (a mark-entry sheet).
   */
  pageSize?: number;
  /** What the rows are, for the pager's screen-reader label: "learners". */
  rowsLabel?: string;
}

/**
 * One table for every console list. Scrolls horizontally rather than
 * compressing columns, and every column is minmax(0,…) so a long school name
 * cannot stretch the grid.
 */
export function DataTable<T>({ title, columns, rows, rowKey, onRowClick, empty, filters, minWidth = "760px", pageSize = DEFAULT_PAGE_SIZE, rowsLabel }: Props<T>) {
  const grid = columns.map((c) => `minmax(0, ${c.width ?? "1fr"})`).join(" ");
  const [size, setSize] = useState(pageSize);
  const [page, setPage] = useState(1);
  const paged = pageSize > 0 && rows.length > Math.min(pageSize, size);
  // Back to page 1 when the list itself changes (a filter, a search), not on every re-render with a new array.
  const signature = `${rows.length}|${rows.length ? rowKey(rows[0]!) : ""}|${rows.length ? rowKey(rows[rows.length - 1]!) : ""}`;
  useEffect(() => { setPage(1); }, [signature, size]);
  const lastPage = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(page, lastPage);
  const shown = paged ? rows.slice((current - 1) * size, current * size) : rows;

  return (
    <section className="overflow-hidden rounded-lg border border-line bg-white">
      {(title || filters) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          {title && <h2 className="text-body font-semibold">{title}</h2>}
          {filters}
        </header>
      )}

      {rows.length === 0 ? (
        <EmptyState {...empty} />
      ) : (
        <div className="overflow-x-auto">
          <div style={{ minWidth }}>
            <div
              className="grid gap-3.5 border-b border-line bg-sunken px-4 py-2.5"
              style={{ gridTemplateColumns: grid }}
              role="row"
            >
              {columns.map((c) => (
                <div
                  key={c.key}
                  role="columnheader"
                  className="font-mono text-micro tracking-[0.1em] text-ink-muted"
                  style={{ textAlign: c.align ?? "left" }}
                >
                  {c.header.toUpperCase()}
                </div>
              ))}
            </div>

            {shown.map((row) => (
              <div
                key={rowKey(row)}
                role="row"
                tabIndex={onRowClick ? 0 : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? (e) => { if (e.key === "Enter") onRowClick(row); } : undefined}
                className={`grid items-center gap-3.5 border-b border-line-soft px-4 py-3 ${onRowClick ? "cursor-pointer hover:bg-page" : ""}`}
                style={{ gridTemplateColumns: grid }}
              >
                {columns.map((c) => (
                  <div key={c.key} className="min-w-0" style={{ textAlign: c.align ?? "left" }}>
                    {c.render(row)}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
      {paged && (
        <div className="px-4 pb-3">
          <Pagination page={current} pageSize={size} total={rows.length} label={rowsLabel ?? title?.toLowerCase() ?? "rows"}
            pageSizeOptions={[pageSize, 30, 50, 100].filter((n, i, a) => a.indexOf(n) === i)} onPageChange={setPage} onPageSizeChange={setSize} />
        </div>
      )}
    </section>
  );
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="px-6 py-14 text-center">
      <div className="mx-auto mb-3.5 grid h-11 w-11 place-items-center rounded-lg bg-sunken text-lg text-ink-muted">
        ◷
      </div>
      <div className="text-[14px] font-semibold">{title}</div>
      <p className="mx-auto mt-1.5 max-w-[400px] text-small leading-relaxed text-ink-muted">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Two-line cell: a name with its identifier underneath. */
export function Cell({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-body font-medium">{children}</div>
      {sub && <div className="mt-0.5 truncate font-mono text-[10.5px] text-ink-faint">{sub}</div>}
    </div>
  );
}

export const Mono = ({ children }: { children: ReactNode }) => (
  <span className="font-mono text-[12.5px]">{children}</span>
);
