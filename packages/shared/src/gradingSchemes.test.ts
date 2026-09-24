import { describe, expect, it } from "vitest";
import { CBC_RUBRIC_4, CBC_RUBRIC_8, gradingSchemeFor, rubricFor, summariseStrands } from "./gradingSchemes";

describe("gradingSchemeFor", () => {
  it("Kenya: every CBE level gets cbc, 8-4-4 secondary gets kcse", () => {
    expect(gradingSchemeFor("KE", "pre_primary")).toBe("cbc");
    expect(gradingSchemeFor("KE", "primary")).toBe("cbc");
    expect(gradingSchemeFor("KE", "junior_secondary")).toBe("cbc");
    expect(gradingSchemeFor("KE", "senior_school")).toBe("cbc");
    expect(gradingSchemeFor("KE", "secondary")).toBe("kcse");
  });

  it("falls back to kcse for an unregistered country rather than throwing", () => {
    expect(gradingSchemeFor("XX", "primary")).toBe("kcse");
    expect(gradingSchemeFor("XX", "secondary")).toBe("kcse");
  });
});

describe("rubricFor", () => {
  it("4 levels up to Grade 6, 8 levels from junior school, none for 8-4-4 Forms", () => {
    expect(rubricFor("KE", "pre_primary")).toBe(CBC_RUBRIC_4);
    expect(rubricFor("KE", "primary")).toBe(CBC_RUBRIC_4);
    expect(rubricFor("KE", "junior_secondary")).toBe(CBC_RUBRIC_8);
    expect(rubricFor("KE", "senior_school")).toBe(CBC_RUBRIC_8);
    expect(rubricFor("KE", "secondary")).toBeNull();
    expect(rubricFor("XX", "primary")).toBeNull();
  });

  it("matches rubric_points() in the migration: highest level first, points counting down to 1", () => {
    expect(CBC_RUBRIC_4.map((l) => [l.code, l.points])).toEqual([["EE", 4], ["ME", 3], ["AE", 2], ["BE", 1]]);
    expect(CBC_RUBRIC_8.map((l) => l.points)).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
    expect(CBC_RUBRIC_8.map((l) => l.code)).toEqual(["EE1", "EE2", "ME1", "ME2", "AE1", "AE2", "BE1", "BE2"]);
  });
});

describe("summariseStrands", () => {
  it("reads the mean of a learner's points back onto the rubric", () => {
    const s = summariseStrands(["EE", "ME", "ME", "AE"], CBC_RUBRIC_4); // (4+3+3+2)/4 = 3
    expect(s).toMatchObject({ entered: 4, total: 4, meanPoints: 3 });
    expect(s.overall?.code).toBe("ME");
  });

  it("counts only judged strands, and says how many are missing", () => {
    const s = summariseStrands(["EE1", null, "ME1", undefined], CBC_RUBRIC_8); // (8+6)/2 = 7
    expect(s).toMatchObject({ entered: 2, total: 4, meanPoints: 7 });
    expect(s.overall?.code).toBe("EE2");
  });

  it("gives no overall level before anything is judged", () => {
    expect(summariseStrands([null, null], CBC_RUBRIC_4)).toEqual({ entered: 0, total: 2, meanPoints: null, overall: null });
  });

  it("ignores a code from the wrong rubric instead of guessing", () => {
    expect(summariseStrands(["EE1"], CBC_RUBRIC_4).overall).toBeNull();
  });
});
