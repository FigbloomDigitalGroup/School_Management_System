import { describe, expect, it } from "vitest";
import { normalizeSlug, similarSchoolNames, slugAlternatives, validateSlug } from "./tenancy";

// tenants.slug's check constraint (supabase/migrations/20260901000000_schema.sql)
const DB_SLUG = /^[a-z0-9-]{3,40}$/;

describe("normalizeSlug", () => {
  it("lowercases and trims what the user typed", () => {
    expect(normalizeSlug("  Nairobi ")).toBe("nairobi");
    expect(normalizeSlug("Kijani-Ridge")).toBe("kijani-ridge");
  });
});

describe("validateSlug", () => {
  it("accepts mixed case, which is only safe because forms save normalizeSlug's value", () => {
    expect(validateSlug("Nairobi").ok).toBe(true);
  });

  it("anything it accepts, once normalized, passes the database's own check", () => {
    for (const raw of ["Nairobi", " Enterprise-Junior ", "abc", "school-2026"]) {
      expect(validateSlug(raw).ok).toBe(true);
      expect(normalizeSlug(raw)).toMatch(DB_SLUG);
    }
  });

  it("rejects what the database would", () => {
    for (const raw of ["ab", "has space", "under_score", "-leading", "trailing-", "a".repeat(41)]) {
      expect(validateSlug(raw).ok).toBe(false);
    }
  });
});

describe("slugAlternatives", () => {
  it("offers the place first, then numbers, all valid and different from the original", () => {
    const alts = slugAlternatives("enterprisejunior", "Nairobi");
    expect(alts[0]).toBe("enterprisejunior-nairobi");
    expect(alts).toContain("enterprisejunior-2");
    expect(alts).not.toContain("enterprisejunior");
    for (const a of alts) expect(a).toMatch(DB_SLUG);
  });

  it("numbers from the base, not on top of an existing number", () => {
    expect(slugAlternatives("riverside-2")).toContain("riverside-3");
    expect(slugAlternatives("riverside-2")).not.toContain("riverside-2-2");
  });

  it("stays within 40 characters", () => {
    for (const a of slugAlternatives("a".repeat(40), "Nairobi")) expect(a.length).toBeLessThanOrEqual(40);
  });
});

describe("similarSchoolNames", () => {
  const existing = ["Enterprise Junior school", "Alliance High School", "Theodore Academy"];

  it("matches the same name regardless of case, 'The' and 'School'", () => {
    expect(similarSchoolNames("The Enterprise Junior", existing)).toEqual(["Enterprise Junior school"]);
  });

  it("matches one name extending the other", () => {
    expect(similarSchoolNames("Enterprise Junior Academy", existing)).toEqual(["Enterprise Junior school"]);
  });

  it("doesn't strip 'the' out of the middle of a word", () => {
    expect(similarSchoolNames("odore Academy", existing)).toEqual([]);
  });

  it("ignores short or unrelated names", () => {
    expect(similarSchoolNames("Kenya High", existing)).toEqual([]);
    expect(similarSchoolNames("En", existing)).toEqual([]);
  });
});
