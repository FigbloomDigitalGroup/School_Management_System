import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HR_STATUS_HIDDEN, type HrStatus } from "@figbloom/shared";
import { formatRequestDate, HR_PITCH, HrPayrollCard, type HrPayrollCardProps } from "./HrPayrollViews";

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const noop = () => {};
const card = (props: Partial<HrPayrollCardProps>) => renderToStaticMarkup(createElement(HrPayrollCard, {
  schoolName: "Reu Academy", status: null, failed: false, requesting: false, checking: false, error: null,
  onOpen: noop, onRequest: noop, onCheckAgain: noop, ...props,
}));
const status = (connection: HrStatus["connection"], requestedAt: string | null = null): HrStatus =>
  ({ enabled: true, connection, requestedAt, canRequestHr: true });

describe("the HR & Payroll card", () => {
  it("loading: a skeleton shaped like the card", () => {
    const out = card({});
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain("animate-pulse");
    expect(text(out)).not.toMatch(/Request|Open Figbloom HR/);
  });

  it("connected: the pill, the line, Open Figbloom HR with the external mark, and 'Opens in a new tab'", () => {
    const t = text(card({ status: status("connected") }));
    expect(t).toContain("Figbloom HR & Payroll");
    expect(t).toContain("Status: Connected");
    expect(t).toContain("Payroll, payslips, leave and attendance for your team.");
    expect(t).toContain("Open Figbloom HR ↗");
    expect(t).toContain("Opens in a new tab");
    expect(t).not.toContain("Request Figbloom HR");
  });

  it("unknown: offered like connected, without claiming it is", () => {
    const t = text(card({ status: status("unknown") }));
    expect(t).toContain("Open Figbloom HR");
    expect(t).not.toContain("Status:");
  });

  it("setting up: the amber pill, the school's name, and Check again", () => {
    const t = text(card({ status: status("setting_up") }));
    expect(t).toContain("Status: Setting up");
    expect(t).toContain("Figbloom HR is being set up for Reu Academy. The school's admins will receive an email invitation.");
    expect(t).toContain("Check again");
    expect(text(card({ status: status("setting_up"), checking: true }))).toContain("Checking…");
  });

  it("not connected: the pitch and Request Figbloom HR", () => {
    const out = card({ status: status("not_connected") });
    const t = text(out);
    expect(t).toContain("Status: Not connected");
    for (const point of HR_PITCH) expect(t).toContain(point);
    expect(t).toContain("Staff from Figbloom Schools added automatically");
    expect(t).toContain("Request Figbloom HR");
    expect(out).not.toMatch(/<button[^>]*disabled=""[^>]*>[^<]*Request Figbloom HR/);
  });

  it("sending: a spinner and 'Sending request…', the button disabled", () => {
    const out = card({ status: status("not_connected"), requesting: true });
    expect(text(out)).toContain("Sending request…");
    expect(out).toContain("animate-spin");
    expect(out).toMatch(/<button[^>]*disabled=""/);
  });

  it("requested: the blue pill, the date, and a disabled 'Request sent'", () => {
    const at = "2026-11-20T08:30:00.000Z";
    const out = card({ status: status("not_connected", at) });
    const t = text(out);
    expect(t).toContain("Status: Requested");
    expect(t).toContain(`Requested on ${formatRequestDate(at)}. Our team will contact you to set it up.`);
    expect(formatRequestDate(at)).toBe("20 November 2026");
    expect(t).toContain("Request sent");
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>.*Request sent/);
  });

  it("a failed request says why, as an alert", () => {
    const out = card({ status: status("not_connected"), error: "Couldn't send the request. Try again." });
    expect(out).toContain('role="alert"');
    expect(text(out)).toContain("Couldn't send the request. Try again.");
  });

  it("switched off or not for this person: not available", () => {
    expect(text(card({ status: HR_STATUS_HIDDEN }))).toContain("HR & Payroll isn't available for your account.");
  });

  it("the status couldn't be checked: says so, with Try again", () => {
    const out = card({ failed: true });
    expect(out).toContain('role="alert"');
    expect(text(out)).toContain("Try again");
  });
});
