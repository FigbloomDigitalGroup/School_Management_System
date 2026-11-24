import { describe, expect, it } from "vitest";
import { RangeNotSatisfiableError } from "@figbloom/shared";
import { clampPage, nextPaging, type PagingState } from "../components/ui/usePaging";

const on = (page: number, key: unknown = "overdue|", size = 25): PagingState => ({ page, key, size });

describe("paging: back to page 1 before the fetch", () => {
  it("a new filter, search or tab goes to page 1 in the same render (no request for the old page's range)", () => {
    const next = nextPaging(on(4), "out|", 25);
    expect(next.page).toBe(1);
    expect(next.key).toBe("out|");
    // and so the offset the fetch uses is 0, not the old page's
    expect((clampPage(next.page, 200, 25) - 1) * 25).toBe(0);
  });

  it("a new page size goes to page 1", () => {
    expect(nextPaging(on(3), "overdue|", 50).page).toBe(1);
  });

  it("nothing changed: keeps the page (and the same object, so no re-render loop)", () => {
    const s = on(3);
    expect(nextPaging(s, "overdue|", 25)).toBe(s);
    expect(nextPaging(s, "overdue|", 25, new Error("timeout"))).toBe(s);
  });

  it("an object reset key is compared by value, not identity", () => {
    const s = nextPaging(on(1, null), { classId: "a" }, 25);
    const moved = { ...s, page: 3 };
    expect(nextPaging(moved, { classId: "a" }, 25)).toBe(moved);
    expect(nextPaging(moved, { classId: "b" }, 25).page).toBe(1);
  });

  it("a 416 from the server goes to page 1, defensively", () => {
    expect(nextPaging(on(4), "overdue|", 25, new RangeNotSatisfiableError()).page).toBe(1);
    expect(nextPaging(on(4), "overdue|", 25, { code: "PGRST103", message: "Requested range not satisfiable" }).page).toBe(1);
    const first = on(1);
    expect(nextPaging(first, "overdue|", 25, new RangeNotSatisfiableError())).toBe(first);
  });

  it("never shows a page past the last when the list shrinks", () => {
    expect(clampPage(4, 30, 25)).toBe(2);
    expect(clampPage(4, 0, 25)).toBe(4);
  });
});
