import { describe, expect, it } from "vitest";
import { formatLoginId, homeRouteFor, loginIdEmail, ROLE_ID_PREFIX, studentLoginEmail, validateOtp, validatePin } from "./auth";

describe("validateOtp", () => {
  it("accepts a plain 6-digit code", () => {
    expect(validateOtp("123456")).toEqual({ ok: true, message: "" });
  });
  it("strips spaces before validating", () => {
    expect(validateOtp("123 456")).toEqual({ ok: true, message: "" });
  });
  it("silently waits (no error) while still short", () => {
    expect(validateOtp("123")).toEqual({ ok: false, message: "" });
  });
  it("rejects a full-length but non-numeric code", () => {
    expect(validateOtp("12345a")).toEqual({ ok: false, message: "The code is six numbers." });
  });
});

describe("studentLoginEmail", () => {
  it("is deterministic and tenant-scoped", () => {
    expect(studentLoginEmail("4102", "alliance")).toBe("adm4102@students.alliance.figbloom.internal");
    expect(studentLoginEmail("4102", "kenya-high")).not.toBe(studentLoginEmail("4102", "alliance"));
  });
});

describe("formatLoginId", () => {
  it("zero-pads to 4 digits", () => {
    expect(formatLoginId("TC", 1)).toBe("TC-0001");
    expect(formatLoginId("ST", 42)).toBe("ST-0042");
  });
  it("does not truncate a number already 4+ digits", () => {
    expect(formatLoginId("PT", 12345)).toBe("PT-12345");
  });
});

describe("ROLE_ID_PREFIX", () => {
  it("has one prefix per non-org-owner role, and no entry for org_admin/super_admin", () => {
    expect(ROLE_ID_PREFIX).toEqual({ school_admin: "AD", teacher: "TC", parent: "PT", student: "ST", driver: "BD" });
  });
});

describe("loginIdEmail", () => {
  it("is deterministic, tenant-scoped, and lowercases the id", () => {
    expect(loginIdEmail("TC-0001", "alliance")).toBe("tc-0001@login.alliance.figbloom.internal");
    expect(loginIdEmail("TC-0001", "kenya-high")).not.toBe(loginIdEmail("TC-0001", "alliance"));
  });
});

describe("validatePin", () => {
  it("accepts a plain 4-digit PIN that isn't an obvious pattern", () => {
    expect(validatePin("7391")).toEqual({ ok: true, message: "" });
  });
  it("rejects anything not exactly 4 digits", () => {
    expect(validatePin("123").ok).toBe(false);
    expect(validatePin("12345").ok).toBe(false);
    expect(validatePin("abcd").ok).toBe(false);
  });
  it("rejects four repeated digits", () => {
    expect(validatePin("1111").ok).toBe(false);
  });
  it("rejects the well-known weak PINs", () => {
    expect(validatePin("1234").ok).toBe(false);
    expect(validatePin("0000").ok).toBe(false);
  });
});

describe("homeRouteFor", () => {
  it("sends super_admin to the platform console, ignoring slug", () => {
    expect(homeRouteFor("super_admin", null)).toBe("/platform/tenants");
  });
  it("tenant-scopes every other role under /s/<slug>", () => {
    expect(homeRouteFor("school_admin", "alliance")).toBe("/s/alliance/admin");
    expect(homeRouteFor("teacher", "alliance")).toBe("/s/alliance/teacher/attendance");
    expect(homeRouteFor("parent", "alliance")).toBe("/s/alliance/parent");
    expect(homeRouteFor("student", "alliance")).toBe("/s/alliance/student");
    expect(homeRouteFor("driver", "alliance")).toBe("/s/alliance/driver");
  });
  it("sends org_admin to their organization's own console, not /s/<slug> or /platform", () => {
    expect(homeRouteFor("org_admin", "nakuru-county")).toBe("/org/nakuru-county/dashboard");
  });
  it("a k12 teacher lands on Attendance; a higher-ed teacher (lecturer) lands on their sections instead", () => {
    expect(homeRouteFor("teacher", "alliance", "k12")).toBe("/s/alliance/teacher/attendance");
    expect(homeRouteFor("teacher", "some-college", "higher_ed")).toBe("/s/some-college/teacher/sections");
  });
});
