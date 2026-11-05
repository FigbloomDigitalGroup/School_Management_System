import { describe, expect, it } from "vitest";
import { ADMIN_PAGE_AREA, mayOpenAdminPage } from "./adminAreas";
import { NAV } from "./auth";
import {
  formatPay, isMyHrPending, monthRange, MY_HR_TABS, periodLabel, readAttendance, readKpis, readLeave, readPayslip, readPayslips, readSummary, showsMyHr,
} from "./myHr";

describe("where My HR is", () => {
  it("is in the teacher, staff and admin consoles", () => {
    expect(NAV.teacher.some((i) => i.to === "teacher/my-hr")).toBe(true);
    expect(NAV.staff.some((i) => i.to === "staff/my-hr")).toBe(true);
    expect(NAV.school_admin.some((i) => i.to === "admin/my-hr")).toBe(true);
    expect(NAV.parent.some((i) => i.to.includes("my-hr"))).toBe(false);
    expect(NAV.student.some((i) => i.to.includes("my-hr"))).toBe(false);
  });

  it("the admin page is one's own (like My account), not an admin area", () => {
    expect(ADMIN_PAGE_AREA["admin/my-hr"]).toBeNull();
    expect(mayOpenAdminPage("all", "admin/my-hr")).toBe(true);
  });

  it("shows only when my_hr_status() says available", () => {
    expect(showsMyHr("available")).toBe(true);
    for (const s of ["off", "not_staff", "not_linked", "not_enabled", null, undefined] as const) expect(showsMyHr(s)).toBe(false);
  });

  it("has the four read-only tabs, in order", () => {
    expect(MY_HR_TABS.map((t) => t.label)).toEqual(["Payslips", "Leave", "Attendance", "KPIs"]);
  });
});

