import { describe, expect, it, vi } from "vitest";
import { ADMIN_PAGE_AREA, mayOpenAdminPage } from "./adminAreas";
import { NAV } from "./auth";
import { PAGE_ABOUT } from "./guide";
import { EdgeError } from "./edge";
import {
  applicationReadiness, approvalDecisionMessage, approvalsState, documentNeeded, documentProblem, HR_CONNECT_ONCE, HR_LEAVE_CANCELLED, HR_LEAVE_SENT, isDateOnly,
  leaveDaysWords, leaveMode, leaveProblems, leaveRange, leaveSpanDays, leaveTypeRules, linkExpired, loadApprovals, MAX_LEAVE_DOCUMENT_BYTES, mayDecline,
  readAccess, readApprovals, readLeaveForm, showsLeaveToApprove, showsStaffLeave, type LeaveApplicationDraft,
} from "./hrLeave";

// The calls go to the my-hr function; the answers are what HR's routes send.
const mockInvoke = vi.hoisted(() => vi.fn());
vi.mock("./edge", async (importOriginal) => ({ ...(await importOriginal<typeof import("./edge")>()), invokeEdge: mockInvoke }));

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

describe("HR's answers (bloomHR my_hr_routes.js field names)", () => {
  it("leave/form: types with their rules and balance, the chain without skipped steps, the reason's least length", () => {
    const form = readLeaveForm({
      leave_types: [
        { id: "t1", name: "Annual", half_days: true, max_days_per_request: 21, min_notice_days: 2, earliest_start: "2026-11-07",
          one_per_month: true, available_from: "2027-01-01", document: null, balance: { available_days: 18.5 } },
        { id: "t2", name: "Sick", half_days: true, document: { name: "Doctor's note", when: "with_application", required_if_longer_than: 2 }, balance: null },
        { name: "no id" },
      ],
      approval_chain: [{ label: "Head teacher", waiting_on: "Mary", skipped: false }, { label: "HR", waiting_on: null, skipped: true }],
      reason_min_length: 12,
    });
    expect(form.types[0]).toEqual({ id: "t1", name: "Annual", halfDays: true, document: null, maxDays: 21, noticeDays: 2, earliestStart: "2026-11-07",
      availableFrom: "2027-01-01", onePerMonth: true, available: 18.5 });
    expect(form.types[1]!.document).toEqual({ name: "Doctor's note", withApplication: true, longerThan: 2 });
    expect(form.types).toHaveLength(2);
    expect(form.chain).toEqual(["Head teacher (Mary)"]);
    expect(form.reasonMin).toBe(12);
    expect(readLeaveForm(undefined)).toEqual({ types: [], chain: [], reasonMin: 10 });
    expect(documentNeeded(form.types[1]!, 2)).toBe(false);
    expect(documentNeeded(form.types[1]!, 3)).toBe(true);
    expect(documentNeeded(form.types[0]!, 30)).toBe(false);
  });

  it("approvals: employee, step, documents as https links with their expiry", () => {
    const items = readApprovals({ approvals: [
      { application_id: "a1", employee: { name: "Sketch" }, leave_type: "Annual", start_date: "2026-11-12", end_date: "2026-11-13", days: 2, half_day: false,
        step_label: "Head teacher", document: { name: "note.pdf", url: "https://hr.example/f/a1", expires_at: "2026-11-05T10:05:00Z" },
        followup_document: { name: "followup.pdf", url: "http://insecure.example/f", expires_at: null },
        approval: { steps: [{ label: "Head teacher", status: "current", waiting_on: "Mary" }] } },
      { employee: { name: "no id" } },
    ] });
    expect(items.map((i) => [i.id, i.employee, i.step])).toEqual([["a1", "Sketch", "Head teacher"]]);
    expect(items[0]!.documents).toEqual([
      { name: "note.pdf", url: "https://hr.example/f/a1", expiresAt: "2026-11-05T10:05:00Z" },
      { name: "followup.pdf", url: null, expiresAt: null },
    ]);
    expect(linkExpired(items[0]!.documents[0]!, Date.parse("2026-11-05T10:04:00Z"))).toBe(false);
    expect(linkExpired(items[0]!.documents[0]!, Date.parse("2026-11-05T10:05:00Z"))).toBe(true);
    expect(linkExpired(items[0]!.documents[1]!)).toBe(true);
    expect(items[0]!.steps).toEqual([{ label: "Head teacher", status: "current", who: "Mary", comment: null }]);
  });

  it("approvalsState: approver_not_linked is its own state", () => {
    const on = { status: "available", approver: true } as const;
    expect(approvalsState(on, { loading: false, error: { code: "approver_not_linked", message: "x" }, data: null })).toEqual({ kind: "not_linked" });
    expect(approvalsState(on, { loading: false, error: { code: "approver_no_access", message: "No access" }, data: null })).toEqual({ kind: "error", message: "No access" });
    expect(approvalsState(on, { loading: true, error: null, data: null })).toEqual({ kind: "loading" });
    expect(approvalsState(on, { loading: false, error: null, data: { approvals: [] } })).toEqual({ kind: "empty" });
  });

  it("leave_rules: HR's sentence and problems[] from the refusal", () => {
    const err = new EdgeError("Not enough days. Too short notice.", 422, false, "leave_rules", { error: "x", code: "leave_rules", problems: ["Not enough days", "Too short notice", 3] });
    expect(leaveProblems(err)).toEqual({ message: "Not enough days. Too short notice.", problems: ["Not enough days", "Too short notice"] });
    expect(leaveProblems(new Error("Down"))).toEqual({ message: "Down", problems: [] });
  });
});

