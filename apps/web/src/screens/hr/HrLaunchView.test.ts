import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HR_LAUNCH_PROBLEMS, type HrLaunchProblem } from "@figbloom/shared";
import { HrLaunchView, type HrLaunchViewProps } from "./HrLaunchView";

const text = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const noop = () => {};
const view = (props: Partial<HrLaunchViewProps>) => renderToStaticMarkup(createElement(HrLaunchView, {
  problem: null, stillWorking: false, slug: "reu", cantClose: false, onRetry: noop, onClose: noop, ...props,
}));

describe("the launch tab", () => {
  it("working: only the full-screen orbit loader, labelled 'Opening Figbloom HR', as a polite status", () => {
    const out = view({});
    expect(out).toContain('class="hrl-screen"');
    expect(out).toContain('role="status"');
    expect(out).toContain('aria-live="polite"');
    expect(out).toContain('aria-label="Opening Figbloom HR"');
    expect(out).toContain("hrl-animated");
    expect(out).toContain('viewBox="8 5 48 48"');
    expect(out).toContain('width="120"');
    expect(text(out)).toBe("Opening Figbloom HR . . .");
    expect(out).not.toContain("<button");
  });

  it("after 8 seconds: 'Still working…' under the label", () => {
    expect(text(view({ stillWorking: true }))).toBe("Opening Figbloom HR . . . Still working…");
  });

  it("a problem: the still logo, an alert with a focusable title, the message, Try again and Close tab", () => {
    const out = view({ problem: "unreachable" });
    expect(out).toContain('role="alert"');
    expect(out).not.toContain("hrl-animated");
    expect(out).toContain('width="64"');
    expect(out).toMatch(/<h1 tabindex="-1" class="hrl-title">We couldn&#x27;t reach Figbloom HR<\/h1>/);
    const t = text(out);
    expect(t).toContain(HR_LAUNCH_PROBLEMS.unreachable.message);
    expect(t).toContain("Try again");
    expect(t).toContain("Close tab");
  });

  it("HR not set up for the school: a link to request it on the HR & Payroll page", () => {
    const out = view({ problem: "not_enabled" });
    expect(text(out)).toContain("Figbloom HR isn't set up for your school yet");
    expect(out).toContain('href="/s/reu/admin/hr"');
    expect(text(out)).toContain("Request Figbloom HR");
    // without a school address, no link to guess
    expect(view({ problem: "not_enabled", slug: null })).not.toContain("Request Figbloom HR");
  });

  it("the session has ended: Sign in instead of Try again", () => {
    const out = view({ problem: "session" });
    expect(text(out)).toContain("Your session has ended");
    expect(out).toContain('href="/signin"');
    expect(text(out)).not.toContain("Try again");
  });

  it("every problem has its own title", () => {
    for (const problem of ["not_enabled", "setting_up", "forbidden", "session", "rate_limited", "unreachable"] as HrLaunchProblem[]) {
      expect(text(view({ problem }))).toContain(HR_LAUNCH_PROBLEMS[problem].title);
    }
  });

  it("a tab that can't close itself: a link back to Figbloom Schools", () => {
    const out = view({ problem: "rate_limited", cantClose: true });
    expect(out).toContain('href="/s/reu/admin"');
    expect(text(out)).toContain("Back to Figbloom Schools");
    expect(text(out)).not.toContain("Close tab");
  });
});
