import { describe, expect, it } from "vitest";
import { validateExamName } from "./exams";
import { validateHomework, type HomeworkInput } from "./homework";

describe("validateExamName", () => {
  it("accepts a name", () => {
    expect(validateExamName("Mock 1", [])).toEqual({ ok: true, name: "Mock 1" });
  });
  it("trims and collapses spaces", () => {
    expect(validateExamName("  End   of Term 3 ", [])).toEqual({ ok: true, name: "End of Term 3" });
  });
  it("needs a name", () => {
    expect(validateExamName("   ", [])).toEqual({ ok: false, message: "Give the exam a name, e.g. Mock 1 or End of Term 3." });
  });
  it("refuses a name already used this term, ignoring case and spacing", () => {
    expect(validateExamName(" mock 1 ", ["Mock 1", "End of Term 3"])).toEqual({ ok: false, message: 'This term already has an exam called "mock 1".' });
  });
  it("lets an exam keep its own name when it is renamed (callers pass the other names)", () => {
    expect(validateExamName("Mock 1", ["End of Term 3"]).ok).toBe(true);
  });
  it("refuses a name that is too long", () => {
    expect(validateExamName("x".repeat(61), []).ok).toBe(false);
    expect(validateExamName("x".repeat(60), []).ok).toBe(true);
  });
});

const hw = (over: Partial<HomeworkInput> = {}): HomeworkInput => ({
  classId: "c1", subjectId: "s1", title: "Exercise 4.2, page 61", body: "", dueOn: "2026-11-05", handIn: "paper", ...over,
});
const TODAY = "2026-10-23";

describe("validateHomework", () => {
  it("accepts a complete form, with empty instructions", () => {
    expect(validateHomework(hw(), TODAY)).toEqual({ ok: true, value: hw() });
  });
  it("trims the title and instructions", () => {
    const r = validateHomework(hw({ title: "  Read   chapter 3 ", body: "  Answer Q1-5.  " }), TODAY);
    expect(r).toEqual({ ok: true, value: hw({ title: "Read chapter 3", body: "Answer Q1-5." }) });
  });
  it("needs a class, a subject and a title", () => {
    expect(validateHomework(hw({ classId: "" }), TODAY)).toEqual({ ok: false, message: "Pick the class." });
    expect(validateHomework(hw({ subjectId: "" }), TODAY)).toEqual({ ok: false, message: "Pick the subject." });
    expect(validateHomework(hw({ title: "  " }), TODAY).ok).toBe(false);
  });
  it("accepts a due date of today but not one in the past", () => {
    expect(validateHomework(hw({ dueOn: TODAY }), TODAY).ok).toBe(true);
    expect(validateHomework(hw({ dueOn: "2026-10-22" }), TODAY)).toEqual({ ok: false, message: "The due date can't be in the past." });
  });
  it("lets existing work keep a past due date when edited", () => {
    expect(validateHomework(hw({ dueOn: "2026-09-01" }), TODAY, { allowPast: true }).ok).toBe(true);
  });
  it.each(["", "05/11/2026", "2026-13-45", "not a date"])("refuses a due date of %j", (bad) => {
    expect(validateHomework(hw({ dueOn: bad }), TODAY).ok).toBe(false);
  });
  it("only accepts the three hand-in methods the database knows", () => {
    for (const h of ["paper", "in_person", "upload"] as const) expect(validateHomework(hw({ handIn: h }), TODAY).ok).toBe(true);
    expect(validateHomework(hw({ handIn: "email" as never }), TODAY).ok).toBe(false);
  });
  it("limits the title and instructions", () => {
    expect(validateHomework(hw({ title: "x".repeat(121) }), TODAY).ok).toBe(false);
    expect(validateHomework(hw({ body: "x".repeat(2001) }), TODAY).ok).toBe(false);
  });
});
