import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The server-paged readers against a stand-in for PostgREST that answers a
 * range past the end the way it really does: 416, code PGRST103, no rows.
 */
const db = { rows: 3 };
const ranges: [number, number][] = [];

function builder() {
  let window: [number, number] = [0, 999];
  const answer = () => {
    const [from, to] = window;
    if (from > 0 && from >= db.rows) {
      return { data: null, count: null, status: 416, error: { code: "PGRST103", message: "Requested range not satisfiable", details: `An offset of ${from} was requested, but there are only ${db.rows} rows.` } };
    }
    const rows = Array.from({ length: Math.max(0, Math.min(to, db.rows - 1) - from + 1) }, (_, i) => ({ id: `r${from + i}`, total_cents: 0, charges_cents: 0, paid_cents: 0, status: "overdue", due_on: null, students: null }));
    return { data: rows, count: db.rows, status: 200, error: null };
  };
  const proxy: unknown = new Proxy({}, {
    get(_t, method: string) {
      if (method === "then") return (resolve: (v: unknown) => unknown) => Promise.resolve(answer()).then(resolve);
      if (method === "range") return (from: number, to: number) => { window = [from, to]; ranges.push([from, to]); return proxy; };
      return () => proxy;
    },
  });
  return proxy;
}

vi.mock("./supabase", () => ({ supabase: () => ({ from: () => builder() }) }));

const { fetchIssuesPage, fetchRegisterPage } = await import("./inventoryPaging");
const { fetchCollectionPage } = await import("./feesPaging");
const { RangeNotSatisfiableError, isRangeNotSatisfiable } = await import("./paging");

beforeEach(() => { db.rows = 3; ranges.length = 0; });

describe("a page past the end (416)", () => {
  it("Inventory 'Overdue': throws a RangeNotSatisfiableError the paging hook sends back to page 1", async () => {
    const err = await fetchIssuesPage("t", { filter: "overdue", offset: 50, limit: 25 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RangeNotSatisfiableError);
    expect(isRangeNotSatisfiable(err)).toBe(true);
    expect(ranges).toEqual([[50, 74]]);
  });

  it("Fees 'Nothing paid': the same", async () => {
    const err = await fetchCollectionPage("t", "term", { filter: "nothing_paid", offset: 25, limit: 25 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RangeNotSatisfiableError);
  });

  it("the register: the same", async () => {
    const err = await fetchRegisterPage("t", { offset: 25, limit: 25 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RangeNotSatisfiableError);
  });

  it("page 1 of a short list is just the rows", async () => {
    const page = await fetchCollectionPage("t", "term", { filter: "nothing_paid", offset: 0, limit: 25 });
    expect(page.total).toBe(3);
    expect(page.rows).toHaveLength(3);
  });
});
