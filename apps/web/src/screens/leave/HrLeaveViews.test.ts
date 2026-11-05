import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { approvalsState, readLeave, readLeaveForm, type ApprovalsState, type HrLeaveAccess } from "@figbloom/shared";
import { ApprovalsView, HrApplications, HrLeaveForm, type LeaveFormValues } from "./HrLeaveViews";

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const approvals = (state: ApprovalsState, hrButton?: string) => renderToStaticMarkup(createElement(ApprovalsView, {
  state, comments: {}, onComment: () => {}, onDecide: () => {}, busyId: null,
  hrButton: hrButton ? createElement("button", { type: "button" }, hrButton) : undefined,
}));

const ON: HrLeaveAccess = { status: "available", approver: true };
const HR_LIST = { status: "active", approvals: [{
  application_id: "app-7", employee_name: "Sketch Kamau", leave_type: "Annual leave", start_date: "2026-11-12", end_date: "2026-11-13", days: 2,
  reason: "Graduation", document_url: "https://hr.example/files/app-7?token=abc",
  approval: { steps: [{ label: "Head teacher", status: "current", waiting_on: "Mary Principal" }] },
}] };

describe("Leave to approve: the page's states", () => {
  it("still asking: a skeleton, no empty state", () => {
    const out = approvals(approvalsState(null, { loading: true, error: null, data: null }));
    expect(out).toContain("animate-pulse");
    expect(text(out)).not.toMatch(/Nothing/);
  });

  it("not an approver, or the school's leave isn't HR's: nothing to approve here", () => {
    for (const access of [{ status: "available", approver: false }, { status: "off", approver: true }] as HrLeaveAccess[]) {
      expect(text(approvals(approvalsState(access, { loading: false, error: null, data: null })))).toContain("Nothing to approve here");
    }
  });

  it("approver_not_linked: the \"connect once\" message, with the HR & Payroll button when they have it", () => {
    const state = approvalsState(ON, { loading: false, error: { code: "approver_not_linked", message: "Open HR & Payroll once to connect your HR account." }, data: null });
    expect(state.kind).toBe("not_linked");
    const withButton = text(approvals(state, "HR & Payroll"));
    expect(withButton).toContain("Open HR & Payroll once to connect your HR account.");
    expect(withButton).toContain("HR & Payroll");
    expect(withButton).not.toContain("ask the school office");
    expect(text(approvals(state))).toContain("ask the school office");
  });

  it("another error says what went wrong", () => {
    const out = approvals(approvalsState(ON, { loading: false, error: { code: "hr_unavailable", message: "HR & Payroll can't be reached right now. Try again in a minute." }, data: null }));
    expect(out).toContain('role="alert"');
    expect(text(out)).toContain("can't be reached right now");
  });

  it("nothing waiting: an empty state", () => {
    expect(text(approvals(approvalsState(ON, { loading: false, error: null, data: { approvals: [] } })))).toContain("Nothing waiting on you");
  });

  it("a list: who, type, dates, days, reason, document link, the chain so far, a comment box and approve / decline", () => {
    const out = approvals(approvalsState(ON, { loading: false, error: null, data: HR_LIST }));
    const t = text(out);
    expect(t).toContain("Sketch Kamau");
    expect(t).toContain("Annual leave");
    expect(t).toContain("2 days");
    expect(t).toContain("Graduation");
    expect(t).toContain("Head teacher: Current");
    expect(out).toContain('href="https://hr.example/files/app-7?token=abc"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(t).toMatch(/Decline.*Approve/);
    expect(out).toContain('id="comment-app-7"');
  });

  it("a document link that isn't https is not shown", () => {
    const data = { approvals: [{ ...HR_LIST.approvals[0], document_url: "javascript:alert(1)" }] };
    expect(approvals(approvalsState(ON, { loading: false, error: null, data }))).not.toContain("View document");
  });
});

describe("the HR leave form", () => {
  const FORM = readLeaveForm({
    leave_types: [
      { id: "lt-annual", name: "Annual leave", half_days: true, requires_document: false, max_days: 21, notice_days: 3 },
      { id: "lt-sick", name: "Sick leave", requires_document: true },
    ],
    balances: [{ leave_type_id: "lt-annual", available_days: 18 }],
    approval_chain: [{ label: "Head teacher", approver_name: "Mary Principal" }],
  });
  const values = (v: Partial<LeaveFormValues> = {}): LeaveFormValues => ({ typeId: "", startDate: "", endDate: "", halfDay: false, reason: "", documentName: null, ...v });
  const form = (v: Partial<LeaveFormValues>, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(HrLeaveForm, {
    form: FORM, loading: false, error: null, values: values(v), onChange: () => {}, onDocument: () => {}, onSubmit: () => {}, saving: false, ...extra,
  }));

  it("shows HR's types, the rules of the one chosen, the balance and who approves", () => {
    const t = text(form({ typeId: "lt-annual" }));
    expect(t).toContain("Annual leave");
    expect(t).toContain("Sick leave");
    expect(t).toContain("18 days left");
    expect(t).toContain("3 days' notice");
    expect(t).toContain("half days allowed");
    expect(t).toContain("Half a day");
    expect(t).toContain("Approved by: Head teacher (Mary Principal).");
    expect(t).toContain("up to 5 MB");
  });

  it("can't be sent until it's complete; a type that needs a document needs one", () => {
    expect(form({ typeId: "lt-annual" })).toMatch(/<button[^>]* disabled=""[^>]*>Apply for leave/);
    expect(form({ typeId: "lt-annual", startDate: "2026-11-12", endDate: "2026-11-13", reason: "Graduation" })).not.toMatch(/<button[^>]* disabled=""[^>]*>Apply for leave/);
    expect(text(form({ typeId: "lt-sick" }))).toContain("(needed)");
    expect(form({ typeId: "lt-sick", startDate: "2026-11-12", endDate: "2026-11-12", reason: "Flu" })).toMatch(/<button[^>]* disabled=""[^>]*>Apply for leave/);
    expect(form({ typeId: "lt-sick", startDate: "2026-11-12", endDate: "2026-11-12", reason: "Flu", documentName: "note.pdf" })).not.toMatch(/<button[^>]* disabled=""[^>]*>Apply for leave/);
  });

  it("loading, an error, and no types each say so", () => {
    expect(form({}, { loading: true, form: null })).toContain("animate-pulse");
    expect(form({}, { error: "Your school doesn't handle leave in Figbloom HR." })).toContain('role="alert"');
    expect(text(form({}, { form: { types: [], chain: [] } }))).toContain("No leave types yet");
  });
});

describe("the person's HR applications", () => {
  const LEAVE = readLeave({
    balances: [{ leave_type: "Annual leave", available_days: 16 }],
    applications: [
      { id: "a1", leave_type: "Annual leave", start_date: "2099-01-05", end_date: "2099-01-06", days: 2, status: "pending", reason: "Trip",
        approval: { steps: [{ label: "Head teacher", status: "current", waiting_on: "Mary Principal" }] } },
      { id: "a2", leave_type: "Sick leave", start_date: "2026-01-05", end_date: "2026-01-05", days: 1, status: "approved", approval: { steps: [] } },
    ],
  });
  const html = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(HrApplications, { leave: LEAVE, loading: false, error: null, onCancel: () => {}, cancellingId: null, ...extra }));

  it("lists each with its status and approval progress; only one HR still lets go of can be cancelled", () => {
    const t = text(html());
    expect(t).toContain("Annual leave: 16 days left");
    expect(t).toContain("Head teacher: Current (Mary Principal)");
    expect(t).toContain("Pending");
    expect(t).toContain("Approved");
    expect(html().match(/>Cancel</g)).toHaveLength(1);
  });

  it("empty and loading", () => {
    expect(text(html({ leave: { balances: [], applications: [] } }))).toContain("Nothing applied for yet");
    expect(html({ loading: true })).toContain("animate-pulse");
  });
});
