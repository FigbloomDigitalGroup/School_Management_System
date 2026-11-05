/**
 * An in-memory Figbloom HR "My HR" API for tests, as bloomHR's my_hr_routes.js answers (SCHOOLS_HR_PHASE2_CONTRACT.md
 * section 2; bloomHR docs/PLATFORM_EVENTS.md "My HR"): GET summary, payslips, payslips/:id, payslips/:id/pdf (501),
 * leave, attendance?from&to, kpis under HR_BASE, each with x-figbloom-school / x-figbloom-person and a Bearer
 * platform token. It checks the token is one the fake platform issued, resolves the school to an HR company (a
 * linked school only) and the person only through its external_people (source "schools"). Refusals are
 * {error: {code, message}}. Not deployed (the "_shared" prefix keeps the CLI from treating it as a function).
 */

export const HR_BASE = "https://hr.test/api/integrations/my-hr";

export interface FakeEmployee {
  /** HR's employee number. */
  number: string;
  name: string;
  /** onboarding not approved yet: every route answers 200 {"status": "pending_hr"} and nothing else */
  draft?: boolean;
}

/** A published payslip, as salary_history keeps it (the fields HR's my_hr_payslip passes on). */
export type FakePayslip = Record<string, unknown> & { id: string };

export class FakeHr {
  /** Schools' tenants.id -> HR company id (from the platform's /links/resolve). */
  companies = new Map<string, string>();
  /** `${company}:${schools profile id}` -> employee (external_people, source "schools"). */
  people = new Map<string, FakeEmployee>();
  /** employee number -> their published payslips (approved or paid runs only). */
  payslips = new Map<string, FakePayslip[]>();
  /** MY_HR_API_ENABLED */
  enabled = true;
  /** Answer every call with this status (0: unreachable). */
  down: number | null = null;
  /** Answer the next calls with 401 invalid_token (an expired token). */
  rejectNext = 0;
  /** Every call that reached HR, in order. */
  calls: { path: string; search: string; school: string | null; person: string | null; token: string }[] = [];
  /** Answer the routes with this instead (for odd answers). */
  rawAnswer: { status: number; body: string; type: string } | null = null;

  link(school: string, company: string) { this.companies.set(school, company); }

  hire(company: string, person: string, employee: FakeEmployee) { this.people.set(`${company}:${person}`, employee); }

  // deno-lint-ignore require-await
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url.href.startsWith(HR_BASE + "/")) return fail(404, "not_found", "Not found.");
    if (init?.redirect !== "error") throw new Error("my-hr must not follow redirects");
    if (this.down === 0) throw new TypeError("connection refused");
    const headers = new Headers(init?.headers);
    const path = url.pathname.slice(new URL(HR_BASE).pathname.length + 1);
    const token = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
    this.calls.push({ path, search: url.search, school: headers.get("x-figbloom-school"), person: headers.get("x-figbloom-person"), token });
    if (this.down) return fail(this.down, "server_error", "Something went wrong. Try again.");
    if (!this.enabled) return fail(503, "my_hr_off", "My HR isn't available yet.");
    if (!token.startsWith("token-")) return fail(401, "invalid_token", "A platform token is needed.");
    if (this.rejectNext > 0) { this.rejectNext--; return fail(401, "invalid_token", "The platform token isn't valid."); }
    const company = this.companies.get(headers.get("x-figbloom-school") ?? "");
    if (!company) return fail(403, "school_not_linked", "This school isn't connected to Figbloom HR.");
    const employee = this.people.get(`${company}:${headers.get("x-figbloom-person") ?? ""}`);
    if (!employee) return fail(404, "not_linked", "Your HR record isn't ready yet.");
    if (employee.draft) return json({ status: "pending_hr" });
    if (this.rawAnswer) return new Response(this.rawAnswer.body, { status: this.rawAnswer.status, headers: { "content-type": this.rawAnswer.type } });

    const mine = this.payslips.get(employee.number) ?? [];
    const one = /^payslips\/([^/]+)(\/pdf)?$/.exec(path);
    if (one) {
      const slip = mine.find((p) => p.id === decodeURIComponent(one[1]!));
      if (!slip) return fail(404, "not_found", "No such payslip.");
      if (one[2]) return json({ error: { code: "pdf_not_available", message: "HR makes payslip PDFs in the browser." }, payslip_url: `payslips/${slip.id}` }, 501);
      return json({ status: "active", payslip: slip });
    }
    switch (path) {
      case "summary":
        return json({
          status: "active",
          employee: { employee_number: employee.number, name: employee.name, job_title: "Teacher", department: "Academics", branch: null, start_date: "2024-01-08", employment_status: "Active" },
          company: { name: "Reu Academy Ltd" },
          latest_payslip: mine[0] ?? null,
          leave_pending: 0,
        });
      case "payslips":
        return json({ status: "active", payslips: mine.map(({ id, pay_period, currency, gross_pay, total_deductions, net_pay }) => ({ id, pay_period, currency, gross_pay, total_deductions, net_pay, run_status: "paid" })) });
      case "leave":
        return json({ status: "active", leave_types: [{ id: "lt-1", name: "Annual", description: null, deductible: true }], balances: [{ leave_type_id: "lt-1", leave_type: "Annual", year: 2026, month: null, accrued_days: 21, carried_over_days: 0, used_days: 3, pending_days: 0, available_days: 18 }], applications: [] });
      case "attendance": {
        const from = url.searchParams.get("from"), to = url.searchParams.get("to");
        if (from && to && (Date.parse(to) - Date.parse(from)) / 86_400_000 > 92) return fail(400, "bad_request", "Choose a range of 93 days or less.");
        return json({ status: "active", from, to, days: [], possible_absence_notices: [], missed_scan_requests: [], absences_recorded: [] });
      }
      case "kpis":
        return json({ status: "active", period: { id: "p1", name: "Term 3 2026", starts_on: "2026-09-01", ends_on: "2026-11-30", status: "open" }, items: [], overall: { score: null, scored: 0, total: 0 }, attendance: null });
      default:
        return fail(404, "not_found", "Not found.");
    }
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const fail = (status: number, code: string, message: string) => json({ error: { code, message } }, status);
