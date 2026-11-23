import { describe, expect, it } from "vitest";
import { chunk, settlePool } from "./pool";

const tick = (ms = 2) => new Promise((r) => setTimeout(r, ms));

describe("settlePool", () => {
  it("answers every item in order, whatever order they finish in", async () => {
    const out = await settlePool([30, 1, 15], 3, async (ms) => { await tick(ms); return ms * 2; });
    expect(out).toEqual([{ ok: true, value: 60 }, { ok: true, value: 2 }, { ok: true, value: 30 }]);
  });

  it("never has more than the limit in flight", async () => {
    let live = 0;
    let most = 0;
    await settlePool(Array.from({ length: 12 }, (_, i) => i), 4, async () => { live++; most = Math.max(most, live); await tick(); live--; });
    expect(most).toBe(4);
  });

  it("attempts every item even when some throw, and keeps each error", async () => {
    const seen: number[] = [];
    const out = await settlePool([1, 2, 3, 4], 2, async (n) => { seen.push(n); if (n % 2 === 0) throw new Error(`no ${n}`); return n; });
    expect(seen.sort()).toEqual([1, 2, 3, 4]);
    expect(out.map((r) => (r.ok ? r.value : (r.error as Error).message))).toEqual([1, "no 2", 3, "no 4"]);
  });

  it("copes with nothing, and with a limit larger than the list", async () => {
    expect(await settlePool([], 4, async () => 1)).toEqual([]);
    expect(await settlePool([1], 10, async (n) => n)).toEqual([{ ok: true, value: 1 }]);
  });

  it("passes the index", async () => {
    const out = await settlePool(["a", "b"], 1, async (_x, i) => i);
    expect(out).toEqual([{ ok: true, value: 0 }, { ok: true, value: 1 }]);
  });
});

describe("chunk", () => {
  it("splits in order into groups of at most the size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
    expect(chunk([], 3)).toEqual([]);
  });
});
