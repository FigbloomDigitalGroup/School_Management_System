/**
 * Lists in apps/api come back a page at a time, `{ items, page: { limit, next_cursor } }`, at most 200 to a page. This
 * follows `next_cursor` to the end and returns every item. The caller says how to ask for one page, so the path and
 * its filters stay typed where they are written.
 */

export const API_PAGE_LIMIT = 200;

export interface ApiPage<T> {
  items: T[];
  page: { limit?: number; next_cursor: string | null };
}

/** A runaway guard, not a limit anyone should reach: 200 a page, so this is 200 000 rows. */
const MAX_PAGES = 1000;

export async function listAllPages<T>(fetchPage: (cursor: string | undefined) => Promise<ApiPage<T>>): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await fetchPage(cursor);
    all.push(...res.items);
    const next = res.page.next_cursor;
    if (!next) return all;
    // A server that hands back the cursor it was given would loop forever.
    if (seen.has(next)) throw new Error("The server's page cursor did not advance.");
    seen.add(next);
    cursor = next;
  }
  throw new Error(`A list ran past ${MAX_PAGES} pages.`);
}
