import { describe, expect, it } from "vitest";
import { NAV } from "./auth";
import { containsPhoneNumber, guidePages, PAGE_ABOUT, planSetup, setupSteps, type SetupCounts, type SetupExisting } from "./guide";

const EXISTING: SetupExisting = {
  classNames: ["Grade 4 East"],
  subjectCodes: ["MATH"],
  terms: [{ year: 2026, index: 3 }],
  currentTermId: "t3",
  currentTermExams: ["Opener"],
  currentTermFeeItems: ["Tuition"],
};

const ok = (items: ReturnType<typeof planSetup>) => items.filter((i) => i.action);
const skipped = (items: ReturnType<typeof planSetup>) => items.filter((i) => !i.action).map((i) => [i.label, i.skip]);

describe("planSetup", () => {
  it("keeps good steps and labels them as the admin will read them", () => {
    const items = planSetup([
      { kind: "create_class", name: "Grade 5 East", level: "primary", year: 5, stream: "East" },
      { kind: "create_subject", name: "Kiswahili", code: "kisw", level: "primary", from_year: 1, to_year: 6 },
      { kind: "create_exam", name: "Mid-term" },
      { kind: "create_fee_item", name: "Lunch", amount_shillings: 4500, applies_to: "day", level: null, year: null },
    ], EXISTING, "primary");
    expect(items.map((i) => i.label)).toEqual([
      "Class Grade 5 East (Grade 5)",
      "Subject Kiswahili (KISW) for Grade 1 to Grade 6",
      "Exam Mid-term (out of 100)",
      "Fee item Lunch: KSh 4,500 for day scholars",
    ]);
    expect(items.every((i) => i.skip === null)).toBe(true);
    expect(items[1]!.action).toMatchObject({ code: "KISW", fromYear: 1, toYear: 6 });
  });

  it("leaves out anything that already exists, or that the plan repeats", () => {
    const items = planSetup([
      { kind: "create_class", name: "grade 4 east", level: "primary", year: 4, stream: "East" },
      { kind: "create_class", name: "Grade 6", level: "primary", year: 6, stream: null },
      { kind: "create_class", name: "Grade 6", level: "primary", year: 6, stream: null },
      { kind: "create_subject", name: "Maths", code: "MATH", level: null },
      { kind: "create_exam", name: "opener" },
      { kind: "create_fee_item", name: "TUITION", amount_shillings: 1000, applies_to: "all" },
    ], EXISTING, "primary");
    expect(ok(items).map((i) => i.label)).toEqual(["Class Grade 6 (Grade 6)"]);
    expect(skipped(items)).toEqual([
      ["Class grade 4 east", "Already exists."],
      ["Class Grade 6", "Already exists."],
      ["Subject Maths (MATH)", "A subject already has the code MATH."],
      ["Exam opener", "This term already has an exam called \"opener\"."],
      ["Fee item TUITION", "This term already has a fee item with that name."],
    ]);
  });

  it("holds every step to the school's own levels and years", () => {
    const items = planSetup([
      { kind: "create_class", name: "Form 2 North", level: "secondary", year: 2, stream: "North" },
      { kind: "create_class", name: "Grade 13", level: "senior_school", year: 13, stream: null },
      { kind: "create_class", name: "Grade 9", level: "primary", year: 9, stream: null },
      { kind: "create_fee_item", name: "Trip", amount_shillings: 2000, applies_to: "form_level", level: "secondary", year: 4 },
    ], EXISTING, "primary");
    expect(ok(items)).toEqual([]);
    expect(items.map((i) => i.skip)).toEqual([
      "This school doesn't run secondary (8-4-4) classes.",
      "This school doesn't run senior school classes.",
      "Primary has no Grade 9.",
      "It needs a year group this school has.",
    ]);
  });

  it("starts a term first, so the plan's exams and fee items go into it", () => {
    const items = planSetup([
      { kind: "create_exam", name: "Opener" },
      { kind: "start_term", term_year: 2027, term_index: 1, starts_on: "2027-01-05", ends_on: "2027-04-02" },
      { kind: "create_fee_item", name: "Tuition", amount_shillings: 15000, applies_to: "all" },
    ], EXISTING, "primary");
    expect(items.map((i) => i.action?.kind)).toEqual(["start_term", "create_exam", "create_fee_item"]);
    expect(items.every((i) => i.skip === null)).toBe(true);
    expect(items[0]!.label).toBe("Start Term 1, 2027 (2027-01-05 to 2027-04-02), and make it the current term");
  });

  it("refuses a term that exists, runs backwards, or comes twice", () => {
    const items = planSetup([
      { kind: "start_term", term_year: 2026, term_index: 3, starts_on: "2026-08-24", ends_on: "2026-10-30" },
      { kind: "start_term", term_year: 2027, term_index: 1, starts_on: "2027-01-05", ends_on: "2027-04-02" },
    ], EXISTING, "primary");
    expect(items.map((i) => i.skip)).toEqual(["That term already exists. Make it current in School settings.", "Only one new term at a time."]);
    expect(planSetup([{ kind: "start_term", term_year: 2027, term_index: 2, starts_on: "2027-05-01", ends_on: "2027-04-01" }], EXISTING, "primary")[0]!.skip)
      .toBe("It ends before it starts.");
  });

  it("puts nothing into a term that doesn't exist", () => {
    const items = planSetup([{ kind: "create_exam", name: "Opener" }], { ...EXISTING, currentTermId: null }, "primary");
    expect(items[0]!.skip).toMatch(/no current term/);
  });

  it("rejects malformed steps and fee amounts that look like slips", () => {
    const items = planSetup([
      { kind: "delete_class", name: "Grade 4 East" },
      { kind: "create_class", name: "", level: "primary", year: 3 },
      { kind: "create_fee_item", name: "Tuition 2", amount_shillings: 15000.5, applies_to: "all" },
      { kind: "create_fee_item", name: "Tuition 3", amount_shillings: 90_000_000, applies_to: "all" },
      null,
    ], EXISTING, "combined");
    expect(ok(items)).toEqual([]);
    expect(items.map((i) => i.skip)).toEqual([
      "The guide can't do this.",
      "Not enough detail to create it.",
      "It needs a name and an amount in whole shillings.",
      "It needs a name and an amount in whole shillings.",
      "The guide can't do this.",
    ]);
  });
});

