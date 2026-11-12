/**
 * An in-memory Figbloom HR "My HR" API for tests, as bloomHR's my_hr_routes.js answers (SCHOOLS_HR_PHASE2_CONTRACT.md
 * section 2; bloomHR docs/PLATFORM_EVENTS.md "My HR"): GET summary, payslips, payslips/:id, payslips/:id/pdf (501),
 * leave, attendance?from&to, kpis under HR_BASE, each with x-figbloom-school / x-figbloom-person and a Bearer
 * platform token. It checks the token is one the fake platform issued, resolves the school to an HR company (a
 * linked school only) and the person only through its external_people (source "schools"). Refusals are
 * {error: {code, message}}. Not deployed (the "_shared" prefix keeps the CLI from treating it as a function).
 *
 * Leave run by HR (SCHOOLS_HR_LEAVE_CONTRACT.md section 2): GET leave/form, POST leave/applications, POST
 * leave/applications/:id/cancel, GET approvals and POST approvals/:id/decide (the approver only through
 * external_logins: approverLink), POST import/leave-history (no person header). An application waits on one HR
 * user (the first step of the chain); approving it is final. Reaching approved, and cancelling an approved one,
 * are put in `events` as HR's outbox would send them (hr.leave.approved / hr.leave.cancelled).
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

/** A type as GET leave/form shows it (bloomHR my_hr_leave_form()), plus whether this fake requires a document with the application. */
export interface FakeLeaveType {
  id: string; name: string; half_days: boolean; max_days_per_request: number | null; min_notice_days: number;
  document: { name: string; when: "with_application" | "after"; within_days: number | null; required_if_longer_than: number | null } | null;
}

export interface FakeApplication {
  id: string;
  company: string;
  /** Schools' person (external_people.external_id) */
  person: string;
  employee: string;
  type: FakeLeaveType;
  start_date: string;
  end_date: string;
  half_day: boolean;
  days: number;
  reason: string;
  status: "pending" | "approved" | "declined" | "cancelled";
  /** the HR user it waits on */
  waiting_on: string;
  document: { name: string; content_type: string; bytes: number } | null;
  decisions: { by: string; decision: string; comment: string | null }[];
}

/** An event HR's outbox would send through the platform. */
export interface FakeHrEvent { type: "hr.leave.approved" | "hr.leave.cancelled"; id: string; occurred_at: string; school: string; data: Record<string, unknown> }

export const ANNUAL = "aaaaaaaa-1111-4111-8111-000000000001";
export const SICK = "aaaaaaaa-1111-4111-8111-000000000002";
export const LEAVE_TYPES: FakeLeaveType[] = [
  { id: ANNUAL, name: "Annual leave", half_days: true, max_days_per_request: 21, min_notice_days: 0, document: null },
  { id: SICK, name: "Sick leave", half_days: true, max_days_per_request: null, min_notice_days: 0,
    document: { name: "Doctor's note", when: "with_application", within_days: null, required_if_longer_than: null } },
];

