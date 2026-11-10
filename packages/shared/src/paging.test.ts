import { describe, expect, it } from "vitest";
import { fetchAllPages, fetchAllRows } from "./paging";

/** A table of n rows read through a range, the way PostgREST answers: at most `cap` rows, and no word when it stops. */
function table(n: number, cap = 1000, failOnPage?: number) {
  const calls: [number, number][] = [];
  const read = async (from: number, to: number) => {
    calls.push([from, to]);
    if (failOnPage !== undefined && calls.length === failOnPage) return { data: null, error: { message: "canceling statement due to statement timeout" } };
    const end = Math.min(to, from + cap - 1, n - 1);
    return { data: from > end ? [] : Array.from({ length: end - from + 1 }, (_, i) => from + i), error: null };
  };
  return { read, calls };
}

describe("fetchAllPages", () => {
  it("reads past the 1,000 rows one request returns, in order", async () => {
    const t = table(2500);
    const rows = await fetchAllPages<number>(t.read);
    expect(rows).toHaveLength(2500);
    expect(rows[0]).toBe(0);
    expect(rows[2499]).toBe(2499);
    expect(t.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("stops after an empty page when the rows are an exact multiple of the page size", async () => {
    const t = table(2000);
    expect(await fetchAllPages<number>(t.read)).toHaveLength(2000);
    expect(t.calls).toHaveLength(3);
  });

  it("makes one request for a short table", async () => {
    const t = table(3);
    expect(await fetchAllPages<number>(t.read)).toEqual([0, 1, 2]);
    expect(t.calls).toHaveLength(1);
  });

  it("throws when a page fails, instead of returning the rows read so far", async () => {
    await expect(fetchAllPages<number>(table(2500, 1000, 2).read)).rejects.toThrow("statement timeout");
  });
});

describe("fetchAllRows", () => {
  it("gives every row as one answer with no error", async () => {
    const answer = await fetchAllRows<number>(table(1500).read);
    expect(answer.error).toBeNull();
    expect(answer.data).toHaveLength(1500);
  });

  it("gives the error and no rows when a page fails, never a partial list", async () => {
    const answer = await fetchAllRows<number>(table(2500, 1000, 2).read);
    expect(answer.error?.message).toContain("statement timeout");
    expect(answer.data).toEqual([]);
  });
});
