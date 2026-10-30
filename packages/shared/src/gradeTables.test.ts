import { describe, expect, it } from "vitest";
import { gradeFor, parseScoreInput, pointsFor, summarise } from "./grading";
import { CBC_RUBRIC_4, CBC_RUBRIC_8, summariseStrands } from "./gradingSchemes";
import { creditWeightedGpa, letterAndPoints, weightedScore } from "./gpa";

/**
 * QA 09 (FIG-1242): marks to grades, worked out BY HAND and typed here, not read from the code under test.
 *
 * Where each table comes from, and how far it can be trusted:
 *  - CBC (8 levels, junior school): the published KNEC scale, as printed by several Kenyan outlets for the 2025 KJSEA: EE1 90-100
 *    (8 points), EE2 75-89 (7), ME1 58-74 (6), ME2 41-57 (5), AE1 31-40 (4), AE2 21-30 (3), BE1 11-20 (2), BE2 1-10 (1). The
 *    published table has no band for a mark of 0, so what the code does with 0 (BE2, 1 point) is pinned below, not verified.
 *  - KCSE (12 points): the points per grade (A = 12 down to E = 1) agree everywhere. The PERCENTAGE cut-offs do not have one
 *    authority: KNEC sets boundaries per subject and per year and publishes no single percentage table, and secondary sources
 *    disagree (one gives A from 84%). The cut-offs here (A 80, A- 75, ... E 0-29) are the common Kenyan school convention the
 *    product uses; they are typed here independently so a slip in the code is caught, but a school that uses another
 *    convention is a product decision, not something this file can settle.
 *  - Higher-education GPA: the product's own 4.0 plus/minus scale with a Kenyan-style A at 70%. Each university has its own
 *    scale (the 5-point A 70-100 / B 60-69 / C 50-59 / D 40-49 one is common at public universities), so this is regression
 *    protection for the scale the product ships, not a check against an official table.
 * Marks are whole numbers (marks.score is an integer column), so every integer from 0 to 100 is checked, not just samples.
 */

type Band = [grade: string, points: number, lo: number, hi: number];

const KCSE: Band[] = [
  ["A", 12, 80, 100], ["A-", 11, 75, 79], ["B+", 10, 70, 74], ["B", 9, 65, 69], ["B-", 8, 60, 64], ["C+", 7, 55, 59],
  ["C", 6, 50, 54], ["C-", 5, 45, 49], ["D+", 4, 40, 44], ["D", 3, 35, 39], ["D-", 2, 30, 34], ["E", 1, 0, 29],
];

const CBC: Band[] = [
  ["EE1", 8, 90, 100], ["EE2", 7, 75, 89], ["ME1", 6, 58, 74], ["ME2", 5, 41, 57],
  ["AE1", 4, 31, 40], ["AE2", 3, 21, 30], ["BE1", 2, 11, 20], ["BE2", 1, 1, 10],
];

const expected = (table: Band[], mark: number) => table.find(([, , lo, hi]) => mark >= lo && mark <= hi);

describe("KCSE: every whole mark from 0 to 100", () => {
  for (let mark = 0; mark <= 100; mark++) {
    const [grade, points] = expected(KCSE, mark)!;
    it(`${mark} is ${grade}, ${points} points`, () => {
      expect(gradeFor(mark, "kcse")).toBe(grade);
      expect(pointsFor(mark, "kcse")).toBe(points);
    });
  }

  // The same table as the cut-offs and the mark just below each one, written out as it would be printed.
  it.each([
    [100, "A", 12], [80, "A", 12], [79, "A-", 11], [75, "A-", 11], [74, "B+", 10], [70, "B+", 10], [69, "B", 9], [65, "B", 9],
    [64, "B-", 8], [60, "B-", 8], [59, "C+", 7], [55, "C+", 7], [54, "C", 6], [50, "C", 6], [49, "C-", 5], [45, "C-", 5],
    [44, "D+", 4], [40, "D+", 4], [39, "D", 3], [35, "D", 3], [34, "D-", 2], [30, "D-", 2], [29, "E", 1], [0, "E", 1],
  ])("boundary: %i is %s (%i points)", (mark, grade, points) => {
    expect(gradeFor(mark, "kcse")).toBe(grade);
    expect(pointsFor(mark, "kcse")).toBe(points);
  });
});