/** Mon-Fri days from one date to another (a half day is 0.5). */
export function workingDays(from: string, to: string, halfDay = false): number {
  if (halfDay) return 0.5;
  let n = 0;
  for (let d = Date.parse(`${from}T00:00:00Z`); d <= Date.parse(`${to}T00:00:00Z`); d += 86_400_000) {
    const dow = new Date(d).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
  }
  return n;
}

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
  calls: { path: string; search: string; school: string | null; person: string | null; token: string; method: string; body: unknown }[] = [];
  /** `${company}:${schools profile id}` -> HR user id (external_logins: made by the one-click sign-in). */
  approvers = new Map<string, string>();
  /** The HR user every new application waits on, per company (the first step of the chain). */
  firstApprover = new Map<string, string>();
  applications: FakeApplication[] = [];
  /** HR logins that are no longer active members (403 approver_no_access). */
  noAccess = new Set<string>();
  /** source_ids HR's balance refuses on import. */
  refuseImport = new Set<string>();
  events: FakeHrEvent[] = [];
  /** company -> source_id -> imported record (the history import) */
  imported = new Map<string, Map<string, Record<string, unknown>>>();
  private seq = 0;
  /** HR's clock, for the events' occurred_at. */
  clock: () => number = () => Date.now();
  /** Answer the routes with this instead (for odd answers). */
  rawAnswer: { status: number; body: string; type: string } | null = null;

  link(school: string, company: string) { this.companies.set(school, company); }

  hire(company: string, person: string, employee: FakeEmployee) { this.people.set(`${company}:${person}`, employee); }

  /** The person signed in to HR once from Schools (external_logins) as this HR user. */
  approverLink(company: string, person: string, hrUser: string) { this.approvers.set(`${company}:${person}`, hrUser); }

  private emit(type: FakeHrEvent["type"], a: FakeApplication, dates?: { start_date: string; end_date: string; half_day: boolean; days: number }) {
    const school = [...this.companies].find(([, c]) => c === a.company)?.[0] ?? "";
    const d = dates ?? a;
    this.events.push({
      type, id: `evt-${++this.seq}`, occurred_at: new Date(this.clock()).toISOString(), school,
      data: { application_id: a.id, external_id: a.person, employee_number: a.employee, leave_type: a.type.name,
        start_date: d.start_date, end_date: d.end_date, half_day: d.half_day, days: d.days, status: type === "hr.leave.approved" ? "approved" : "cancelled" },
    });
  }

  /** HR changes an approved application's dates: cancelled (old) + approved (new), the same application id. */
  changeDates(id: string, start_date: string, end_date: string) {
    const a = this.applications.find((x) => x.id === id)!;
    const old = { start_date: a.start_date, end_date: a.end_date, half_day: a.half_day, days: a.days };
    Object.assign(a, { start_date, end_date, half_day: false, days: workingDays(start_date, end_date) });
    if (a.status === "approved") { this.emit("hr.leave.cancelled", a, old); this.emit("hr.leave.approved", a); }
  }

  /** An HR administrator cancels an application in HR itself. */
  cancelInHr(id: string) {
    const a = this.applications.find((x) => x.id === id)!;
    const was = a.status;
    a.status = "cancelled";
    if (was === "approved") this.emit("hr.leave.cancelled", a);
  }

  /** HR's my_hr_leave_application(): the application as GET leave and the apply / cancel answers show it. */
  private view(a: FakeApplication) {
    const today = new Date(this.clock()).toISOString().slice(0, 10);
    return {
      id: a.id, leave_type: a.type.name, start_date: a.start_date, end_date: a.end_date, days: a.days, half_day: a.half_day,
      status: a.status, reason: a.reason, submitted_at: null, decision_note: a.decisions[0]?.comment ?? null,
      document_name: a.document?.name ?? null, followup_document_name: null,
      cancellable: a.status === "pending" || (a.status === "approved" && a.start_date > today),
      approval: { status: a.status, current_step: 1, steps: [{ position: 1, label: "Head teacher", status: a.status === "pending" ? "current" : a.status,
        waiting_on: a.status === "pending" ? a.waiting_on : null, actor_name: a.decisions[0]?.by ?? null }] },
    };
  }

  private leaveRoute(method: string, path: string, body: Record<string, unknown>, company: string, person: string, employee: FakeEmployee | undefined): Response | null {
    const hrUser = this.approvers.get(`${company}:${person}`);
    if (path === "approvals" || /^approvals\/[^/]+\/decide$/.test(path)) {
      if (!hrUser) return fail(409, "approver_not_linked", "Open HR & Payroll once to connect your HR account.");
      if (this.noAccess.has(hrUser)) return fail(403, "approver_no_access", "You don't have access to HR for this school. Ask your HR administrator.");
      if (method === "GET" && path === "approvals") {
        const expires = new Date(this.clock() + 5 * 60_000).toISOString();
        return json({ status: "active", approvals: this.applications.filter((a) => a.company === company && a.status === "pending" && a.waiting_on === hrUser).map((a) => ({
          application_id: a.id,
          employee: { employee_number: a.employee, name: this.people.get(`${company}:${a.person}`)?.name ?? null, external_id: a.person },
          leave_type: a.type.name, start_date: a.start_date, end_date: a.end_date, days: a.days, half_day: a.half_day,
          reason: a.reason, submitted_at: null, status: a.status, step_label: "Head teacher",
          document: a.document ? { name: a.document.name, url: `https://hr.test/storage/leave-documents/${a.id}?token=signed`, expires_at: expires } : null,
          followup_document: null,
          approval: this.view(a).approval,
        })) });
      }
      if (method !== "POST") return fail(404, "not_found", "Not found.");
      const id = decodeURIComponent(path.split("/")[1]!);
      const a = this.applications.find((x) => x.id === id && x.company === company);
      if (!a) return fail(404, "not_found", "No such application.");
      if (a.status !== "pending") return fail(409, "already_decided", "This application has already been decided.");
      if (a.waiting_on !== hrUser) return fail(403, "not_your_approval", "You are not the approver for this step.");
      const decision = body.decision;
      if (decision !== "approve" && decision !== "decline") return fail(400, "bad_request", 'decision is "approve" or "decline".');
      if (decision === "decline" && !body.comment) return fail(422, "invalid", "Please give a reason for declining.");
      a.decisions.push({ by: hrUser, decision: String(decision), comment: typeof body.comment === "string" ? body.comment : null });
      a.status = decision === "approve" ? "approved" : "declined";
      if (a.status === "approved") this.emit("hr.leave.approved", a);
      return json({ status: "active", request_status: a.status, application: this.view(a) });
    }
    if (!employee) return fail(404, "not_linked", "Your HR record isn't ready yet.");
    if (method === "GET" && path === "leave/form") {
      const balances = [{ leave_type_id: ANNUAL, leave_type: "Annual leave", year: 2026, month: null, accrued_days: 21, carried_over_days: 0, used_days: 3, pending_days: 0, available_days: 18 }];
      return json({
        status: "active",
        leave_types: LEAVE_TYPES.map((t) => ({ id: t.id, name: t.name, description: null, deductible: true, paid: true, half_days: t.half_days, count_days: "working",
          max_days_per_request: t.max_days_per_request, min_notice_days: t.min_notice_days, earliest_start: null, one_per_month: false,
          service_months_before_use: 0, available_from: null,
          document: t.document ? { name: t.document.name, when: t.document.when, within_days: t.document.within_days, required_if_longer_than: t.document.required_if_longer_than, followup_name: null, followup_within_days: null } : null,
          balance: balances.find((b) => b.leave_type_id === t.id) ?? null })),
        balances,
        approval_chain: [{ position: 1, label: "Head teacher", waiting_on: "Mary Principal", skipped: false }],
        admins_can_act: true, reason_min_length: 10, document_max_bytes: 5 * 1024 * 1024,
      });
    }
    if (method === "POST" && path === "leave/applications") {
      if (typeof body.reason !== "string" || body.reason.trim().length < 10) return fail(400, "bad_request", "Please give a reason of at least 10 characters.");
      // deno-lint-ignore no-explicit-any
      const docIn = body.document as any;
      if (docIn && String(docIn.base64 ?? "").length / 4 * 3 > 5 * 1024 * 1024) return fail(413, "too_large", "The document is larger than 5 MB.");
      const type = LEAVE_TYPES.find((t) => t.id === body.type_id);
      if (!type) return fail(422, "invalid", "That type of leave isn't available to you.");
      const start = String(body.start_date), end = String(body.end_date);
      const days = workingDays(start, end, body.half_day === true);
      const problems: string[] = [];
      if (type.document?.when === "with_application" && !body.document) problems.push(`${type.name} needs a ${type.document.name}`);
      if (type.max_days_per_request !== null && days > type.max_days_per_request) problems.push("You don't have enough days left");
      if (this.applications.some((x) => x.person === person && x.company === company && ["pending", "approved"].includes(x.status) && x.start_date <= end && x.end_date >= start)) {
        problems.push("You already have leave on some of these days");
      }
      if (problems.length) return json({ error: { code: "leave_rules", message: problems.map((p) => `${p}.`).join(" "), problems } }, 422);
      // deno-lint-ignore no-explicit-any
      const doc = body.document as any;
      const a: FakeApplication = {
        id: `bbbbbbbb-2222-4222-8222-${String(++this.seq).padStart(12, "0")}`, company, person, employee: employee.number, type, start_date: start, end_date: end, half_day: body.half_day === true,
        days, reason: String(body.reason ?? ""), status: "pending", waiting_on: this.firstApprover.get(company) ?? "hr-user-principal",
        document: doc ? { name: doc.name, content_type: doc.content_type, bytes: String(doc.base64).length / 4 * 3 - (String(doc.base64).match(/=*$/)?.[0].length ?? 0) } : null, decisions: [],
      };
      this.applications.push(a);
      return json({ status: "active", application: this.view(a) }, 201);
    }
    const cancel = /^leave\/applications\/([^/]+)\/cancel$/.exec(path);
    if (method === "POST" && cancel) {
      const a = this.applications.find((x) => x.id === decodeURIComponent(cancel[1]!) && x.company === company && x.person === person);
      if (!a) return fail(404, "not_found", "No such application.");
      if (!["pending", "approved"].includes(a.status) || (a.status === "approved" && a.start_date <= new Date(this.clock()).toISOString().slice(0, 10))) {
        return fail(409, "not_cancellable", "This leave has already started, so it can no longer be cancelled");
      }
      const was = a.status;
      a.status = "cancelled";
      if (was === "approved") this.emit("hr.leave.cancelled", a);
      return json({ status: "active", application: this.view(a) });
    }
    return null;
  }

  /** HR's my_hr_leave_import(): {dry_run, counts: {<outcome>: n}, results: [{source_id, external_id, outcome, application_id?, message?}]}. */
  private importRoute(body: Record<string, unknown>, company: string): Response {
    if (!Array.isArray(body.records)) return fail(400, "bad_request", "Send {records: [...], dry_run?} as JSON.");
    if (body.records.length > 5000) return fail(400, "bad_request", "Send 5000 records or fewer at a time.");
    const records = body.records as Record<string, unknown>[];
    const dryRun = body.dry_run === true;
    const store = this.imported.get(company) ?? new Map<string, Record<string, unknown>>();
    this.imported.set(company, store);
    const counts: Record<string, number> = {};
    const results = records.map((r) => {
      const id = String(r.source_id ?? "");
      let res: Record<string, unknown>;
      if (!id) res = { outcome: "invalid", message: "source_id is needed (200 characters at most)" };
      else if (store.has(id)) res = { outcome: "already_imported", application_id: `imp-${id}` };
      else if (!this.people.has(`${company}:${r.external_id}`)) res = { outcome: "not_linked", message: "This person is not linked to an HR employee" };
      else if (r.status !== "approved") res = { outcome: "skipped", message: "Only approved leave is imported" };
      else if (this.refuseImport.has(id)) res = { outcome: "refused", message: "Not enough days left" };
      else {
        if (!dryRun) store.set(id, r);
        res = { outcome: dryRun ? "would_import" : "imported", application_id: dryRun ? null : `imp-${id}` };
      }
      counts[String(res.outcome)] = (counts[String(res.outcome)] ?? 0) + 1;
      return { source_id: id || null, external_id: r.external_id ?? null, ...res };
    });
    return json({ status: "active", dry_run: dryRun, counts, results });
  }

  // deno-lint-ignore require-await
  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url.href.startsWith(HR_BASE + "/")) return fail(404, "not_found", "Not found.");
    if (init?.redirect !== "error") throw new Error("my-hr must not follow redirects");
    if (this.down === 0) throw new TypeError("connection refused");
    const headers = new Headers(init?.headers);
    const path = url.pathname.slice(new URL(HR_BASE).pathname.length + 1);
    const token = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
    const method = (init?.method ?? "GET").toUpperCase();
    // deno-lint-ignore no-explicit-any
    let body: any = undefined;
    if (typeof init?.body === "string") { try { body = JSON.parse(init.body); } catch { return fail(400, "bad_request", "The body must be JSON."); } }
    this.calls.push({ path, search: url.search, school: headers.get("x-figbloom-school"), person: headers.get("x-figbloom-person"), token, method, body });
    if (this.down) return fail(this.down, "server_error", "Something went wrong. Try again.");
    if (!this.enabled) return fail(503, "my_hr_off", "My HR isn't available yet.");
    if (!token.startsWith("token-")) return fail(401, "invalid_token", "A platform token is needed.");
    if (this.rejectNext > 0) { this.rejectNext--; return fail(401, "invalid_token", "The platform token isn't valid."); }
    const company = this.companies.get(headers.get("x-figbloom-school") ?? "");
    if (!company) return fail(403, "school_not_linked", "This school isn't connected to Figbloom HR.");
    if (path === "import/leave-history" && method === "POST") return this.importRoute(body ?? {}, company);
    const person = headers.get("x-figbloom-person") ?? "";
    const employee = this.people.get(`${company}:${person}`);
    if (this.rawAnswer) return new Response(this.rawAnswer.body, { status: this.rawAnswer.status, headers: { "content-type": this.rawAnswer.type } });
    if (employee?.draft) return json({ status: "pending_hr" });
    const leave = this.leaveRoute(method, path, body ?? {}, company, person, employee);
    if (leave) return leave;
    if (!employee) return fail(404, "not_linked", "Your HR record isn't ready yet.");

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
        return json({ status: "active", leave_types: [{ id: "lt-1", name: "Annual", description: null, deductible: true }], balances: [{ leave_type_id: "lt-1", leave_type: "Annual", year: 2026, month: null, accrued_days: 21, carried_over_days: 0, used_days: 3, pending_days: 0, available_days: 18 }],
          applications: this.applications.filter((a) => a.company === company && a.person === person).map((a) => this.view(a)) });
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
