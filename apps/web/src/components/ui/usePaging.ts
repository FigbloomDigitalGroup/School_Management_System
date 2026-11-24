import { useState } from "react";
import { isRangeNotSatisfiable } from "@figbloom/shared";

export const PAGE_SIZES = [25, 50, 100];

/** What the reset compares: a primitive as it is, anything else by its JSON (a fresh object each render is not a change). */
function resetToken(resetKey: unknown): unknown {
  return resetKey !== null && typeof resetKey === "object" ? JSON.stringify(resetKey) : resetKey;
}

export interface PagingState { page: number; key: unknown; size: number }

/**
 * The page to read, worked out during render so the very first fetch after a
 * change already asks for the right rows: back to page 1 when the filter or
 * search (`resetKey`) or the page size changes, and back to page 1 when the
 * server said the range asked for is past the end (PostgREST's 416).
 * Resetting in an effect instead let the old page's range go out first with
 * the new filter, and a shorter result answered 416.
 */
export function nextPaging(prev: PagingState, resetKey: unknown, size: number, error?: unknown): PagingState {
  const key = resetToken(resetKey);
  if (!Object.is(prev.key, key) || prev.size !== size) return { page: 1, key, size };
  if (prev.page !== 1 && isRangeNotSatisfiable(error)) return { ...prev, page: 1 };
  return prev;
}

/** The page shown: never past the last page when the list shrinks (a server-paged list has no total while its next page loads). */
export function clampPage(page: number, total: number, size: number): number {
  const last = Math.max(1, Math.ceil(total / size));
  return total > 0 ? Math.min(page, last) : page;
}

/**
 * Page state for a list paged with <Pagination>: back to page 1 whenever
 * `resetKey` changes (a new filter or search), and never past the last page
 * when the list shrinks. `slice` pages a list already in memory; for a list
 * paged on the server, use `offset` and `size` in the query and pass the
 * query's error as `error`, so a 416 (range past the end) goes to page 1.
 */
export function usePaging(total: number, resetKey: unknown = null, initialSize = 25, error?: unknown) {
  const [size, setSize] = useState(initialSize);
  const [state, setState] = useState<PagingState>(() => ({ page: 1, key: resetToken(resetKey), size: initialSize }));
  // adjusted during render (React re-renders before committing), so no fetch ever sees the stale page
  const next = nextPaging(state, resetKey, size, error);
  if (next !== state) setState(next);
  const current = clampPage(next.page, total, size);
  const setPage = (page: number) => setState((s) => ({ ...s, page }));
  return {
    page: current,
    size,
    offset: (current - 1) * size,
    slice: <T,>(rows: T[]) => rows.slice((current - 1) * size, current * size),
    props: { page: current, pageSize: size, total, pageSizeOptions: PAGE_SIZES, onPageChange: setPage, onPageSizeChange: setSize },
  };
}
