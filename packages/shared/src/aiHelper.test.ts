import { describe, expect, it } from "vitest";
import {
  AI_HELPER_BILLING_AVAILABLE, cancelCutOff, chargeOnTurnOff, helperChargeReason, helperRefusal, optInActive, optInOutcomeText,
  priceCentsFromKes, rosterSummary,
} from "./aiHelper";

describe("AI_HELPER_BILLING_AVAILABLE", () => {
  it("is off: nobody is charged for the study helper yet", () => {
    expect(AI_HELPER_BILLING_AVAILABLE).toBe(false);
  });
});

describe("optInActive", () => {
  it("is on while the opt-in is on, whatever the term, while billing is off", () => {
    expect(optInActive({ status: "on", termId: "t1" }, false, "t2")).toBe(true);
    expect(optInActive({ status: "on", termId: null }, false, null)).toBe(true);
    expect(optInActive({ status: "off", termId: "t1" }, false, "t1")).toBe(false);
    expect(optInActive(null, false, "t1")).toBe(false);
  });

  it("covers only the term it was made in once billing is on", () => {
    expect(optInActive({ status: "on", termId: "t1" }, true, "t1")).toBe(true);
    expect(optInActive({ status: "on", termId: "t1" }, true, "t2")).toBe(false);
    expect(optInActive({ status: "on", termId: null }, true, null)).toBe(false);
  });
});

describe("helperRefusal", () => {
  const school = { aiEnabled: true, tutorEnabled: true, access: "all" as const, optInActive: false };

  it("lets every learner in when the school gives it to every learner, as before", () => {
    expect(helperRefusal(school)).toBeNull();
  });

  it("says the school has it off when either switch is off, before anything else", () => {
    expect(helperRefusal({ ...school, tutorEnabled: false })).toBe("school_off");
    expect(helperRefusal({ ...school, aiEnabled: false, access: "opt_in", optInActive: true })).toBe("school_off");
  });

  it("asks for a parent's opt-in when the school wants one", () => {
    expect(helperRefusal({ ...school, access: "opt_in" })).toBe("needs_optin");
    expect(helperRefusal({ ...school, access: "opt_in", optInActive: true })).toBeNull();
  });
});

describe("billing", () => {
  it("labels the charge as the database does", () => {
    expect(helperChargeReason(2)).toBe("Bloom study helper, Term 2");
  });

  const charge = { chargedAt: "2026-09-01T08:00:00Z", cancelDays: 7, amountCents: 50_000, invoiceTotalCents: 1_050_000, invoicePaidCents: 0 };

  it("cancels the charge when turned off before the cut-off", () => {
    expect(chargeOnTurnOff({ ...charge, now: new Date("2026-09-05T08:00:00Z") })).toBe("cancel");
    expect(chargeOnTurnOff({ ...charge, now: new Date("2026-09-08T08:00:00Z") })).toBe("cancel");
  });

  it("keeps it after the cut-off", () => {
    expect(chargeOnTurnOff({ ...charge, now: new Date("2026-09-08T08:00:01Z") })).toBe("keep");
    expect(cancelCutOff(charge.chargedAt, 7).toISOString()).toBe("2026-09-08T08:00:00.000Z");
  });

  it("keeps a charge the family has already paid, even before the cut-off", () => {
    const now = new Date("2026-09-02T08:00:00Z");
    expect(chargeOnTurnOff({ ...charge, now, invoicePaidCents: 1_050_000 })).toBe("keep");
    expect(chargeOnTurnOff({ ...charge, now, invoicePaidCents: 1_000_001 })).toBe("keep");
    expect(chargeOnTurnOff({ ...charge, now, invoicePaidCents: 1_000_000 })).toBe("cancel");
  });

  it("with a cut-off of 0 days, a charge stands from the moment it is made", () => {
    expect(chargeOnTurnOff({ ...charge, cancelDays: 0, now: new Date("2026-09-01T08:00:01Z") })).toBe("keep");
  });
});

describe("priceCentsFromKes", () => {
  it("reads shillings as the office types them", () => {
    expect(priceCentsFromKes("500")).toBe(50_000);
    expect(priceCentsFromKes(" 1,500 ")).toBe(150_000);
    expect(priceCentsFromKes("KES 250.50")).toBe(25_050);
    expect(priceCentsFromKes("")).toBe(0);
  });

  it("refuses what isn't a price, and anything over KES 100,000", () => {
    expect(priceCentsFromKes("abc")).toBeNull();
    expect(priceCentsFromKes("-5")).toBeNull();
    expect(priceCentsFromKes("1.234")).toBeNull();
    expect(priceCentsFromKes("100000")).toBe(10_000_000);
    expect(priceCentsFromKes("100001")).toBeNull();
  });
});

describe("optInOutcomeText", () => {
  it("tells the parent what happened, including to the fees once billing is on", () => {
    expect(optInOutcomeText("on", "Amani")).toBe("The study helper is on for Amani.");
    expect(optInOutcomeText("cancelled", "Amani")).toMatch(/taken off the invoice/);
    expect(optInOutcomeText("kept", "Amani")).toMatch(/stays on the invoice/);
    expect(optInOutcomeText("something new", "Amani")).toBe("Saved.");
  });
});

describe("rosterSummary", () => {
  it("counts learners with it on and the month's questions", () => {
    expect(rosterSummary([
      { optInActive: true, questionsThisMonth: 4 },
      { optInActive: false, questionsThisMonth: 2 },
      { optInActive: true, questionsThisMonth: 0 },
    ])).toEqual({ on: 2, questions: 6 });
  });
});
