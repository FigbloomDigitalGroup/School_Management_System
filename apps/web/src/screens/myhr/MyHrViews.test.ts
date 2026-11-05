import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MY_HR_NOT_READY, type MyHrTab } from "@figbloom/shared";
import { HrRecordCard, MyHrTabBar, NotReady, TabBody, type TabBodyProps } from "./MyHrViews";

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
      expect(out).not.toMatch(/KES|Net pay/);
    });
  }

  it("payslips: empty, then a list with amounts and a PDF button per payslip", () => {
    expect(text(html({ tab: "payslips", data: { payslips: [] } }))).toContain("No payslips yet");
    const data = { payslips: [
      { id: "ps-oct", period: "2026-10", gross: 50000, deductions: 9000, net: 41000, currency: "KES", paid_on: "2026-10-28" },
      { id: "ps-sep", period: "2026-09", gross: 50000, net: 41000, has_pdf: false },
    ] };
    const out = html({ tab: "payslips", data, onDownload: () => {} });
    expect(text(out)).toContain("October 2026");
    expect(text(out)).toMatch(/41,000\.00/);
    expect(out.match(/Download the [A-Za-z]+ 2026 payslip/g)).toEqual(["Download the October 2026 payslip"]);
    expect(text(html({ tab: "payslips", data, onDownload: () => {}, downloading: "ps-oct" }))).toContain("Downloading…");
  });

  it("leave: balances per type and applications with status and approver", () => {
    expect(text(html({ tab: "leave", data: { balances: [], applications: [] } }))).toMatch(/No leave balances yet.*No leave applications/);
    const out = text(html({ tab: "leave", data: {
      balances: [{ type: "Annual", entitled: 21, taken: 3, balance: 18 }],
      applications: [{ id: "a1", type: "Sick", start_date: "2026-10-01", end_date: "2026-10-02", days: 2, status: "pending_approval", approver: "Mary Principal" }],
    } }));
    expect(out).toContain("ANNUAL");
    expect(out).toContain("18");
    expect(out).toContain("of 21 days · 3 taken");
    expect(out).toContain("Approver: Mary Principal");
    expect(out).toContain("Pending approval");
  });

  it("attendance: empty month, then days with clock-ins, lateness, possible absences and missed scans", () => {
    expect(text(html({ tab: "attendance", data: { days: [] } }))).toContain("No attendance for this month");
    const out = text(html({ tab: "attendance", data: {
      days: [{ date: "2026-10-01", status: "late", clock_in: "2026-10-01T07:42:00+03:00", clock_out: "16:30", late_minutes: 12 }],
      notices: [{ date: "2026-10-02", message: "No clock-in recorded" }],
      missed_scan_requests: [{ date: "2026-10-03", reason: "Scanner down", status: "pending" }],
    } }));
    expect(out).toContain("07:42");
    expect(out).toContain("16:30");
    expect(out).toContain("12 min");
    expect(out).toContain("Possible absences");
    expect(out).toContain("No clock-in recorded");
    expect(out).toContain("Missed-scan requests");
    expect(out).toContain("Scanner down");
  });

  it("KPIs: empty period, then targets, scores and attendance measures", () => {
    expect(text(html({ tab: "kpis", data: { targets: [] } }))).toContain("No KPIs for this period");
    const out = text(html({ tab: "kpis", data: {
      period: { name: "Term 3 2026" },
      targets: [{ name: "Syllabus coverage", target: "100%", score: 80, weight: 40 }, { name: "Clubs", target: "2" }],
      attendance: { days_present: 18 },
    } }));
    expect(out).toContain("Targets: Term 3 2026");
    expect(out).toContain("Syllabus coverage");
    expect(out).toContain("40%");
    expect(out).toContain("Not scored yet");
    expect(out).toContain("DAYS PRESENT");
  });
});

describe("the record card and the not-ready state", () => {
  it("shows the HR record", () => {
    const out = text(renderToStaticMarkup(createElement(HrRecordCard, { summary: { name: "Tom Teacher", employeeNumber: "EMP-001", jobTitle: "Teacher", department: null } })));
    expect(out).toContain("Tom Teacher");
    expect(out).toContain("EMP-001");
    expect(out).not.toContain("Department");
  });

  it("not ready says so in the contract's words", () => {
    expect(text(renderToStaticMarkup(createElement(NotReady)))).toContain(MY_HR_NOT_READY);
  });
});
