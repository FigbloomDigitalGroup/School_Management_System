import { describe, expect, it } from "vitest";
import { NAV } from "./auth";
import { handlesVisitors, STAFF_TITLE_SUGGESTIONS } from "./otherStaff";

describe("handlesVisitors", () => {
  it("is other staff the office has given the visitor log, and nobody else", () => {
    expect(handlesVisitors({ role: "staff", handles_visitors: true })).toBe(true);
    expect(handlesVisitors({ role: "staff", handles_visitors: false })).toBe(false);
    expect(handlesVisitors({ role: "staff" })).toBe(false);
    // the office and teachers reach visitors their own way, never through this
    expect(handlesVisitors({ role: "teacher", handles_visitors: true })).toBe(false);
    expect(handlesVisitors({ role: "school_admin", handles_visitors: true })).toBe(false);
  });
});

describe("the other staff console", () => {
  it("has notices, items and the account, plus Visitors (hidden without the visitor log)", () => {
    expect(NAV.staff.map((i) => i.to)).toEqual(["staff/visitors", "staff/notices", "staff/items", "staff/account"]);
  });
  it("suggests the jobs the gate and reception accounts became", () => {
    expect(STAFF_TITLE_SUGGESTIONS).toContain("Guard");
    expect(STAFF_TITLE_SUGGESTIONS).toContain("Receptionist");
  });
});
