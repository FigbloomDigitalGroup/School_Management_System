import { describe, expect, it } from "vitest";
import { ADMIN_PAGE_AREA, adminAccessFor, mayOpenAdminPage, type AdminArea } from "./adminAreas";
import {
  HR_LAUNCH_PROBLEMS, HR_PAGE, HR_STATUS_HIDDEN, hrCardState, hrItemMode, hrLaunchProblem, hrLaunchUrl, hrOpensDirectly, hrPagePath,
  isHttpsLink, mayOfferHr, readHrLaunchParams, readHrStatus, showsHrItem, type HrHandoffStatus, type HrStatus,
} from "./hrHandoff";
import type { Role } from "./types";

const SCHOOL = "11111111-1111-4111-8111-111111111111";
const status = (connection: HrStatus["connection"], requestedAt: string | null = null): HrStatus =>
  ({ enabled: true, connection, requestedAt, canRequestHr: true });

describe("open-hr's status answer", () => {
  it("reads the answer, snake_case to camelCase", () => {
    expect(readHrStatus({ enabled: true, connection: "setting_up", requested_at: "2026-11-20T08:30:00.000Z", can_request_hr: true }))
      .toEqual({ enabled: true, connection: "setting_up", requestedAt: "2026-11-20T08:30:00.000Z", canRequestHr: true });
  });

  it("switched off, or an answer it doesn't recognise, is hidden", () => {
    for (const raw of [
      { enabled: false, connection: null, requested_at: null, can_request_hr: false },
      { enabled: false, connection: "connected", requested_at: "2026-11-20T08:30:00Z", can_request_hr: true },
      { enabled: true, connection: "maybe" },
      { enabled: "yes", connection: "connected" },
      null, "connected", [],
    ]) expect(readHrStatus(raw)).toEqual(HR_STATUS_HIDDEN);
  });
});

describe("the HR & Payroll sidebar item (web)", () => {
  it("is there for eligible people whenever HR handoff is on, not only when HR is connected", () => {
    expect(hrItemMode(true, status("connected"))).toBe("launch");
    expect(hrItemMode(true, status("unknown"))).toBe("launch");
    expect(hrItemMode(true, status("setting_up"))).toBe("page");
    expect(hrItemMode(true, status("not_connected"))).toBe("page");
    expect(hrItemMode(true, status("not_connected", "2026-11-20T08:30:00Z"))).toBe("page");
  });

  it("is hidden for anyone else, while switched off, and before the answer is in", () => {
    expect(hrItemMode(false, status("connected"))).toBeNull();
    expect(hrItemMode(true, HR_STATUS_HIDDEN)).toBeNull();
    expect(hrItemMode(true, null)).toBeNull();
    expect(hrItemMode(true, undefined)).toBeNull();
  });

  it("opens directly when connected, or when it couldn't be checked (the launch tab says why)", () => {
    expect(["connected", "unknown", "setting_up", "not_connected", null].map((c) => hrOpensDirectly(c as HrStatus["connection"])))
      .toEqual([true, true, false, false, false]);
  });
});

describe("the HR & Payroll card", () => {
  it("connected / unknown / setting up / not connected / requested", () => {
    expect(hrCardState(status("connected"))).toBe("connected");
    expect(hrCardState(status("unknown"))).toBe("connected");
    expect(hrCardState(status("setting_up", "2026-11-20T08:30:00Z"))).toBe("setting_up");
    expect(hrCardState(status("not_connected"))).toBe("not_connected");
    expect(hrCardState(status("not_connected", "2026-11-20T08:30:00Z"))).toBe("requested");
  });

  it("lives in the admin console, for the same people who may open HR (the fees area)", () => {
    expect(hrPagePath("reu")).toBe("/s/reu/admin/hr");
    expect(ADMIN_PAGE_AREA[HR_PAGE]).toBe("fees");
    expect(mayOpenAdminPage(adminAccessFor("school_admin", [], false), HR_PAGE)).toBe(true);
    expect(mayOpenAdminPage(adminAccessFor("org_admin", [], true), HR_PAGE)).toBe(true);
    expect(mayOpenAdminPage(adminAccessFor("staff", ["fees"], false), HR_PAGE)).toBe(true);
    expect(mayOpenAdminPage(adminAccessFor("teacher", ["people"], false), HR_PAGE)).toBe(false);
  });
});

describe("the launch tab", () => {
  it("its address carries the school's id and slug, and reads back", () => {
    const url = hrLaunchUrl(SCHOOL, "reu-academy");
    expect(url).toBe(`/hr/launch?school=${SCHOOL}&slug=reu-academy`);
    expect(readHrLaunchParams(url.slice(url.indexOf("?")))).toEqual({ tenantId: SCHOOL, slug: "reu-academy" });
  });

  it("a missing or malformed school is no launch; a bad slug is dropped", () => {
    expect(readHrLaunchParams("")).toBeNull();
    expect(readHrLaunchParams("?school=reu")).toBeNull();
    expect(readHrLaunchParams(`?school=${SCHOOL}&slug=//evil.example`)).toEqual({ tenantId: SCHOOL, slug: null });
    expect(readHrLaunchParams(`?school=${SCHOOL}`)).toEqual({ tenantId: SCHOOL, slug: null });
  });

  it("only ever goes to an https address", () => {
    expect(isHttpsLink("https://hr.figbloom.org/handoff?code=x")).toBe(true);
    for (const bad of ["http://hr.example/h", "javascript:alert(1)", "/hr", "", null, undefined, 42]) expect(isHttpsLink(bad)).toBe(false);
  });

  it("maps open-hr's refusals to the spec's messages", () => {
    const cases: [{ status?: number; code?: string } | null, string][] = [
      [{ status: 409, code: "target_not_enabled" }, "not_enabled"],
      [{ status: 409, code: "school_not_linked" }, "not_enabled"],
      [{ status: 409, code: "target_not_linked" }, "setting_up"],
      [{ status: 409, code: "target_no_handoff_url" }, "setting_up"],
      [{ status: 403, code: "forbidden" }, "forbidden"],
      [{ status: 401, code: "unauthorized" }, "session"],
      [{ status: 401 }, "session"],
      [{ status: 429, code: "rate_limited" }, "rate_limited"],
      [{ status: 403, code: "handoff_off" }, "unreachable"],
      [{ status: 503, code: "platform_not_configured" }, "unreachable"],
      [{ status: 503, code: "platform_unavailable" }, "unreachable"],
      [{ status: 502, code: "platform_bad_answer" }, "unreachable"],
      [{}, "unreachable"],
      [null, "unreachable"],
    ];
    for (const [err, problem] of cases) expect(hrLaunchProblem(err)).toBe(problem);
    expect(HR_LAUNCH_PROBLEMS.not_enabled.title).toBe("Figbloom HR isn't set up for your school yet");
    expect(HR_LAUNCH_PROBLEMS.setting_up.title).toBe("Figbloom HR is still being set up");
    expect(HR_LAUNCH_PROBLEMS.session.title).toBe("Your session has ended");
    expect(HR_LAUNCH_PROBLEMS.rate_limited.message).toBe("Too many attempts. Wait a minute and try again.");
    expect(HR_LAUNCH_PROBLEMS.unreachable.title).toBe("We couldn't reach Figbloom HR");
  });
});

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
    expect(mayOfferHr("org_admin", ["fees"], true, true)).toBe(true);
    expect(mayOfferHr("org_admin", ["transport"], true, true)).toBe(false);
    expect(mayOfferHr("teacher", ["people"])).toBe(false);
    expect(mayOfferHr("parent", [])).toBe(false);
  });
});
