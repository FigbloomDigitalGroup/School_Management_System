interface Props {
  page: number;
  pageSize: number;
  total: number;
  pageSizeOptions?: number[];
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  /** What the rows are, for screen readers: "learners", "invoices". */
  label?: string;
}

/** The page numbers to show: always the first and last, the current one and its neighbours, gaps as null. */
export function pageNumbers(page: number, totalPages: number): (number | null)[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const keep = new Set([1, totalPages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= totalPages));
  if (page <= 3) [2, 3, 4].forEach((p) => keep.add(p));
  if (page >= totalPages - 2) [totalPages - 3, totalPages - 2, totalPages - 1].forEach((p) => keep.add(p));
  const sorted = [...keep].sort((a, b) => a - b);
  const out: (number | null)[] = [];
  sorted.forEach((p, i) => {
    if (i > 0 && p - sorted[i - 1]! > 1) out.push(null);
    out.push(p);
  });
  return out;
}

const BTN = "min-w-[32px] rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small disabled:cursor-not-allowed disabled:opacity-40";

/** A page-number + page-size control for any long list: "1–15 of 983", previous / next and page numbers, all buttons (keyboard and screen reader). */
export function Pagination({ page, pageSize, total, pageSizeOptions = [20, 50, 100], onPageChange, onPageSizeChange, label = "rows" }: Props) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  return (
    <nav aria-label={`Pages of ${label}`} className="flex flex-wrap items-center justify-between gap-3 border-t border-line-soft pt-3">
      <span className="text-[12px] text-ink-faint" aria-live="polite">
        {total === 0 ? "No results" : `${start.toLocaleString()}–${end.toLocaleString()} of ${total.toLocaleString()}`}
      </span>
      <div className="flex flex-wrap items-center gap-2.5">
        {onPageSizeChange && (
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            aria-label="Rows per page"
            className="rounded-md border border-[#D3DAD5] bg-white px-2 py-1.5 text-small"
          >
            {[...new Set([...pageSizeOptions, pageSize])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n} / page</option>)}
          </select>
        )}
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => onPageChange(page - 1)} disabled={page <= 1} aria-label="Previous page" className={BTN}>‹</button>
          {pageNumbers(page, totalPages).map((p, i) => p === null
            ? <span key={`gap-${i}`} aria-hidden className="px-1 text-small text-ink-faint">…</span>
            : (
              <button key={p} type="button" onClick={() => onPageChange(p)} aria-label={`Page ${p}`} aria-current={p === page ? "page" : undefined}
                className={BTN} style={p === page ? { background: "#17402A", borderColor: "#17402A", color: "#fff", fontWeight: 600 } : undefined}>
                {p}
              </button>
            ))}
          <button type="button" onClick={() => onPageChange(page + 1)} disabled={page >= totalPages} aria-label="Next page" className={BTN}>›</button>
        </div>
      </div>
    </nav>
  );
}