describe("containsPhoneNumber", () => {
  it("spots Kenyan and international numbers however they're written", () => {
    for (const n of ["0712345678", "0712 345 678", "0112-345-678", "+254 712 345 678", "254712345678", "+44 20 7946 0958"]) {
      expect(containsPhoneNumber(`call ${n} please`), n).toBe(true);
    }
  });
  it("leaves amounts, years, dates and codes alone", () => {
    for (const t of ["KSh 45,000", "15000 shillings", "Term 1, 2027", "2027-01-05 to 2027-04-02", "Grade 7 East", "MATH101", "1500000"]) {
      expect(containsPhoneNumber(t), t).toBe(false);
    }
  });
});

describe("guidePages", () => {
  it("describes every page in the consoles the guide is in", () => {
    for (const role of ["school_admin", "teacher", "staff", "org_admin"] as const) {
      for (const item of NAV[role]) expect(PAGE_ABOUT[item.to], `${role} ${item.to}`).toBeTruthy();
    }
    expect(guidePages([{ to: "admin/fees", label: "Fees" }])[0]!.about).toMatch(/invoice/);
  });
});

describe("setupSteps", () => {
  const EMPTY: SetupCounts = {
    hasPaymentDetails: false, hasCrest: false, currentTerm: null, classes: 0, subjects: 0, teachers: 0,
    assignments: 0, learners: 0, guardians: 0, feeItems: 0, invoices: 0, exams: 0,
  };

  it("starts a new school at the term, with the assistant offered for what it can set up", () => {
    const steps = setupSteps(EMPTY);
    expect(steps[0]).toMatchObject({ key: "term", done: false, to: "admin/settings" });
    expect(steps.every((s) => !s.done)).toBe(true);
    // with no term there's nowhere to put exams or fee items yet
    expect(steps.find((s) => s.key === "exams")!.ask).toBeNull();
    expect(steps.find((s) => s.key === "classes")!.ask).toMatch(/Set up our classes/);
  });

  it("says what's already there", () => {
    const steps = setupSteps({ ...EMPTY, currentTerm: "Term 3, 2026", classes: 12, learners: 1, guardians: 2, assignments: 1, exams: 3 });
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));
    expect(byKey.term!.detail).toBe("Term 3, 2026 is the current term.");
    expect(byKey.classes!.detail).toBe("12 classes so far.");
    expect(byKey.learners!.detail).toBe("1 learner and 2 parents and guardians.");
    expect(byKey.assignments!.detail).toBe("1 class subject has a teacher.");
    expect(byKey.exams).toMatchObject({ done: true, ask: null });
    expect(byKey.fees!.ask).toMatch(/fee items/);
  });

  it("only links pages a full admin has", () => {
    for (const s of setupSteps(EMPTY)) expect(PAGE_ABOUT[s.to], s.to).toBeTruthy();
  });
});
