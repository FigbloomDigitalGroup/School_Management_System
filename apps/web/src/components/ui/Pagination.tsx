interface Props {
  page: number;
  pageSize: number;
  total: number;
  pageSizeOptions?: number[];
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

/** A page-number + page-size control for any long, filterable list — first
 *  used by Students & staff once schools started running into hundreds of
 *  rows rendered at once with no way to page through them. */
export function Pagination({ page, pageSize, total, pageSizeOptions = [20, 50, 100], onPageChange, onPageSizeChange }: Props) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line-soft pt-3">
      <span className="text-[12px] text-ink-faint">
        {total === 0 ? "No results" : `${start}–${end} of ${total.toLocaleString()}`}
      </span>
      <div className="flex items-center gap-2.5">
        <select
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value))}
          aria-label="Rows per page"
          className="rounded-md border border-[#D3DAD5] bg-white px-2 py-1.5 text-small"
        >
          {pageSizeOptions.map((n) => <option key={n} value={n}>{n} / page</option>)}
        </select>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            aria-label="Previous page"
            className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small disabled:cursor-not-allowed disabled:opacity-40"
          >
            ‹
          </button>
          <span className="px-1.5 text-small text-ink-muted">{page} / {totalPages}</span>
          <button
            type="button"
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            aria-label="Next page"
            className="rounded-md border border-[#D3DAD5] bg-white px-2.5 py-1.5 text-small disabled:cursor-not-allowed disabled:opacity-40"
          >
            ›
          </button>
        </div>
      </div>
    </div>
  );
}
