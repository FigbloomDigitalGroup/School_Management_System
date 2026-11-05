import { describe, expect, it } from "vitest";
import { ADMIN_PAGE_AREA, mayOpenAdminPage } from "./adminAreas";
import { NAV } from "./auth";
import {
  formatPay, isMyHrPending, monthRange, MY_HR_TABS, periodLabel, readAttendance, readKpis, readLeave, readPayslips, readSummary, showsMyHr,
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

describe("reading HR's answers", () => {
  it("knows a draft employee's answer", () => {
    expect(isMyHrPending({ status: "pending_hr" })).toBe(true);
    expect(isMyHrPending({ status: "active" })).toBe(false);
    expect(isMyHrPending(null)).toBe(false);
  });

  it("reads the summary, nested or flat", () => {
    expect(readSummary({ status: "active", employee: { name: "Tom", employee_number: "EMP-1", job_title: "Teacher" } }))
      .toEqual({ name: "Tom", employeeNumber: "EMP-1", jobTitle: "Teacher", department: null });
    expect(readSummary({ full_name: "Ann", number: 7, department: { name: "Sciences" } }).department).toBe("Sciences");
    expect(readSummary(undefined).name).toBeNull();
  });

  it("reads payslips under their likely names and drops ones without an id", () => {
    const p = readPayslips({ payslips: [
      { id: "ps1", period: "2026-10", gross_pay: "50000", total_deductions: 9000, net_pay: 41000, pay_date: "2026-10-28" },
      { id: "ps2", month: 9, year: 2026, gross: 50000, net: 41000, currency: "UGX", has_pdf: false },
      { period: "2026-08" },
    ] });
    expect(p).toHaveLength(2);
    expect(p[0]).toEqual({ id: "ps1", period: "October 2026", gross: 50000, deductions: 9000, net: 41000, currency: "KES", paidOn: "2026-10-28", hasPdf: true });
    expect(p[1]).toMatchObject({ period: "September 2026", currency: "UGX", hasPdf: false });
    expect(readPayslips([{ id: "x", period: "Oct" }])[0]!.period).toBe("Oct");
    expect(readPayslips({})).toEqual([]);
  });

  it("labels pay periods", () => {
    expect(periodLabel("2026-01")).toBe("January 2026");
    expect(periodLabel("2026-13")).toBe("2026-13");
    expect(periodLabel(undefined)).toBe("—");
  });

  it("reads leave balances and applications", () => {
    const l = readLeave({
      balances: [{ leave_type: { name: "Annual" }, entitlement: 21, used: 3, remaining: 18 }],
      applications: [{ id: "a1", type: "Sick", start_date: "2026-10-01", end_date: "2026-10-02", days: 2, status: "approved", approver_name: "Mary" }],
    });
    expect(l.balances).toEqual([{ type: "Annual", entitled: 21, taken: 3, pending: null, balance: 18 }]);
    expect(l.applications[0]).toEqual({ id: "a1", type: "Sick", from: "2026-10-01", to: "2026-10-02", days: 2, status: "approved", approver: "Mary" });
    expect(readLeave(null)).toEqual({ balances: [], applications: [] });
  });

  it("reads attendance days, possible absences and missed-scan requests", () => {
    const a = readAttendance({
      days: [{ date: "2026-10-01", status: "late", clock_in: "2026-10-01T07:42:00+03:00", late_minutes: 12 }, { status: "present" }],
      possible_absences: [{ date: "2026-10-02", message: "No clock-in" }],
      missed_scan_requests: [{ date: "2026-10-03", reason: "Scanner down", status: "pending" }],
    });
    expect(a.days).toEqual([{ date: "2026-10-01", status: "late", clockIn: "2026-10-01T07:42:00+03:00", clockOut: null, lateMinutes: 12 }]);
    expect(a.notices).toEqual([{ date: "2026-10-02", text: "No clock-in", status: null }]);
    expect(a.missedScans[0]).toMatchObject({ text: "Scanner down", status: "pending" });
  });

  it("reads KPIs, with attendance measures as a list or an object", () => {
    const k = readKpis({ period: { name: "Term 3" }, targets: [{ name: "Syllabus coverage", target: "100%", score: 80, weight: 40 }], attendance: { days_present: 18, late_days: 2 } });
    expect(k.period).toBe("Term 3");
    expect(k.targets).toEqual([{ name: "Syllabus coverage", target: "100%", score: "80", weight: 40 }]);
    expect(k.measures).toEqual([{ label: "Days present", value: "18" }, { label: "Late days", value: "2" }]);
    expect(readKpis({ attendance: [{ label: "Punctuality", value: "90%" }] }).measures).toEqual([{ label: "Punctuality", value: "90%" }]);
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
