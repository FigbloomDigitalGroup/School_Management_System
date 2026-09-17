import { describe, expect, it } from "vitest";
import { creditWeightedGpa, letterAndPoints, weightedScore } from "./gpa";

describe("letterAndPoints", () => {
  // Kenyan university convention (e.g. Kenyatta University: A = 70-100%),
  // not the ~90%=A scale common in the US.
  it.each([
    [95, "A", 4.0],
    [70, "A", 4.0],
    [62, "B+", 3.3],
    [42, "C", 2.0],
    [22, "D-", 0.7],
    [10, "F", 0.0],
  ])("scores %i%% as %s (%s points)", (score, grade, points) => {
    const r = letterAndPoints(score as number);
    expect(r.grade).toBe(grade);
    expect(r.points).toBe(points);
  });
});

describe("weightedScore", () => {
  it("is null when nothing is graded yet", () => {
    expect(weightedScore([{ score: null, weight_pct: 30, out_of: 100 }, { score: null, weight_pct: 70, out_of: 100 }])).toBeNull();
  });

  it("weights only what's been entered, re-normalized to the weight actually graded", () => {
    // Only the 30%-weighted assessment is in; its 80/100 stands alone re-normalized to 100% of entered weight.
    const partial = weightedScore([{ score: 80, weight_pct: 30, out_of: 100 }, { score: null, weight_pct: 70, out_of: 100 }]);
    expect(partial).toBe(80);
  });

  it("combines multiple graded assessments by their weight", () => {
    // 80% on a 40%-weight midterm, 60% on a 60%-weight final => 0.4*80 + 0.6*60 = 68
    const combined = weightedScore([
      { score: 80, weight_pct: 40, out_of: 100 },
      { score: 60, weight_pct: 60, out_of: 100 },
    ]);
    expect(combined).toBe(68);
  });

  it("normalizes a score against a non-100 out_of", () => {
    // 15/20 = 75%, sole graded assessment
    const r = weightedScore([{ score: 15, weight_pct: 100, out_of: 20 }]);
    expect(r).toBe(75);
  });
});

describe("creditWeightedGpa", () => {
  it("is null with no courses", () => {
    expect(creditWeightedGpa([])).toBeNull();
  });

  it("weights each course's grade points by its credits", () => {
    // (4.0*3 + 3.0*4) / (3+4) = (12+12)/7 = 24/7 = 3.43
    const gpa = creditWeightedGpa([{ grade_points: 4.0, credits: 3 }, { grade_points: 3.0, credits: 4 }]);
    expect(gpa).toBe(3.43);
  });
});
