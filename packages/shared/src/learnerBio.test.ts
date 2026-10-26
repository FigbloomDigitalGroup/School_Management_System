import { describe, expect, it } from "vitest";
import { bioChanges, bioFieldList, bioProblem, bioValueLabel, cleanBioValue, splitBioChanges, type LearnerBioInput } from "./learnerBio";

const saved: LearnerBioInput = {
  full_name: "Amani Otieno", date_of_birth: "2014-03-12", gender: "female", birth_cert_no: "123456",
  upi_no: null, nationality: "Kenyan", religion: null, previous_school: null,
};

describe("cleanBioValue", () => {
  it("trims, collapses spaces and turns blanks into null", () => {
    expect(cleanBioValue("previous_school", "  Imara   Primary ")).toBe("Imara Primary");
    expect(cleanBioValue("religion", "   ")).toBeNull();
    expect(cleanBioValue("nationality", null)).toBeNull();
  });
  it("stores certificate and UPI numbers without spaces, upper case", () => {
    expect(cleanBioValue("birth_cert_no", "12 34 56")).toBe("123456");
    expect(cleanBioValue("upi_no", " abc 12d ")).toBe("ABC12D");
  });
});

describe("bioChanges / splitBioChanges", () => {
  it("finds only what really changed", () => {
    const c = bioChanges(saved, { ...saved, birth_cert_no: "123 456", nationality: " Kenyan ", religion: "Christian", upi_no: "a1b2c3" });
    expect(c).toEqual({ religion: "Christian", upi_no: "A1B2C3" });
  });
  it("sends identity fields for approval and applies everyday ones", () => {
    const c = bioChanges(saved, { ...saved, date_of_birth: "2014-03-13", previous_school: "Imara Primary", religion: "" });
    expect(c).toEqual({ date_of_birth: "2014-03-13", previous_school: "Imara Primary" });
    expect(splitBioChanges(c)).toEqual({ now: ["previous_school"], approval: ["date_of_birth"] });
  });
  it("counts clearing a field as a change", () => {
    expect(bioChanges(saved, { ...saved, nationality: "" })).toEqual({ nationality: null });
  });
});

describe("bioProblem", () => {
  const today = new Date(2026, 9, 27);
  it("accepts a sound record", () => expect(bioProblem(saved, today)).toBeNull());
  it("needs a name", () => expect(bioProblem({ ...saved, full_name: "  " }, today)).toMatch(/name/));
  it("refuses a birthday in the future or before 1900", () => {
    expect(bioProblem({ ...saved, date_of_birth: "2026-10-28" }, today)).toMatch(/not possible/);
    expect(bioProblem({ ...saved, date_of_birth: "1899-12-31" }, today)).toMatch(/not possible/);
    expect(bioProblem({ ...saved, date_of_birth: "2026-10-27" }, today)).toBeNull();
  });
  it("refuses numbers longer than the database keeps", () => {
    expect(bioProblem({ ...saved, upi_no: "X".repeat(21) }, today)).toMatch(/UPI/);
  });
});

describe("labels", () => {
  it("reads values and field lists the way people do", () => {
    expect(bioValueLabel("gender", "female")).toBe("Female");
    expect(bioValueLabel("date_of_birth", "2014-03-12")).toBe("12 Mar 2014");
    expect(bioValueLabel("upi_no", null)).toBe("Not set");
    expect(bioFieldList(["date_of_birth", "upi_no"])).toBe("Date of birth, NEMIS UPI number");
  });
});