describe("CBC (8 levels): every whole mark from 0 to 100", () => {
  for (let mark = 1; mark <= 100; mark++) {
    const [grade, points] = expected(CBC, mark)!;
    it(`${mark} is ${grade}, ${points} points`, () => {
      expect(gradeFor(mark, "cbc")).toBe(grade);
      expect(pointsFor(mark, "cbc")).toBe(points);
    });
  }

  it.each([
    [100, "EE1", 8], [90, "EE1", 8], [89, "EE2", 7], [75, "EE2", 7], [74, "ME1", 6], [58, "ME1", 6], [57, "ME2", 5], [41, "ME2", 5],
    [40, "AE1", 4], [31, "AE1", 4], [30, "AE2", 3], [21, "AE2", 3], [20, "BE1", 2], [11, "BE1", 2], [10, "BE2", 1], [1, "BE2", 1],
  ])("boundary: %i is %s (%i points)", (mark, grade, points) => {
    expect(gradeFor(mark, "cbc")).toBe(grade);
    expect(pointsFor(mark, "cbc")).toBe(points);
  });

  // The published table starts at 1 ("no zero marks awarded"). The code gives a 0 the lowest level, BE2, and one point.
  it("a mark of 0 has no band in the published table; the code puts it in BE2 with 1 point", () => {
    expect(gradeFor(0, "cbc")).toBe("BE2");
    expect(pointsFor(0, "cbc")).toBe(1);
  });
});

describe("marks that are not a whole number from 0 to 100 (callers and the database must refuse these; gradeFor does not)", () => {
  it("a fraction falls into the band below the next whole mark", () => {
    expect(gradeFor(79.5, "kcse")).toBe("A-");
    expect(gradeFor(74.99, "kcse")).toBe("B+");
    expect(gradeFor(89.99, "cbc")).toBe("EE2");
    expect(gradeFor(10.5, "cbc")).toBe("BE2");
  });

  it("an impossible mark is not rejected here: below 0 is the lowest grade, above 100 the highest, NaN the lowest", () => {
    expect(gradeFor(-1, "kcse")).toBe("E");
    expect(gradeFor(101, "kcse")).toBe("A");
    expect(gradeFor(1000, "cbc")).toBe("EE1");
    expect(gradeFor(Number.NaN, "kcse")).toBe("E");
    expect(gradeFor(Number.NaN, "cbc")).toBe("BE2");
  });
});

describe("summarise: worked by hand", () => {
  const marks = (...scores: (number | null)[]) => scores.map((score, i) => ({ subject: `S${i}`, score }));

  it("a zero is a mark, not a gap: it is counted in the mean and the points", () => {
    expect(summarise(marks(80, 0), "kcse")).toEqual({ entered: 2, total: 2, meanScore: 40, meanGrade: "D+", totalPoints: 12 + 1 });
  });

  it("a gap is left out, and the summary says how many are missing", () => {
    expect(summarise(marks(80, null, 60), "kcse")).toEqual({ entered: 2, total: 3, meanScore: 70, meanGrade: "B+", totalPoints: 12 + 8 });
  });

  it("the mean is rounded half up BEFORE it is graded: 79.5 shows as 80 and is an A", () => {
    // (80 + 79) / 2 = 79.5 -> 80 -> A, although 79.5 on its own is an A-
    expect(summarise(marks(80, 79), "kcse")).toMatchObject({ meanScore: 80, meanGrade: "A", totalPoints: 12 + 11 });
    // (74 + 75) / 2 = 74.5 -> 75 -> A-
    expect(summarise(marks(74, 75), "kcse")).toMatchObject({ meanScore: 75, meanGrade: "A-" });
  });

  // KCSE's own mean grade is worked out from the mean of the POINTS. The product grades the mean MARK. They differ.
  it("the mean grade is the grade of the mean MARK, which is not always the grade of the mean POINTS", () => {
    // 100 and 30: mean mark 65 -> B (9 points). Points 12 and 2: mean 7 points -> C+.
    const s = summarise(marks(100, 30), "kcse");
    expect(s).toMatchObject({ meanScore: 65, meanGrade: "B", totalPoints: 14 });
    expect(s.totalPoints / s.entered).toBe(7);
    expect(pointsFor(65, "kcse")).toBe(9);
  });

  it("works on the CBC scale", () => {
    // 92 -> EE1 (8), 88 -> EE2 (7); mean 90 -> EE1
    expect(summarise(marks(92, 88), "cbc")).toEqual({ entered: 2, total: 2, meanScore: 90, meanGrade: "EE1", totalPoints: 15 });
    // 58 -> ME1 (6), 57 -> ME2 (5); mean 57.5 -> 58 -> ME1
    expect(summarise(marks(58, 57), "cbc")).toMatchObject({ meanScore: 58, meanGrade: "ME1", totalPoints: 11 });
  });
});

