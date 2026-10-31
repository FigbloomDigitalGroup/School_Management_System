import { describe, expect, it } from "vitest";
import { labelEvery, lastValueIndex, nearestIndex, spreadLabels, valueRuns } from "./chartMath";

describe("valueRuns", () => {
  it("breaks the line at a missing value instead of drawing it as a zero", () => {
    expect(valueRuns([50, 60, null, 70, 80, 90])).toEqual([[0, 1], [3, 4, 5]]);
  });
  it("keeps a lone point as a run of one, so it can be drawn as a dot", () => {
    expect(valueRuns([null, 55, null])).toEqual([[1]]);
  });
  it("treats undefined like null, and an empty or all-missing series as no runs", () => {
    expect(valueRuns([undefined, 40, undefined])).toEqual([[1]]);
    expect(valueRuns([])).toEqual([]);
    expect(valueRuns([null, null])).toEqual([]);
  });
  it("counts a real zero as a value", () => {
    expect(valueRuns([0, 0])).toEqual([[0, 1]]);
  });
});

describe("lastValueIndex", () => {
  it("is the last index with a value", () => {
    expect(lastValueIndex([10, 20, null, 30, null])).toBe(3);
    expect(lastValueIndex([0])).toBe(0);
  });
  it("is null when nothing has a value", () => {
    expect(lastValueIndex([])).toBeNull();
    expect(lastValueIndex([null, undefined])).toBeNull();
  });
});

describe("labelEvery", () => {
  it("shows every label when they fit and thins them out when they don't", () => {
    expect(labelEvery(4, 300, 70)).toBe(1);
    expect(labelEvery(10, 280, 70)).toBe(3);
    expect(labelEvery(12, 100, 70)).toBe(12);
  });
  it("never returns less than 1, even for no room or no labels", () => {
    expect(labelEvery(0, 300, 70)).toBe(1);
    expect(labelEvery(5, 10, 70)).toBe(5);
  });
});

describe("spreadLabels", () => {
  it("leaves labels that already have room where they are", () => {
    expect(spreadLabels([10, 40, 90], 14)).toEqual([10, 40, 90]);
  });
  it("pushes crowded labels down, in the order they were given", () => {
    expect(spreadLabels([50, 52, 51], 14)).toEqual([50, 78, 64]);
  });
  it("does not change its input", () => {
    const ys = [20, 21];
    spreadLabels(ys, 14);
    expect(ys).toEqual([20, 21]);
  });
});

describe("nearestIndex", () => {
  it("picks the point closest to a tap, and clamps to the ends", () => {
    expect(nearestIndex(34, 34, 100, 4)).toBe(0);
    expect(nearestIndex(140, 34, 100, 4)).toBe(1);
    expect(nearestIndex(160, 34, 100, 4)).toBe(1);
    expect(nearestIndex(900, 34, 100, 4)).toBe(3);
    expect(nearestIndex(-20, 34, 100, 4)).toBe(0);
  });
  it("is 0 for a single point or no spacing", () => {
    expect(nearestIndex(100, 34, 0, 1)).toBe(0);
    expect(nearestIndex(100, 34, 0, 5)).toBe(0);
  });
});
