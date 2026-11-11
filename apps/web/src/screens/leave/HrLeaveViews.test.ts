import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { approvalsState, readLeave, readLeaveForm, type ApprovalsState, type HrLeaveAccess } from "@figbloom/shared";
import { ApprovalsView, HrApplications, HrLeaveForm, type LeaveFormValues } from "./HrLeaveViews";

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const approvals = (state: ApprovalsState, hrButton?: string, extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(ApprovalsView, {
  state, comments: {}, onComment: () => {}, onDecide: () => {}, busyId: null, now: NOW, onReload: () => {}, ...extra,
  hrButton: hrButton ? createElement("button", { type: "button" }, hrButton) : undefined,
}));

const ON: HrLeaveAccess = { status: "available", approver: true };
const NOW = Date.parse("2026-11-05T10:00:00Z");
/** GET approvals as bloomHR's my_hr_routes.js answers it (documents as links valid for 5 minutes). */
const HR_LIST = { status: "active", approvals: [{
  application_id: "app-7", employee: { employee_number: "EMP-7", name: "Sketch Kamau", external_id: "p-1" }, leave_type: "Annual leave",
  start_date: "2026-11-12", end_date: "2026-11-13", days: 2, half_day: false, reason: "My graduation ceremony", status: "pending", step_label: "Head teacher",
  document: { name: "invitation.pdf", url: "https://hr.example/storage/app-7?token=abc", expires_at: "2026-11-05T10:05:00Z" },
  followup_document: null,
  approval: { steps: [{ position: 1, label: "Head teacher", status: "current", waiting_on: "Mary Principal" }] },
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
    expect(t).toContain("My graduation ceremony");
    expect(t).toContain("Your step: Head teacher");
    expect(t).toContain("Head teacher: Current (Mary Principal)");
    expect(out).toContain('href="https://hr.example/storage/app-7?token=abc"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(t).toContain("View invitation.pdf");
    expect(t).toMatch(/Decline.*Approve/);
    expect(out).toContain('id="comment-app-7"');
    expect(out).toMatch(/<button[^>]* disabled=""[^>]*>Decline/);
  });

  it("decline is possible once there is a comment (HR needs one)", () => {
    const out = approvals(approvalsState(ON, { loading: false, error: null, data: HR_LIST }), undefined, { comments: { "app-7": "Exams week" } });
    expect(out).not.toMatch(/<button[^>]* disabled=""[^>]*>Decline/);
  });

  it("a document link past its 5 minutes isn't offered: reload for a new one", () => {
    const out = approvals(approvalsState(ON, { loading: false, error: null, data: HR_LIST }), undefined, { now: Date.parse("2026-11-05T10:06:00Z") });
    expect(out).not.toContain("hr.example/storage");
    expect(text(out)).toContain("invitation.pdf: link expired. Reload");
  });

  it("a document link that isn't https is not shown", () => {
    const data = { approvals: [{ ...HR_LIST.approvals[0], document: { name: "x", url: "javascript:alert(1)", expires_at: null } }] };
    expect(approvals(approvalsState(ON, { loading: false, error: null, data }))).not.toContain("javascript:");
  });
});

describe("the HR leave form", () => {
  /** GET leave/form as bloomHR's my_hr_leave_form() answers it. */
  const FORM = readLeaveForm({
    leave_types: [
      { id: "lt-annual", name: "Annual leave", half_days: true, max_days_per_request: 21, min_notice_days: 3, earliest_start: "2026-11-08",
        one_per_month: false, available_from: null, document: null, balance: { leave_type_id: "lt-annual", available_days: 18 } },
      { id: "lt-sick", name: "Sick leave", half_days: true, max_days_per_request: null, min_notice_days: 0,
        document: { name: "Doctor's note", when: "with_application", within_days: null, required_if_longer_than: null }, balance: null },
    ],
    balances: [{ leave_type_id: "lt-annual", available_days: 18 }],
    approval_chain: [{ position: 1, label: "Head teacher", waiting_on: "Mary Principal", skipped: false }, { position: 2, label: "HR", waiting_on: null, skipped: true }],
    reason_min_length: 10,
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
    expect(t).toContain("3 days' notice (from 8 Nov)");
    expect(t).toContain("half days allowed");
    expect(t).toContain("Half a day");
    expect(t).toContain("Approved by: Head teacher (Mary Principal).");
    expect(t).toContain("up to 3 MB");
    expect(t).toContain("Reason (at least 10 characters)");
  });

  it("can't be sent until it's complete; a type that needs a document needs one", () => {
    expect(form({ typeId: "lt-annual" })).toMatch(/<button[^>]* disabled=""[^>]*>Apply for leave/);
    expect(form({ typeId: "lt-annual", startDate: "2026-11-12", endDate: "2026-11-13", reason: "Too short" })).toMatch(/<button[^>]* disabled=""[^>]*>Apply for leave/);
    expect(form({ typeId: "lt-annual", startDate: "2026-11-12", endDate: "2026-11-13", reason: "My graduation" })).not.toMatch(/<button[^>]* disabled=""[^>]*>Apply for leave/);
    expect(text(form({ typeId: "lt-sick" }))).toContain("Doctor's note (needed)");
    expect(form({ typeId: "lt-sick", startDate: "2026-11-12", endDate: "2026-11-12", reason: "Flu and fever" })).toMatch(/<button[^>]* disabled=""[^>]*>Apply for leave/);
    expect(form({ typeId: "lt-sick", startDate: "2026-11-12", endDate: "2026-11-12", reason: "Flu and fever", documentName: "note.pdf" })).not.toMatch(/<button[^>]* disabled=""[^>]*>Apply for leave/);
  });

  it("HR's refusal (422 leave_rules) shows its sentence and each rule", () => {
    const out = form({ typeId: "lt-annual" }, { refusal: { message: "Not enough days left. Needs 3 days' notice.", problems: ["Not enough days left", "Needs 3 days' notice"] } });
    expect(out).toContain('role="alert"');
    expect(text(out)).toContain("Not enough days left. Needs 3 days' notice.");
    expect(out.match(/<li>/g)).toHaveLength(2);
  });

  it("loading, an error, and no types each say so", () => {
    expect(form({}, { loading: true, form: null })).toContain("animate-pulse");
    expect(form({}, { error: "Your school doesn't handle leave in Figbloom HR." })).toContain('role="alert"');
    expect(text(form({}, { form: { types: [], chain: [], reasonMin: 10 } }))).toContain("No leave types yet");
  });
});

describe("the person's HR applications", () => {
  const LEAVE = readLeave({
    balances: [{ leave_type: "Annual leave", available_days: 16 }],
    applications: [
      { id: "a1", leave_type: "Annual leave", start_date: "2099-01-05", end_date: "2099-01-06", days: 2, status: "pending", reason: "Trip",
        cancellable: true, approval: { steps: [{ label: "Head teacher", status: "current", waiting_on: "Mary Principal" }] } },
      { id: "a2", leave_type: "Sick leave", start_date: "2026-01-05", end_date: "2026-01-05", days: 1, status: "approved", cancellable: false, approval: { steps: [] } },
      { id: "a3", leave_type: "Annual leave", start_date: "2099-02-05", end_date: "2099-02-05", days: 1, status: "approved", approval: { steps: [] } },
    ],
  });
  const html = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(createElement(HrApplications, { leave: LEAVE, loading: false, error: null, onCancel: () => {}, cancellingId: null, ...extra }));

  it("lists each with its status and approval progress; Cancel only where HR says cancellable", () => {
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
