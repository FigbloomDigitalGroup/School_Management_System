import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MY_HR_NOT_READY, type MyHrTab } from "@figbloom/shared";
import { HrRecordCard, MyHrTabBar, NotReady, PayslipDocument, TabBody, type TabBodyProps } from "./MyHrViews";

const html = (props: Partial<TabBodyProps> & { tab: MyHrTab }) =>
  renderToStaticMarkup(createElement(TabBody, { loading: false, error: null, data: null, ...props }));
const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

describe("the My HR tab bar", () => {
  it("shows the four tabs and marks the open one", () => {
    const out = renderToStaticMarkup(createElement(MyHrTabBar, { tab: "leave", onTab: () => {} }));
    expect(text(out)).toContain("Payslips Leave Attendance KPIs");
    expect(out.match(/role="tab"/g)).toHaveLength(4);
    expect(out).toMatch(/aria-selected="true"[^>]*>Leave</);
    expect(out.match(/aria-selected="true"/g)).toHaveLength(1);
  });
});

describe("each tab", () => {
  for (const tab of ["payslips", "leave", "attendance", "kpis"] as const) {
    it(`${tab}: loading shows a skeleton, not an empty state`, () => {
      const out = html({ tab, loading: true });
      expect(out).toContain("animate-pulse");
      expect(text(out)).not.toMatch(/No |yet/);
    });

    it(`${tab}: an error says what went wrong`, () => {
      const out = html({ tab, error: "HR & Payroll can't be reached right now. Try again in a minute." });
      expect(out).toContain('role="alert"');
      expect(text(out)).toContain("can't be reached right now");
    });

    it(`${tab}: a draft employee (pending_hr) sees that their record isn't ready, and no data`, () => {
      const out = text(html({ tab, data: { status: "pending_hr", message: MY_HR_NOT_READY } }));
      expect(out).toContain("Your HR record isn't ready yet");
      expect(out).toContain("Ask the school's HR administrator.");
      expect(out).not.toMatch(/Ksh|KES|Net pay/);
    });
  }

  it("payslips: empty, then a list with amounts and an Open button per payslip", () => {
    expect(text(html({ tab: "payslips", data: { status: "active", payslips: [] } }))).toContain("No payslips yet");
    const data = { status: "active", payslips: [
      { id: "ps-oct", pay_period: "2026-10", currency: "KES", gross_pay: 50000, total_deductions: 9205, net_pay: 40795, run_status: "paid", paid_at: "2026-10-28T09:00:00Z" },
      { id: "ps-sep", pay_period: "2026-09", currency: "KES", gross_pay: 50000, net_pay: 41000, run_status: "approved", paid_at: null },
    ] };
    const out = html({ tab: "payslips", data, onOpen: () => {} });
    expect(text(out)).toContain("October 2026");
    expect(text(out)).toMatch(/40,795\.00/);
    expect(text(out)).toContain("Approved");
    expect(out.match(/Open the [A-Za-z]+ 2026 payslip/g)).toEqual(["Open the October 2026 payslip", "Open the September 2026 payslip"]);
  });

  it("leave: balances per type and applications with status, approver and approval steps", () => {
    expect(text(html({ tab: "leave", data: { status: "active", balances: [], applications: [] } }))).toMatch(/No leave balances yet.*No leave applications/);
    const out = text(html({ tab: "leave", data: {
      status: "active",
      balances: [{ leave_type: "Annual", accrued_days: 21, used_days: 3, pending_days: 1, available_days: 17 }],
      applications: [{ id: "a1", leave_type: "Sick", start_date: "2026-10-01", end_date: "2026-10-02", days: 2, status: "pending",
        approval: { status: "pending", steps: [
          { position: 1, label: "Head of department", status: "approved", actor_name: "Ann HOD" },
          { position: 2, label: "Head teacher", status: "current", waiting_on: "Mary Principal" },
        ] } }],
    } }));
    expect(out).toContain("ANNUAL");
    expect(out).toContain("17");
    expect(out).toContain("days free to book · 3 used · 1 pending");
    expect(out).toContain("Waiting on Mary Principal");
    expect(out).toContain("1. Head of department: Approved (Ann HOD)");
    expect(out).toContain("Pending");
  });

  it("attendance: empty month, then days with clock-ins, lateness, notices, missed scans and absences", () => {
    expect(text(html({ tab: "attendance", data: { status: "active", days: [] } }))).toContain("No attendance for this month");
    const out = text(html({ tab: "attendance", data: {
      status: "active",
      days: [{ day: "2026-10-01", status: "late", clock_in: "2026-10-01T07:42:00+03:00", clock_out: "16:30:00", hours: 8.8, late_minutes: 12 }],
      possible_absence_notices: [{ start_date: "2026-10-02", end_date: "2026-10-02", reply_by: "2026-10-05" }],
      missed_scan_requests: [{ work_date: "2026-10-03", reason: "Scanner down", status: "pending", approver_name: "HR" }],
      absences_recorded: [{ kind: "unexcused", start_date: "2026-10-09", end_date: "2026-10-09", days: 1, status: "recorded" }],
    } }));
    expect(out).toContain("07:42");
    expect(out).toContain("16:30");
    expect(out).toContain("8.8");
    expect(out).toContain("12 min");
    expect(out).toContain("Possible absences");
    expect(out).toContain("reply by 2026-10-05");
    expect(out).toContain("Missed-scan requests");
    expect(out).toContain("Scanner down");
    expect(out).toContain("Absences recorded");
  });

  it("KPIs: empty period, then targets, achievement, overall score and attendance", () => {
    expect(text(html({ tab: "kpis", data: { status: "active", items: [] } }))).toContain("No KPIs for this period");
    const out = text(html({ tab: "kpis", data: {
      status: "active",
      period: { name: "Term 3 2026" },
      items: [{ name: "Syllabus coverage", target: 100, weight: 40, self_value: 85, actual: 80, achievement: 80 }, { name: "Clubs", target: 2, weight: 10, actual: null, achievement: null }],
      overall: { score: 80, scored: 1, total: 2 },
      attendance: { working_days: 40, present: 36 },
    } }));
    expect(out).toContain("KPIs: Term 3 2026");
    expect(out).toContain("Syllabus coverage");
    expect(out).toContain("OVERALL SCORE");
    expect(out).toContain("80%");
    expect(out).toContain("40%");
    expect(out).toContain("Not scored yet");
    expect(out).toContain("WORKING DAYS");
  });
});