describe("a leave document", () => {
  it("up to 3 MB (HR's production takes about 4.5 MB per request), of the kinds HR takes", () => {
    expect(MAX_LEAVE_DOCUMENT_BYTES).toBe(3 * 1024 * 1024);
    expect(documentProblem({ size: MAX_LEAVE_DOCUMENT_BYTES, type: "application/pdf" })).toBeNull();
    expect(documentProblem({ size: 1000, type: "image/jpeg" })).toBeNull();
    expect(documentProblem({ size: MAX_LEAVE_DOCUMENT_BYTES + 1, type: "application/pdf" })).toMatch(/larger than 3 MB/);
    expect(documentProblem({ size: 1000, type: "application/zip" })).toMatch(/PDF/);
    expect(documentProblem({ size: 0, type: "application/pdf" })).toMatch(/empty/);
  });
});

describe("loading Leave to approve from HR", () => {
  const waiting = { approvals: [{ application_id: "a1", employee: { name: "Ann Wanjiru" }, leave_type: "Annual", start_date: "2026-11-09", end_date: "2026-11-11", days: 3 }] };

  it("asks HR's approvals route and returns what waits on this person", async () => {
    mockInvoke.mockResolvedValue(waiting);
    const state = await loadApprovals();
    expect(mockInvoke).toHaveBeenCalledWith("my-hr", { route: "approvals" }, expect.anything());
    expect(state).toMatchObject({ kind: "list", items: [{ id: "a1", employee: "Ann Wanjiru", type: "Annual", days: 3 }] });
  });

  it("says nothing is waiting when HR sends none", async () => {
    mockInvoke.mockResolvedValue({ approvals: [] });
    expect(await loadApprovals()).toEqual({ kind: "empty" });
  });

  it("makes someone HR cannot match to one of its users a state of its own, not a failure", async () => {
    mockInvoke.mockRejectedValue(new EdgeError(HR_CONNECT_ONCE, 409, false, "approver_not_linked"));
    expect(await loadApprovals()).toEqual({ kind: "not_linked" });
  });

  it("passes any other refusal on in HR's own words", async () => {
    mockInvoke.mockRejectedValue(new EdgeError("You can't approve leave for this school.", 403, false, "approver_no_access"));
    await expect(loadApprovals()).rejects.toThrow("You can't approve leave for this school.");
    mockInvoke.mockRejectedValue(new Error("Network request failed"));
    await expect(loadApprovals()).rejects.toThrow("Network request failed");
  });
});

describe("deciding, in words", () => {
  it("says what HR recorded, by the person's name", () => {
    expect(approvalDecisionMessage("approve", "Ann Wanjiru")).toBe("Approved \u2014 Ann Wanjiru's leave goes on in Figbloom HR.");
    expect(approvalDecisionMessage("decline", "Ann Wanjiru")).toBe("Declined \u2014 Ann Wanjiru will see your comment in HR.");
  });

  it("will not decline without a comment, and a comment of spaces is none", () => {
    expect(mayDecline("")).toBe(false);
    expect(mayDecline("   \n ")).toBe(false);
    expect(mayDecline(" No cover for that week ")).toBe(true);
  });

  it("writes the dates and the length as the pages show them", () => {
    expect(leaveRange("2026-11-09", "2026-11-11")).toBe("9 Nov \u2013 11 Nov");
    expect(leaveRange("2026-11-09", "2026-11-09")).toBe("9 Nov");
    expect(leaveRange("2026-11-09T00:00:00Z", "2026-11-11T00:00:00Z")).toBe("9 Nov \u2013 11 Nov");
    expect(leaveRange("2026-11-09", null)).toBe("9 Nov");
    expect(leaveRange(null, null)).toBe("\u2014");
    expect(leaveDaysWords(3, false)).toBe("3 days");
    expect(leaveDaysWords(1, false)).toBe("1 day");
    expect(leaveDaysWords(0.5, true)).toBe("Half a day");
    expect(leaveDaysWords(null, false)).toBeNull();
  });
});

