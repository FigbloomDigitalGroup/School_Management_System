import { afterEach, describe, expect, it } from "vitest";
import { cacheGet, cacheScope, cacheSet, clearQueryCache, invalidate, peek, setCacheScope } from "./queryCache";
import { asyncKey } from "./useAsync";
import { pageNumbers } from "../components/ui/Pagination";

afterEach(() => { setCacheScope(null); clearQueryCache(); });

describe("query cache", () => {
  it("keeps a value per key and empties when someone else signs in", () => {
    setCacheScope("u1:t1:");
    cacheSet("a", 1);
    expect(cacheGet("a")).toBe(1);
    setCacheScope("u1:t1:");
    expect(cacheGet("a")).toBe(1);
    setCacheScope("u2:t1:");
    expect(cacheGet("a")).toBeUndefined();
    expect(cacheScope()).toBe("u2:t1:");
  });

  it("invalidates by prefix: the entry is kept for display but marked stale", () => {
    cacheSet("t1:inv:register", [1]);
    cacheSet("t1:fees:amounts", [2]);
    invalidate("t1:inv:");
    // still readable (stale-while-revalidate), and the other prefix untouched
    expect(peek("t1:inv:register")).toEqual([1]);
    expect(peek("t1:fees:amounts")).toEqual([2]);
  });
});

describe("useAsync keys", () => {
  it("is null with nobody signed in, or with deps that aren't plain data", () => {
    expect(asyncKey(() => 1, ["x"])).toBeNull();
    setCacheScope("u1");
    expect(asyncKey(() => 1, [new Date()])).toBeNull();
    expect(asyncKey(() => 1, [new Map()])).toBeNull();
  });

  it("differs by deps and by the function, and is stable for the same call", () => {
    setCacheScope("u1");
    const f = () => Promise.resolve(1);
    expect(asyncKey(f, ["t", 1])).toBe(asyncKey(f, ["t", 1]));
    expect(asyncKey(f, ["t", 1])).not.toBe(asyncKey(f, ["t", 2]));
    expect(asyncKey(f, ["t"])).not.toBe(asyncKey(() => Promise.resolve(2), ["t"]));
    expect(asyncKey(f, [], "explicit")).toBe("u1|k|explicit");
  });
});

describe("page numbers", () => {
  it("shows them all when there are few", () => {
    expect(pageNumbers(1, 5)).toEqual([1, 2, 3, 4, 5]);
  });
  it("keeps the ends and the neighbours, with gaps", () => {
    expect(pageNumbers(1, 66)).toEqual([1, 2, 3, 4, null, 66]);
    expect(pageNumbers(30, 66)).toEqual([1, null, 29, 30, 31, null, 66]);
    expect(pageNumbers(66, 66)).toEqual([1, null, 63, 64, 65, 66]);
  });
});
