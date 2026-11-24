/**
 * Runs `fn` over `items` with at most `limit` calls in flight, and never throws: every item is attempted, and each answer is
 * either its value or the error it threw, in the order of `items`. For the writes the API has no batch for (archive 40
 * learners, place 300 imported learners in classes): a failure of one must not stop the rest, and the caller reports how far
 * it got.
 */
export type Settled<R> = { ok: true; value: R } | { ok: false; error: unknown };

export async function settlePool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<Settled<R>[]> {
  const out: Settled<R>[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        out[i] = { ok: true, value: await fn(items[i]!, i) };
      } catch (error) {
        out[i] = { ok: false, error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** The items in groups of at most `size`, in order. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
