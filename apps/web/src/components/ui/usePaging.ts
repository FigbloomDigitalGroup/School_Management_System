import { useEffect, useState } from "react";

export const PAGE_SIZES = [25, 50, 100];

/**
 * Page state for a list paged with <Pagination>: back to page 1 whenever
 * `resetKey` changes (a new filter or search), and never past the last page
 * when the list shrinks. `slice` pages a list already in memory; for a list
 * paged on the server, use `offset` and `size` in the query.
 */
export function usePaging(total: number, resetKey: unknown = null, initialSize = 25) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(initialSize);
  useEffect(() => { setPage(1); }, [resetKey, size]);
  const last = Math.max(1, Math.ceil(total / size));
  // a server-paged list has no total while its next page loads: keep the page asked for
  const current = total > 0 ? Math.min(page, last) : page;
  return {
    page: current,
    size,
    offset: (current - 1) * size,
    slice: <T,>(rows: T[]) => rows.slice((current - 1) * size, current * size),
    props: { page: current, pageSize: size, total, pageSizeOptions: PAGE_SIZES, onPageChange: setPage, onPageSizeChange: setSize },
  };
}
