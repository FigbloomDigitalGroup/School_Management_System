/**
 * PostgREST answers at most 1000 rows per request (Supabase's max_rows) and
 * says nothing when it stops there, so anything that must see every row —
 * every learner in a large school — reads page by page until a short page
 * comes back. `page` gets an inclusive row range for .range(from, to); give
 * the query a stable .order() so pages don't overlap.
 */
export async function fetchAllPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = 1000,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    all.push(...(data ?? []));
    if (!data || data.length < pageSize) return all;
  }
}

type PageReader<T> = (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/**
 * fetchAllPages, shaped like the answer of one query ({ data, error }), so it can sit among other queries in a Promise.all and be
 * checked the same way. A page that fails gives the error and no rows, never a partial list that looks complete.
 */
export async function fetchAllRows<T>(
  page: PageReader<T>,
  pageSize = 1000,
): Promise<{ data: T[]; error: { message: string } | null }> {
  try {
    return { data: await fetchAllPages<T>(page, pageSize), error: null };
  } catch (err) {
    return { data: [], error: { message: err instanceof Error ? err.message : String(err) } };
  }
}

/**
 * PostgREST's 416 (Range Not Satisfiable, code PGRST103): a page asked for
 * past the end of the rows, e.g. page 4 of a filter that now has one page.
 * The server-paged readers throw this so the screen can go back to page 1
 * instead of showing an error.
 */
export class RangeNotSatisfiableError extends Error {
  readonly status = 416;
  constructor(message = "That page is past the end of the list.") {
    super(message);
    this.name = "RangeNotSatisfiableError";
  }
}

/** Whether an error (thrown, or a PostgREST error with its status) is a 416: the page asked for is past the end. */
export function isRangeNotSatisfiable(error: unknown, status?: number): boolean {
  if (!error) return false;
  if (error instanceof RangeNotSatisfiableError || status === 416) return true;
  const e = error as { status?: unknown; code?: unknown; message?: unknown };
  return e.status === 416 || e.code === "PGRST103" || (typeof e.message === "string" && /range not satisfiable/i.test(e.message));
}

/** The error to throw for a failed page read: a RangeNotSatisfiableError for a 416, otherwise a plain Error with the message. */
export function pageError(error: { message: string; code?: string }, status?: number): Error {
  return isRangeNotSatisfiable(error, status) ? new RangeNotSatisfiableError(error.message) : new Error(error.message);
}