describe("reading HR's answers (bloomHR my_hr_routes.js shapes)", () => {
  it("knows a draft employee's answer", () => {
    expect(isMyHrPending({ status: "pending_hr" })).toBe(true);
    expect(isMyHrPending({ status: "active" })).toBe(false);
    expect(isMyHrPending(null)).toBe(false);
  });

  it("reads the summary", () => {
    expect(readSummary({
      status: "active",
      employee: { employee_number: "EMP-1", name: "Tom Teacher", job_title: "Teacher", department: "Sciences", branch: null, start_date: "2024-01-08", employment_status: "Active" },
      company: { name: "Reu Academy Ltd" }, latest_payslip: null, leave_pending: 2,
    })).toEqual({ name: "Tom Teacher", employeeNumber: "EMP-1", jobTitle: "Teacher", department: "Sciences", branch: null, startDate: "2024-01-08", company: "Reu Academy Ltd", leavePending: 2 });
    expect(readSummary(undefined).name).toBeNull();
  });

  it("reads payslips and drops ones without an id", () => {
    const p = readPayslips({ status: "active", payslips: [
      { id: "ps1", pay_period: "2026-10", country: "Kenya", currency: "KES", basic: 45000, gross_pay: "50000", total_deductions: 9205, net_pay: 40795, run_status: "paid", approved_at: "2026-10-27", paid_at: "2026-10-28T09:00:00Z" },
      { id: "ps2", pay_period: "2026-09-01", currency: "UGX", gross_pay: 50000, net_pay: 41000, run_status: "approved", paid_at: null },
      { pay_period: "2026-08" },
    ] });
    expect(p).toHaveLength(2);
    expect(p[0]).toEqual({ id: "ps1", period: "October 2026", gross: 50000, deductions: 9205, net: 40795, currency: "KES", runStatus: "paid", paidOn: "2026-10-28T09:00:00Z" });
    expect(p[1]).toMatchObject({ period: "September 2026", currency: "UGX", runStatus: "approved", paidOn: null });
    expect(readPayslips({})).toEqual([]);
  });

  it("labels pay periods", () => {
    expect(periodLabel("2026-01")).toBe("January 2026");
    expect(periodLabel("2026-13")).toBe("2026-13");
    expect(periodLabel(undefined)).toBe("—");
  });

  it("reads one payslip's figures into earnings and deductions, leaving out zeros and the full account number", () => {
    const p = readPayslip({ status: "active", payslip: {
      id: "ps1", employee_id: "EMP-1", employee_name: "Tom Teacher", pay_period: "2026-10", currency: "KES",
      basic_salary: 45000, house_allowance: 5000, transport_allowance: 0, earning_items: [{ name: "Exam bonus", amount: 2000, taxable: true }],
      gross_pay: 52000, paye: 6000, paye_tax: 6000, nssf_deduction: 1080, shif: 1375, housing_levy: 750, loan_deduction: 0,
      deduction_items: [{ name: "Staff welfare", amount: 500 }], total_deductions: 9705, net_pay: 42295, tax_relief: 2400,
      tax_pin: "A001", bank_name: "KCB", account_number_last4: "4321", payslip_note: "Thank you", run_status: "paid", paid_at: "2026-10-28",
    } })!;
    expect(p.earnings).toEqual([{ label: "Basic salary", amount: 45000 }, { label: "House allowance", amount: 5000 }, { label: "Exam bonus", amount: 2000 }]);
    expect(p.deductions).toEqual([
      { label: "PAYE", amount: 6000 }, { label: "NSSF", amount: 1080 }, { label: "SHIF", amount: 1375 },
      { label: "Housing levy", amount: 750 }, { label: "Staff welfare", amount: 500 },
    ]);
    expect(p).toMatchObject({ period: "October 2026", gross: 52000, totalDeductions: 9705, net: 42295, taxRelief: 2400, bank: "KCB", accountLast4: "4321", note: "Thank you" });
    expect(JSON.stringify(p)).not.toContain("account_number\"");
    expect(readPayslip({ status: "active" })).toBeNull();
    expect(readPayslip({ status: "active", payslip: {} })).toBeNull();
  });

  it("reads leave balances and applications with their approval chain", () => {
    const l = readLeave({
      status: "active",
      leave_types: [{ id: "lt1", name: "Annual" }],
      balances: [{ leave_type_id: "lt1", leave_type: "Annual", year: 2026, month: null, accrued_days: 21, carried_over_days: 2, used_days: 3, pending_days: 1, available_days: 19 }],
      applications: [
        { id: "a1", leave_type: "Sick", start_date: "2026-10-01", end_date: "2026-10-02", days: 2, status: "pending", reason: "Flu",
          approval: { status: "pending", current_step: 2, steps: [
            { position: 1, label: "Head of department", status: "approved", actor_name: "Ann HOD" },
            { position: 2, label: "Head teacher", status: "current", waiting_on: "Mary Principal" },
          ] } },
        { id: "a2", leave_type: "Annual", start_date: "2026-08-01", end_date: "2026-08-05", days: 5, status: "approved",
          approval: { status: "approved", steps: [{ position: 1, label: "Head teacher", status: "approved", actor_name: "Mary Principal" }] } },
        { id: "a3", leave_type: "Annual", start_date: "2026-07-01", end_date: "2026-07-01", days: 1, status: "rejected", approval: null },
      ],
    });
    expect(l.balances).toEqual([{ type: "Annual", accrued: 21, carriedOver: 2, used: 3, pending: 1, available: 19 }]);
    expect(l.applications[0]).toMatchObject({ type: "Sick", status: "pending", approver: "Mary Principal", reason: "Flu" });
    expect(l.applications[0]!.steps).toEqual([
      { label: "Head of department", status: "approved", who: "Ann HOD" },
      { label: "Head teacher", status: "current", who: "Mary Principal" },
    ]);
    expect(l.applications[1]!.approver).toBe("Mary Principal");
    expect(l.applications[2]).toMatchObject({ approver: null, steps: [] });
    expect(readLeave(null)).toEqual({ balances: [], applications: [] });
  });

  it("reads attendance days, possible absences, missed-scan requests and recorded absences", () => {
    const a = readAttendance({
      status: "active", from: "2026-10-01", to: "2026-10-31",
      days: [{ day: "2026-10-01", status: "late", clock_in: "07:42:00", clock_out: "16:30:00", hours: 8.8, late_minutes: 12 }, { status: "present" }],
      possible_absence_notices: [{ start_date: "2026-10-02", end_date: "2026-10-03", notified_on: "2026-10-04", reply_by: "2026-10-06" }],
      missed_scan_requests: [{ id: "m1", work_date: "2026-10-05", reason: "Scanner down", status: "pending", approver_name: "HR" }],
      absences_recorded: [{ id: "x1", kind: "unexcused", start_date: "2026-10-09", end_date: "2026-10-09", days: 1, note: null, status: "recorded" }],
    });
    expect(a.days).toEqual([{ date: "2026-10-01", status: "late", clockIn: "07:42:00", clockOut: "16:30:00", hours: 8.8, lateMinutes: 12 }]);
    expect(a.notices).toEqual([{ date: "2026-10-02", text: "to 2026-10-03, reply by 2026-10-06", status: null }]);
    expect(a.missedScans).toEqual([{ date: "2026-10-05", text: "Scanner down · to HR", status: "pending" }]);
    expect(a.absences).toEqual([{ date: "2026-10-09", text: "Unexcused · 1 day(s)", status: "recorded" }]);
  });

  it("reads KPIs with HR's achievement, overall score and attendance over the period", () => {
    const k = readKpis({
      status: "active",
      period: { id: "p1", name: "Term 3", starts_on: "2026-09-01", ends_on: "2026-11-30", status: "open" },
      items: [{ name: "Syllabus coverage", unit: "percent", target: 100, weight: 40, self_value: 85, actual_value: 80, auto_value: null, actual: 80, achievement: 80 }],
      overall: { score: 80, scored: 1, total: 1 },
      attendance: { from: "2026-09-01", to: "2026-11-05", working_days: 40, present: 36, late: 3, absent: 1, leave: 2, late_minutes: 45 },
    });
    expect(k.period).toBe("Term 3");
    expect(k.overall).toBe(80);
    expect(k.targets).toEqual([{ name: "Syllabus coverage", target: "100", actual: "80", achievement: 80, weight: 40, self: "85" }]);
    expect(k.measures.map((m) => `${m.label}=${m.value}`)).toEqual(["Working days=40", "Present=36", "Late=3", "Absent=1", "On leave=2", "Minutes late=45"]);
    expect(readKpis({ status: "active", period: null, items: [], overall: { score: null }, attendance: null })).toEqual({ period: null, targets: [], overall: null, measures: [] });
  });

  it("formats pay and month ranges", () => {
    expect(formatPay(null, "KES")).toBe("—");
    expect(formatPay(41000, "KES")).toMatch(/41,000\.00/);
    expect(formatPay(5, "NOT-A-CURRENCY")).toBe("NOT-A-CURRENCY 5.00");
    expect(monthRange("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthRange("2026-12")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });
});
