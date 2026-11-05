import { describe, expect, it } from "vitest";
import { ADMIN_PAGE_AREA, mayOpenAdminPage } from "./adminAreas";
import { NAV } from "./auth";
import { PAGE_ABOUT } from "./guide";
import {
  approvalsState, documentProblem, leaveMode, MAX_LEAVE_DOCUMENT_BYTES, readAccess, readApprovals, readLeaveForm,
  showsLeaveToApprove, showsStaffLeave,
} from "./hrLeave";

describe("hr_leave_access, as the pages read it", () => {
  it("an unknown answer is off: the school's own form stays", () => {
    expect(readAccess(null)).toEqual({ status: "off", approver: false });
    expect(readAccess({ status: "maybe", approver: true })).toEqual({ status: "off", approver: false });
    expect(readAccess({ status: "available", approver: "yes" })).toEqual({ status: "available", approver: false });
  });

  it("the leave page is HR's only while it's available; the old form otherwise; nothing while asking", () => {
    expect(leaveMode(null)).toBe("loading");
    expect(leaveMode({ status: "available", approver: false })).toBe("hr");
    for (const status of ["off", "not_linked", "not_enabled", "not_staff"] as const) expect(leaveMode({ status, approver: true })).toBe("schools");
  });

  it("Leave to approve: approvers while it's available; other staff's leave page: while it's available", () => {
    expect(showsLeaveToApprove({ status: "available", approver: true })).toBe(true);
    expect(showsLeaveToApprove({ status: "available", approver: false })).toBe(false);
    expect(showsLeaveToApprove({ status: "off", approver: true })).toBe(false);
    expect(showsLeaveToApprove(null)).toBe(false);
    expect(showsStaffLeave({ status: "available", approver: false })).toBe(true);
    expect(showsStaffLeave({ status: "not_enabled", approver: false })).toBe(false);
  });
});

describe("the pages and the console", () => {
  it("Leave to approve is in the admin console, open to anyone with it (the shell shows it to approvers only)", () => {
    expect(NAV.school_admin.some((i) => i.to === "admin/leave-to-approve")).toBe(true);
    expect(ADMIN_PAGE_AREA["admin/leave-to-approve"]).toBeNull();
    expect(mayOpenAdminPage(["fees"], "admin/leave-to-approve")).toBe(true);
    expect(mayOpenAdminPage(["leave"], "admin/leave-to-approve")).toBe(true);
  });

  it("other staff have a Leave page; every new page has a guide line", () => {
    expect(NAV.staff.some((i) => i.to === "staff/leave")).toBe(true);
    expect(PAGE_ABOUT["staff/leave"]).toBeTruthy();
    expect(PAGE_ABOUT["admin/leave-to-approve"]).toBeTruthy();
  });
});

describe("HR's answers", () => {
  it("leave/form: types with their rules and balance, and the approval chain", () => {
    const form = readLeaveForm({
      leave_types: [{ id: 7, name: "Annual", allow_half_day: true, document_required: false, max_days: "21", notice_days: 2 }, { name: "no id" }],
      balances: [{ leave_type_id: "7", available_days: 18.5 }],
      approval_chain: [{ label: "Head teacher", approver_name: "Mary" }, { role: "HR" }],
    });
    expect(form.types).toEqual([{ id: "7", name: "Annual", halfDays: true, documentRequired: false, maxDays: 21, noticeDays: 2, available: 18.5 }]);
    expect(form.chain).toEqual(["Head teacher (Mary)", "HR"]);
    expect(readLeaveForm(undefined)).toEqual({ types: [], chain: [] });
  });

  it("approvals: what waits on the person, with an https document link only", () => {
    const items = readApprovals({ approvals: [
      { id: "a1", employee: { name: "Sketch" }, leave_type: "Annual", start_date: "2026-11-12", end_date: "2026-11-13", days: 2, half_day: false,
        document: { url: "https://hr.example/f/a1" }, approval: { steps: [{ label: "Head teacher", status: "current" }] } },
      { application_id: "a2", employee_name: "Tom", document_url: "http://insecure.example/f" },
      { employee_name: "no id" },
    ] });
    expect(items.map((i) => [i.id, i.employee, i.documentUrl])).toEqual([["a1", "Sketch", "https://hr.example/f/a1"], ["a2", "Tom", null]]);
    expect(items[0]!.steps).toEqual([{ label: "Head teacher", status: "current", who: null }]);
  });

  it("approvalsState: approver_not_linked is its own state", () => {
    const on = { status: "available", approver: true } as const;
    expect(approvalsState(on, { loading: false, error: { code: "approver_not_linked", message: "x" }, data: null })).toEqual({ kind: "not_linked" });
    expect(approvalsState(on, { loading: true, error: null, data: null })).toEqual({ kind: "loading" });
    expect(approvalsState(on, { loading: false, error: null, data: { approvals: [] } })).toEqual({ kind: "empty" });
  });
});

describe("a leave document", () => {
  it("up to 5 MB, of the kinds HR takes", () => {
    expect(documentProblem({ size: MAX_LEAVE_DOCUMENT_BYTES, type: "application/pdf" })).toBeNull();
    expect(documentProblem({ size: 1000, type: "image/jpeg" })).toBeNull();
    expect(documentProblem({ size: MAX_LEAVE_DOCUMENT_BYTES + 1, type: "application/pdf" })).toMatch(/larger than 5 MB/);
    expect(documentProblem({ size: 1000, type: "application/zip" })).toMatch(/PDF/);
    expect(documentProblem({ size: 0, type: "application/pdf" })).toMatch(/empty/);
  });
});