describe("one payslip, laid out for printing", () => {
  const data = { status: "active", payslip: {
    id: "ps-oct", employee_id: "EMP-001", employee_name: "Tom Teacher", pay_period: "2026-10", currency: "KES",
    basic_salary: 45000, house_allowance: 5000, gross_pay: 50000, paye: 6000, nssf_deduction: 1080, shif: 1375, housing_levy: 750,
    total_deductions: 9205, net_pay: 40795, tax_pin: "A001234567Z", bank_name: "KCB", account_number_last4: "4321", run_status: "paid", paid_at: "2026-10-28",
  } };

  it("shows the earnings, deductions, totals and net pay, and is the printable part", () => {
    const out = renderToStaticMarkup(createElement(PayslipDocument, { data, schoolName: "Reu Academy" }));
    const t = text(out);
    expect(out).toContain("my-hr-payslip");
    expect(t).toContain("October 2026");
    expect(t).toContain("Reu Academy");
    expect(t).toMatch(/Basic salary \S+\s?45,000\.00/);
    expect(t).toMatch(/PAYE \S+\s?6,000\.00/);
    expect(t).toMatch(/Gross pay \S+\s?50,000\.00/);
    expect(t).toMatch(/Total deductions \S+\s?9,205\.00/);
    expect(t).toMatch(/Net pay \S+\s?40,795\.00/);
    expect(t).toContain("KCB ····4321");
    expect(t).toContain("A001234567Z");
  });

  it("says so when the answer has no payslip", () => {
    const out = renderToStaticMarkup(createElement(PayslipDocument, { data: { status: "active" } }));
    expect(out).toContain('role="alert"');
  });
});

describe("the record card and the not-ready state", () => {
  it("shows the HR record", () => {
    const out = text(renderToStaticMarkup(createElement(HrRecordCard, { summary: { name: "Tom Teacher", employeeNumber: "EMP-001", jobTitle: "Teacher", department: null, branch: null, startDate: null, company: "Reu Academy Ltd", leavePending: 1 } })));
    expect(out).toContain("Tom Teacher");
    expect(out).toContain("EMP-001");
    expect(out).toContain("REU ACADEMY LTD");
    expect(out).toContain("1 leave request pending");
    expect(out).not.toContain("Department");
  });

  it("not ready says so in the contract's words", () => {
    expect(text(renderToStaticMarkup(createElement(NotReady)))).toContain(MY_HR_NOT_READY);
  });
});
