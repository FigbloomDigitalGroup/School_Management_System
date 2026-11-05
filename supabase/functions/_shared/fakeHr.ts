/**
 * An in-memory Figbloom HR "My HR" API for tests (SCHOOLS_HR_PHASE2_CONTRACT.md section 2), behind a fetch
 * function: GET summary, payslips, payslips/:id/pdf, leave, attendance?from&to, kpis under BASE, each with
 * x-figbloom-school / x-figbloom-person and a Bearer platform token. It checks the token is one the fake platform
 * issued, resolves the school to an HR company (a linked school only) and the person only through its
 * external_people (source "schools"). Not deployed (the "_shared" prefix keeps the CLI from treating it as a
 * function).
 */

export const HR_BASE = "https://hr.test/api/integrations/my-hr";

export interface FakeEmployee {
  /** HR's employee number. */
  number: string;
  name: string;
  /** onboarding not approved yet: answers {"status": "pending_hr"} and no pay data */
  draft?: boolean;
}

export class FakeHr {
  /** Schools' tenants.id -> HR company id (from the platform's /links/resolve). */
  companies = new Map<string, string>();
  /** `${company}:${schools profile id}` -> employee (external_people, source "schools"). */
  people = new Map<string, FakeEmployee>();
  /** employee number -> payslip id -> PDF bytes (only approved/published ones exist here). */
  payslipPdfs = new Map<string, Map<string, Uint8Array>>();
  /** MY_HR_API_ENABLED */
  enabled = true;
  /** Answer every call with this status (0: unreachable). */
  down: number | null = null;
  /** Answer the next calls with 401 (an expired token). */
  rejectNext = 0;
  /** Every call that reached HR, in order. */
  calls: { path: string; search: string; school: string | null; person: string | null; token: string }[] = [];
  /** Answer JSON routes with this body instead (for odd answers). */
  rawAnswer: { status: number; body: string; type: string } | null = null;

  link(school: string, company: string) { this.companies.set(school, company); }

  hire(company: string, person: string, employee: FakeEmployee) { this.people.set(`${company}:${person}`, employee); }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url.href.startsWith(HR_BASE + "/")) return json({ error: { code: "not_found" } }, 404);
    if (init?.redirect !== "error") throw new Error("my-hr must not follow redirects");
    if (this.down === 0) throw new TypeError("connection refused");
    const headers = new Headers(init?.headers);
    const path = url.pathname.slice(new URL(HR_BASE).pathname.length + 1);
    const token = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
    this.calls.push({ path, search: url.search, school: headers.get("x-figbloom-school"), person: headers.get("x-figbloom-person"), token });
    if (this.down) return json({ error: { code: "unavailable" } }, this.down);
    if (!this.enabled) return json({ error: { code: "my_hr_disabled", message: "My HR API is off" } }, 503);
    if (!token.startsWith("token-")) return json({ error: { code: "unauthorized" } }, 401);
    if (this.rejectNext > 0) { this.rejectNext--; return json({ error: { code: "unauthorized" } }, 401); }
    const company = this.companies.get(headers.get("x-figbloom-school") ?? "");
    if (!company) return json({ error: { code: "tenant_not_linked" } }, 403);
    const employee = this.people.get(`${company}:${headers.get("x-figbloom-person") ?? ""}`);
    if (!employee) return json({ error: { code: "not_linked", message: "No employee for this person" } }, 404);
    if (this.rawAnswer) return new Response(this.rawAnswer.body, { status: this.rawAnswer.status, headers: { "content-type": this.rawAnswer.type } });

    const pdf = /^payslips\/([^/]+)\/pdf$/.exec(path);
    if (pdf) {
      if (employee.draft) return json({ status: "pending_hr" });
      const bytes = this.payslipPdfs.get(employee.number)?.get(decodeURIComponent(pdf[1]!));
      if (!bytes) return json({ error: { code: "not_found" } }, 404);
      return new Response(bytes.slice().buffer as ArrayBuffer, { headers: { "content-type": "application/pdf", "content-length": String(bytes.length) } });
    }
    if (employee.draft) return json({ status: "pending_hr" });
    switch (path) {
      case "summary":
        return json({ status: "active", employee: { name: employee.name, number: employee.number, job_title: "Teacher", department: "Academics" } });
      case "payslips":
        return json({ payslips: [...(this.payslipPdfs.get(employee.number)?.keys() ?? [])].map((id) => ({ id, period: "2026-10", gross: 50000, net: 41000, currency: "KES" })) });
      case "leave":
        return json({ types: [{ id: "annual", name: "Annual" }], balances: [{ type: "Annual", entitled: 21, taken: 3, balance: 18 }], applications: [] });
      case "attendance":
        return json({ from: url.searchParams.get("from"), to: url.searchParams.get("to"), days: [] });
      case "kpis":
        return json({ period: { name: "Term 3 2026" }, targets: [] });
      default:
        return json({ error: { code: "not_found" } }, 404);
    }
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
