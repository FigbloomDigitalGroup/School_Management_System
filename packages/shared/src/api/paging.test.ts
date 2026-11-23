import { describe, expect, it } from "vitest";
import { listAllPages } from "./paging";

const page = (items: number[], next: string | null) => ({ items, page: { limit: 200, next_cursor: next } });

describe("listAllPages", () => {
  it("returns one page as it is", async () => {
    expect(await listAllPages(async () => page([1, 2], null))).toEqual([1, 2]);
  });

  it("follows the cursor to the end, in order, passing each cursor on", async () => {
    const seen: (string | undefined)[] = [];
    const pages: Record<string, ReturnType<typeof page>> = { start: page([1, 2], "c1"), c1: page([3], "c2"), c2: page([4, 5], null) };
    const all = await listAllPages(async (cursor) => { seen.push(cursor); return pages[cursor ?? "start"]!; });
    expect(all).toEqual([1, 2, 3, 4, 5]);
    expect(seen).toEqual([undefined, "c1", "c2"]);
  });

  it("copes with an empty list", async () => {
    expect(await listAllPages(async () => page([], null))).toEqual([]);
  });

  it("stops a server that hands the same cursor back", async () => {
    await expect(listAllPages(async () => page([1], "same"))).rejects.toThrow(/did not advance/);
  });

  it("passes a failure on", async () => {
    let n = 0;
    await expect(listAllPages(async () => { if (++n === 2) throw new Error("down"); return page([1], "c1"); })).rejects.toThrow("down");
  });
});
