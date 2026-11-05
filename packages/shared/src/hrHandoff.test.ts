import { describe, expect, it } from "vitest";
import type { AdminArea } from "./adminAreas";
import { mayOfferHr, showsHrItem, type HrHandoffStatus } from "./hrHandoff";
import type { Role } from "./types";

describe("the HR & Payroll sidebar item", () => {
  const visible = (role: Role, areas: AdminArea[], status: HrHandoffStatus | null | undefined, acting = false) =>
    showsHrItem(mayOfferHr(role, areas, acting), status);

  it("shows for the school's admin, an org admin acting for the school, and a holder of the fees area, once available", () => {
    expect(visible("school_admin", [], "available")).toBe(true);
    expect(visible("org_admin", [], "available", true)).toBe(true);
    expect(visible("staff", ["fees"], "available")).toBe(true);
    expect(visible("teacher", ["people", "fees"], "available")).toBe(true);
  });

  it("never shows for anyone else, whatever the database says", () => {
    expect(visible("teacher", [], "available")).toBe(false);
    expect(visible("teacher", ["people", "academics"], "available")).toBe(false);
    expect(visible("staff", ["visitors"], "available")).toBe(false);
    expect(visible("parent", [], "available")).toBe(false);
    expect(visible("student", [], "available")).toBe(false);
    expect(visible("driver", ["fees"], "available")).toBe(false);
    expect(visible("super_admin", [], "available")).toBe(false);
    // an org admin outside a school (their organisation console) has no school to open HR for
    expect(visible("org_admin", [], "available")).toBe(false);
  });

  it("hides while switched off, not linked, after a 'no' from the platform, or before the answer is in", () => {
    for (const status of ["off", "forbidden", "not_linked", "not_enabled", null, undefined] as const) {
      expect(visible("school_admin", [], status)).toBe(false);
      expect(visible("staff", ["fees"], status)).toBe(false);
    }
  });

  it("only people who may have it are asked about it", () => {
    expect(mayOfferHr("school_admin", [])).toBe(true);
    expect(mayOfferHr("staff", ["fees"])).toBe(true);
    expect(mayOfferHr("teacher", ["people"])).toBe(false);
    expect(mayOfferHr("parent", [])).toBe(false);
  });
});
