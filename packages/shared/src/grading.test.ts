import { describe, expect, it } from "vitest";
import { againstMean, gradeFor, parseScoreInput, pointsFor, summarise } from "./grading";

describe("gradeFor / pointsFor (kcse)", () => {
  it.each([
    [80, "A", 12],
    [79, "A-", 11],
    [75, "A-", 11],
    [70, "B+", 10],
    [50, "C", 6],
    [30, "D-", 2],
    [1, "E", 1],
    [0, "E", 1],
  ])("scores %i as %s (%i points)", (score, grade, points) => {
    expect(gradeFor(score, "kcse")).toBe(grade);
    expect(pointsFor(score, "kcse")).toBe(points);
  });
});

describe("gradeFor / pointsFor (cbc)", () => {
  it.each([
    [95, "EE1", 8],
    [90, "EE1", 8],
    [80, "EE2", 7],
    [60, "ME1", 6],
    [45, "ME2", 5],
    [35, "AE1", 4],
    [25, "AE2", 3],
    [15, "BE1", 2],
    [5, "BE2", 1],
    [0, "BE2", 1],
  ])("scores %i as %s (%i points)", (score, grade, points) => {
    expect(gradeFor(score, "cbc")).toBe(grade);
    expect(pointsFor(score, "cbc")).toBe(points);
  });

  it("the same score renders differently under each scheme", () => {
    expect(gradeFor(85, "kcse")).toBe("A");
    expect(gradeFor(85, "cbc")).toBe("EE2");
  });
});

describe("summarise", () => {
  it("never invents a mean from an empty roster", () => {
    const s = summarise([{ subject: "Math", score: null }, { subject: "English", score: null }], "kcse");
    expect(s).toEqual({ entered: 0, total: 2, meanScore: null, meanGrade: null, totalPoints: 0 });
  });

  it("means only the entered scores, not the whole roster", () => {
    const s = summarise([
      { subject: "Math", score: 80 },
      { subject: "English", score: 60 },
      { subject: "Kiswahili", score: null },
    ], "kcse");
    expect(s.entered).toBe(2);
    expect(s.total).toBe(3);
    expect(s.meanScore).toBe(70);
    expect(s.meanGrade).toBe("B+");
    expect(s.totalPoints).toBe(12 + 8);
  });

  it("uses the cbc scale when asked", () => {
    const s = summarise([{ subject: "Math", score: 92 }, { subject: "English", score: 88 }], "cbc");
    expect(s.meanScore).toBe(90);
    expect(s.meanGrade).toBe("EE1");
  });
});

describe("againstMean", () => {
  it("says exactly the mean when tied", () => {
    expect(againstMean(65, 65)).toBe("Exactly the class mean of 65");
  });
  it("says above when higher", () => {
    expect(againstMean(70, 65)).toBe("5 above the class mean of 65");
  });
  it("says below when lower", () => {
    expect(againstMean(60, 65)).toBe("5 below the class mean of 65");
  });
});

describe("parseScoreInput", () => {
  it("accepts a plain number within range", () => {
    expect(parseScoreInput("72")).toEqual({ ok: true, score: 72 });
  });
  it("trims whitespace", () => {
    expect(parseScoreInput(" 72 ")).toEqual({ ok: true, score: 72 });
  });
  it("treats blank and dash as unmarked, not absent", () => {
    expect(parseScoreInput("")).toEqual({ ok: true, score: null });
    expect(parseScoreInput("-")).toEqual({ ok: true, score: null });
  });
  it("treats 'abs'/'absent' as a missed paper", () => {
    expect(parseScoreInput("abs")).toEqual({ ok: true, score: null });
    expect(parseScoreInput("ABSENT")).toEqual({ ok: true, score: null });
  });
  it("rejects non-numeric input", () => {
    const r = parseScoreInput("seventy");
    expect(r.ok).toBe(false);
  });
  it("rejects a score above the paper total", () => {
    const r = parseScoreInput("101", 100);
    expect(r).toEqual({ ok: false, message: "This paper is out of 100." });
  });
  it("respects a non-default paper total", () => {
    expect(parseScoreInput("45", 40)).toEqual({ ok: false, message: "This paper is out of 40." });
    expect(parseScoreInput("40", 40)).toEqual({ ok: true, score: 40 });
  });
});