describe("parseScoreInput: what the gradebook accepts, field by field", () => {
  const WHOLE = "Numbers only, or 'abs' if they missed it.";

  it.each([
    ["72", 72], [" 72 ", 72], ["0", 0], ["00", 0], ["007", 7], ["100", 100],
    ["", null], ["   ", null], ["-", null], ["abs", null], ["ABS", null], ["Absent", null],
  ])("%j is accepted as %j", (raw, score) => {
    expect(parseScoreInput(raw)).toEqual({ ok: true, score });
  });

  it("a zero and an empty cell are different things", () => {
    expect(parseScoreInput("0")).toEqual({ ok: true, score: 0 });
    expect(parseScoreInput("")).toEqual({ ok: true, score: null });
  });

  it.each(["101", "150", "999"])("%j is over the paper total of 100", (raw) => {
    expect(parseScoreInput(raw)).toEqual({ ok: false, message: "This paper is out of 100." });
  });

  it.each(["72.5", "72,5", "-5", "+5", "1e2", "0x10", "1000", "seventy", "7 2", "٧٢", "７２", "NaN", "Infinity"])("%j is refused with the numbers-only message", (raw) => {
    expect(parseScoreInput(raw)).toEqual({ ok: false, message: WHOLE });
  });

  it("measures against another paper total when given one (a total other than 100 is not supported by the screens)", () => {
    expect(parseScoreInput("40", 40)).toEqual({ ok: true, score: 40 });
    expect(parseScoreInput("41", 40)).toEqual({ ok: false, message: "This paper is out of 40." });
  });

  // "abs" and a blank both come back as score null, so the parser itself cannot say "missed" or "not marked yet":
  // the gradebook stores a row with a null score for "abs" and nothing for a blank cell.
  it("'abs' and blank are the same result here (score null); the difference is whether a row is saved", () => {
    expect(parseScoreInput("abs")).toEqual(parseScoreInput(""));
  });
});

describe("CBE rubric levels (the database function rubric_points() must give the same numbers: supabase/rls-checks/grades.sql)", () => {
  it("four levels up to Grade 6", () => {
    expect(CBC_RUBRIC_4.map((l) => `${l.code}=${l.points}`)).toEqual(["EE=4", "ME=3", "AE=2", "BE=1"]);
  });

  it("eight levels from junior school", () => {
    expect(CBC_RUBRIC_8.map((l) => `${l.code}=${l.points}`)).toEqual(["EE1=8", "EE2=7", "ME1=6", "ME2=5", "AE1=4", "AE2=3", "BE1=2", "BE2=1"]);
  });

  it("the overall level is the level nearest the mean of the points; exactly between two, the higher one", () => {
    // EE (4) and ME (3): mean 3.5, equally near both -> EE
    expect(summariseStrands(["EE", "ME"], CBC_RUBRIC_4)).toMatchObject({ meanPoints: 3.5 });
    expect(summariseStrands(["EE", "ME"], CBC_RUBRIC_4).overall?.code).toBe("EE");
    // ME (3), ME (3), AE (2): mean 2.67 -> ME
    expect(summariseStrands(["ME", "ME", "AE"], CBC_RUBRIC_4)).toMatchObject({ meanPoints: 2.7 });
    expect(summariseStrands(["ME", "ME", "AE"], CBC_RUBRIC_4).overall?.code).toBe("ME");
    // 8-level: EE1 (8) and BE2 (1): mean 4.5 -> AE1 (4) and ME2 (5) are equally near -> the higher, ME2
    expect(summariseStrands(["EE1", "BE2"], CBC_RUBRIC_8).overall?.code).toBe("ME2");
  });
});