describe("the application form, as the web and the phone both read it", () => {
  const form = readLeaveForm({
    leave_types: [
      { id: "annual", name: "Annual", half_days: true, max_days_per_request: 21, min_notice_days: 2, earliest_start: "2026-11-11", one_per_month: false, available_from: "2027-01-01", document: null, balance: { available_days: 18.5 } },
      { id: "sick", name: "Sick", half_days: false, document: { name: "Doctor's note", when: "with_application", required_if_longer_than: 2 }, balance: { available_days: 1 } },
      { id: "study", name: "Study", half_days: false, document: { name: "Letter", when: "after" }, balance: null },
    ],
    approval_chain: [],
    reason_min_length: 10,
  });
  const draft = (over: Partial<LeaveApplicationDraft> = {}): LeaveApplicationDraft => ({
    typeId: "annual", startDate: "2026-11-16", endDate: "2026-11-18", halfDay: false, reason: "Family wedding in Kisumu", documentName: null, ...over,
  });

  it("knows a real day from a half-typed or impossible one", () => {
    expect(isDateOnly("2026-11-09")).toBe(true);
    expect(isDateOnly("2028-02-29")).toBe(true);
    for (const bad of ["", "2026-11-0", "2026-1-09", "20261109", "2026-02-30", "2027-02-29", "2026-13-01", "2026-11-09 "]) expect(isDateOnly(bad)).toBe(false);
  });

  it("counts calendar days, both ends included, and nothing for a backwards or unfinished range", () => {
    expect(leaveSpanDays("2026-11-09", "2026-11-11")).toBe(3);
    expect(leaveSpanDays("2026-11-09", "2026-11-09")).toBe(1);
    expect(leaveSpanDays("2026-11-11", "2026-11-09")).toBeNull();
    expect(leaveSpanDays("2026-11-09", "2026-11-1")).toBeNull();
  });

  it("says what HR says about a type on one line, and nothing for a type with no rules", () => {
    expect(leaveTypeRules(form.types[0]!)).toBe("18.5 days left \u00b7 up to 21 days at a time \u00b7 2 days' notice (from 11 Nov) \u00b7 can be used from 1 Jan \u00b7 half days allowed");
    expect(leaveTypeRules(form.types[1]!)).toBe("1 day left \u00b7 Doctor's note needed for more than 2 days");
    expect(leaveTypeRules(form.types[2]!)).toBe("Letter to follow");
    expect(leaveTypeRules({ id: "x", name: "X", halfDays: false, document: null, maxDays: null, noticeDays: null, earliestStart: null, availableFrom: null, onePerMonth: false, available: null })).toBe("");
  });

  it("is ready with a type, two real days in order, and a reason of HR's least length", () => {
    expect(applicationReadiness(form, draft())).toMatchObject({ ready: true, needsDocument: false, type: { id: "annual" } });
    expect(applicationReadiness(form, draft({ typeId: "" })).ready).toBe(false);
    expect(applicationReadiness(form, draft({ reason: "  too short " })).ready).toBe(false);
    expect(applicationReadiness(form, draft({ startDate: "2026-11-1" })).ready).toBe(false);
    expect(applicationReadiness(form, draft({ endDate: "2026-11-15" })).ready).toBe(false);
  });

  it("waits for the document when HR wants it with the application: always, or past its day limit", () => {
    // 2 days is not more than the 2 the note is waived for; 3 days is
    expect(applicationReadiness(form, draft({ typeId: "sick", endDate: "2026-11-17" }))).toMatchObject({ needsDocument: false, ready: true });
    expect(applicationReadiness(form, draft({ typeId: "sick" }))).toMatchObject({ needsDocument: true, ready: false });
    expect(applicationReadiness(form, draft({ typeId: "sick", documentName: "note.pdf" }))).toMatchObject({ needsDocument: true, ready: true });
    // a half day is half a day, whatever the dates say
    expect(applicationReadiness(form, draft({ typeId: "sick", halfDay: true, endDate: "2026-11-16" }))).toMatchObject({ needsDocument: false, ready: true });
    // a document that is to follow is not asked for now
    expect(applicationReadiness(form, draft({ typeId: "study" })).needsDocument).toBe(false);
  });

  it("says in one place what happens once HR has taken or cancelled an application", () => {
    expect(HR_LEAVE_SENT).toBe("Sent to Figbloom HR for approval.");
    expect(HR_LEAVE_CANCELLED).toBe("Cancelled in Figbloom HR.");
  });
});
