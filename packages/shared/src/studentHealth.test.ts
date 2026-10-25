import { describe, expect, it } from "vitest";
import { cleanHealthInput, emptyHealth, healthFlags, healthToInput, isHealthEmpty, normaliseList, splitList, type StudentHealth } from "./studentHealth";

describe("normaliseList / splitList", () => {
  it("trims, drops blanks and case-insensitive repeats, keeps the first spelling", () => {
    expect(normaliseList([" Peanuts ", "peanuts", "", "Eggs", "  milk  powder "])).toEqual(["Peanuts", "Eggs", "milk powder"]);
  });
  it("splits typed lists on commas, semicolons and new lines", () => {
    expect(splitList("peanuts, eggs; dust\nPEANUTS")).toEqual(["peanuts", "eggs", "dust"]);
  });
});

describe("cleanHealthInput / isHealthEmpty", () => {
  it("turns blank text into null and drops an unknown blood group", () => {
    const c = cleanHealthInput({ ...emptyHealth(), medications: "  ", notes: " Inhaler in bag ", blood_group: "Z+" as never });
    expect(c.medications).toBeNull();
    expect(c.notes).toBe("Inhaler in bag");
    expect(c.blood_group).toBeNull();
  });
  it("knows an untouched form from a filled one", () => {
    expect(isHealthEmpty(emptyHealth())).toBe(true);
    expect(isHealthEmpty({ ...emptyHealth(), doctor_name: "   " })).toBe(true);
    expect(isHealthEmpty({ ...emptyHealth(), allergies: ["Eggs"] })).toBe(false);
    expect(isHealthEmpty({ ...emptyHealth(), blood_group: "O+" })).toBe(false);
  });
});

describe("healthFlags", () => {
  it("is null when there's nothing a teacher needs to know", () => {
    expect(healthFlags(null)).toBeNull();
    expect(healthFlags({ allergies: [], medical_conditions: [], medications: null, dietary_needs: null, special_needs: " " })).toBeNull();
  });
  it("flags allergies and conditions with a one-line summary", () => {
    const f = healthFlags({ allergies: ["Peanuts", "Eggs"], medical_conditions: ["Asthma"], medications: "Inhaler", dietary_needs: null, special_needs: null });
    expect(f).toEqual({ allergy: true, medical: true, summary: "Allergies: Peanuts, Eggs · Asthma · Takes: Inhaler" });
  });
  it("counts a diet alone as worth showing, but not as medical", () => {
    expect(healthFlags({ allergies: [], medical_conditions: [], medications: null, dietary_needs: "Vegetarian", special_needs: null }))
      .toEqual({ allergy: false, medical: false, summary: "Diet: Vegetarian" });
  });
});

describe("healthToInput", () => {
  it("drops keys and stamps, fills gaps", () => {
    const saved = { ...emptyHealth(), student_id: "s", tenant_id: "t", updated_at: "x", updated_by: null, allergies: ["Dust"] } as StudentHealth;
    const input = healthToInput(saved);
    expect(input.allergies).toEqual(["Dust"]);
    expect("student_id" in input).toBe(false);
    expect(healthToInput(null)).toEqual(emptyHealth());
  });
});
