import { describe, expect, it } from "vitest";
import { describeHealthConsent, type HealthConsent } from "./healthConsent";

const base: HealthConsent = {
  studentId: "s1", status: null, method: null, guardianName: null, recordedByName: null,
  signedBy: null, formDate: null, changedAt: null, hasDetails: false,
};

describe("describeHealthConsent", () => {
  it("no decision and nothing on file", () => {
    expect(describeHealthConsent(base)).toBe("No decision yet");
  });
  it("details saved before consent was asked for", () => {
    expect(describeHealthConsent({ ...base, hasDetails: true })).toBe("Consent not recorded");
  });
  it("a guardian agreed in the app", () => {
    expect(describeHealthConsent({ ...base, status: "given", method: "app", guardianName: "Grace Odhiambo", changedAt: "2026-11-03T08:00:00Z" }))
      .toBe("Given in the app by Grace Odhiambo on 3 Nov 2026");
  });
  it("the office recorded a signed form", () => {
    expect(describeHealthConsent({ ...base, status: "given", method: "paper", signedBy: "Grace Odhiambo", formDate: "2026-01-06", recordedByName: "Check Principal" }))
      .toBe("Given on a signed form (Grace Odhiambo, 6 Jan 2026), recorded by Check Principal");
  });
  it("the office withdrew at a parent's request", () => {
    expect(describeHealthConsent({ ...base, status: "withdrawn", method: "paper", signedBy: "Peter Odhiambo", recordedByName: "Check Principal" }))
      .toBe("Withdrawn at Peter Odhiambo's request, recorded by Check Principal");
  });
});
