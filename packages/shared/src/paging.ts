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