describe("higher education: letter and points, worked by hand (the product's own 4.0 scale, see the header)", () => {
  it.each([
    [100, "A", 4.0], [70, "A", 4.0], [69.99, "A-", 3.7], [65, "A-", 3.7], [64.99, "B+", 3.3], [60, "B+", 3.3],
    [59.99, "B", 3.0], [55, "B", 3.0], [54.99, "B-", 2.7], [50, "B-", 2.7], [49.99, "C+", 2.3], [45, "C+", 2.3],
    [44.99, "C", 2.0], [40, "C", 2.0], [39.99, "C-", 1.7], [35, "C-", 1.7], [34.99, "D+", 1.3], [30, "D+", 1.3],
    [29.99, "D", 1.0], [25, "D", 1.0], [24.99, "D-", 0.7], [20, "D-", 0.7], [19.99, "F", 0.0], [0, "F", 0.0],
  ])("%s%% is %s (%s points)", (pct, grade, points) => {
    expect(letterAndPoints(pct)).toEqual({ grade, points });
  });

  it("the weighted score, re-normalised to what has been marked", () => {
    // 15/20 = 75% at weight 30 and 45/50 = 90% at weight 70: (75*30 + 90*70) / 100 = 85.5
    expect(weightedScore([{ score: 15, weight_pct: 30, out_of: 20 }, { score: 45, weight_pct: 70, out_of: 50 }])).toBe(85.5);
    // weights that do not add up to 100 are scaled to what was marked: (50*20 + 100*30) / 50 = 80
    expect(weightedScore([{ score: 50, weight_pct: 20, out_of: 100 }, { score: 100, weight_pct: 30, out_of: 100 }])).toBe(80);
    // a zero is marked work: (0*50 + 100*50) / 100 = 50
    expect(weightedScore([{ score: 0, weight_pct: 50, out_of: 100 }, { score: 100, weight_pct: 50, out_of: 100 }])).toBe(50);
    // rounded to two decimals: 1/3 = 33.33%
    expect(weightedScore([{ score: 1, weight_pct: 100, out_of: 3 }])).toBe(33.33);
    // nothing marked, or no weight: no score
    expect(weightedScore([{ score: null, weight_pct: 50, out_of: 100 }])).toBeNull();
    expect(weightedScore([{ score: 50, weight_pct: 0, out_of: 100 }])).toBeNull();
  });

  it("a mark above the assessment total is not capped here: 25/20 is 125% (the database must stop it; see grades.sql)", () => {
    expect(weightedScore([{ score: 25, weight_pct: 100, out_of: 20 }])).toBe(125);
    expect(letterAndPoints(125)).toEqual({ grade: "A", points: 4.0 });
  });

  it("credit-weighted GPA", () => {
    // (3.3*2 + 2.0*1 + 0*3) / 6 = 8.6 / 6 = 1.4333 -> 1.43 (a failed course still counts its credits)
    expect(creditWeightedGpa([{ grade_points: 3.3, credits: 2 }, { grade_points: 2.0, credits: 1 }, { grade_points: 0, credits: 3 }])).toBe(1.43);
    // (4*2 + 3*2 + 2*2) / 6 = 3
    expect(creditWeightedGpa([{ grade_points: 4, credits: 2 }, { grade_points: 3, credits: 2 }, { grade_points: 2, credits: 2 }])).toBe(3);
    // (0*3 + 4*3) / 6 = 2
    expect(creditWeightedGpa([{ grade_points: 0, credits: 3 }, { grade_points: 4, credits: 3 }])).toBe(2);
    // no credits: no GPA
    expect(creditWeightedGpa([{ grade_points: 4, credits: 0 }])).toBeNull();
    expect(creditWeightedGpa([])).toBeNull();
  });
});
