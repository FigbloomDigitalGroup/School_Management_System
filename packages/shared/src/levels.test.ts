import { describe, expect, it } from "vitest";
import { isValidYear, levelsForTenant, nextYear, subjectOffered, yearLabel, yearMatches, yearSortKey, yearsFor } from "./levels";

describe("yearLabel", () => {
  it("names a year the way the school does", () => {
    expect(yearLabel("pre_primary", 1)).toBe("PP1");
    expect(yearLabel("primary", 4)).toBe("Grade 4");
    expect(yearLabel("junior_secondary", 7)).toBe("Grade 7");
    expect(yearLabel("senior_school", 12)).toBe("Grade 12");
    expect(yearLabel("secondary", 3)).toBe("Form 3");
  });
});

describe("yearsFor / isValidYear", () => {
  it("matches level_year_valid() in the migration", () => {
    expect(yearsFor("pre_primary")).toEqual([1, 2]);
    expect(yearsFor("senior_school")).toEqual([10, 11, 12]);
    expect(isValidYear("junior_secondary", 6)).toBe(false);
    expect(isValidYear("secondary", 5)).toBe(false);
    expect(isValidYear("primary", 1.5)).toBe(false);
  });
});

describe("nextYear", () => {
  it("moves up within a level", () => {
    expect(nextYear("primary", 3)).toEqual({ level: "primary", year: 4 });
    expect(nextYear("secondary", 2)).toEqual({ level: "secondary", year: 3 });
  });

  it("crosses into the next CBE level", () => {
    expect(nextYear("pre_primary", 2)).toEqual({ level: "primary", year: 1 });
    expect(nextYear("primary", 6)).toEqual({ level: "junior_secondary", year: 7 });
    expect(nextYear("junior_secondary", 9)).toEqual({ level: "senior_school", year: 10 });
  });

  it("returns null when learners leave: Grade 12 and Form 4", () => {
    expect(nextYear("senior_school", 12)).toBeNull();
    expect(nextYear("secondary", 4)).toBeNull();
  });

  it("never moves an 8-4-4 class onto the CBE track", () => {
    expect(nextYear("secondary", 3)?.level).toBe("secondary");
  });
});

describe("yearSortKey", () => {
  it("orders PP1 … Grade 12, then Form 1 … Form 4", () => {
    const classes: [Parameters<typeof yearSortKey>[0], number][] = [
      ["secondary", 1], ["primary", 1], ["senior_school", 10], ["pre_primary", 2], ["pre_primary", 1], ["junior_secondary", 9],
    ];
    const sorted = [...classes].sort((a, b) => yearSortKey(...a) - yearSortKey(...b)).map(([l, y]) => yearLabel(l, y));
    expect(sorted).toEqual(["PP1", "PP2", "Grade 1", "Grade 9", "Grade 10", "Form 1"]);
  });
});

describe("levelsForTenant", () => {
  it("offers the levels a school of that kind runs", () => {
    expect(levelsForTenant("primary")).toEqual(["pre_primary", "primary", "junior_secondary"]);
    expect(levelsForTenant("secondary")).toEqual(["junior_secondary", "senior_school", "secondary"]);
    expect(levelsForTenant("combined")).toHaveLength(5);
  });
});

describe("subjectOffered", () => {
  const computer = { level: "secondary" as const, min_form_level: 1, max_form_level: 2 };
  it("reads a subject's range within its own level", () => {
    expect(subjectOffered(computer, { level: "secondary", year: 2 })).toBe(true);
    expect(subjectOffered(computer, { level: "secondary", year: 3 })).toBe(false);
    expect(subjectOffered(computer, { level: "primary", year: 1 })).toBe(false);
  });
  it("keeps a level-less subject's old meaning: any class in range", () => {
    expect(subjectOffered({ level: null, min_form_level: null, max_form_level: 2 }, { level: "primary", year: 1 })).toBe(true);
  });
});

describe("yearMatches", () => {
  it("tells Grade 1 and Form 1 apart once the target names its level", () => {
    expect(yearMatches({ level: "primary", year: 1 }, { level: "secondary", year: 1 })).toBe(false);
    expect(yearMatches({ level: "primary", year: 1 }, { level: "primary", year: 1 })).toBe(true);
  });

  it("keeps a pre-levels row (no level) matching any class of that year", () => {
    expect(yearMatches({ level: null, year: 1 }, { level: "secondary", year: 1 })).toBe(true);
    expect(yearMatches({ level: null, year: 2 }, { level: "secondary", year: 1 })).toBe(false);
  });
});
