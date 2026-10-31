/**
 * The small, pure parts of a line chart that don't depend on where it is
 * drawn (an SVG in the browser or on a phone): where the line breaks, which
 * x labels fit, and how end labels are kept from sitting on each other.
 */

/** Runs of consecutive indices that have a value: a null (a paper not sat) breaks the line, and is not a zero. */
export function valueRuns(values: (number | null | undefined)[]): number[][] {
  const out: number[][] = [];
  let run: number[] = [];
  values.forEach((v, i) => {
    if (v === null || v === undefined) {
      if (run.length) out.push(run);
      run = [];
    } else {
      run.push(i);
    }
  });
  if (run.length) out.push(run);
  return out;
}

/** The last index that has a value, or null when none do. */
export function lastValueIndex(values: (number | null | undefined)[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== null && values[i] !== undefined) return i;
  }
  return null;
}

/** Show every nth x label so about one per `minPx` fits: 1 means all of them. */
export function labelEvery(count: number, widthPx: number, minPx: number): number {
  const fits = Math.max(1, Math.floor(widthPx / minPx));
  return Math.max(1, Math.ceil(count / fits));
}

/**
 * Positions (top to bottom) nudged down just enough that neighbours are at
 * least `gap` apart. Returned in the order given; the input is not changed.
 */
export function spreadLabels(ys: number[], gap: number): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  for (let k = 1; k < order.length; k++) {
    if (order[k]!.y - order[k - 1]!.y < gap) order[k]!.y = order[k - 1]!.y + gap;
  }
  const out = new Array<number>(ys.length);
  for (const o of order) out[o.i] = o.y;
  return out;
}

/** The index of the point nearest `x` on an axis whose points are `step` apart starting at `left`. */
export function nearestIndex(x: number, left: number, step: number, count: number): number {
  if (count <= 1 || step <= 0) return 0;
  return Math.min(Math.max(Math.round((x - left) / step), 0), count - 1);
}
