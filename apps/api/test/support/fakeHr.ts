import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake Figbloom platform and Figbloom HR for the My HR and HR & Payroll hand-off tests: one local HTTP server that is the
 * platform's token endpoint (POST /oauth2/token, Cognito-style client credentials), the platform's own API (POST /handoffs,
 * GET /tenants/{id}/modules/hr and /links/hr, under /platform-api) and HR's "My HR" API (GET /api/integrations/my-hr/*),
 * modelled on supabase/functions/_shared/fakeHr.ts and fakePlatform.ts. Nothing here talks to a real HR or platform, and the
 * credentials are made up for the test. HR answers only for a school it has linked, and for a person only through its own
 * people list (the API's user id, as HR's external id), as bloomHR does. The platform knows a school only once it is
 * registered (`platformTenants`), and signs a person in only when HR is on for the school and its company is linked.
 */

export const FAKE_CLIENT_ID = "schools-client-test";
export const FAKE_CLIENT_SECRET = "schools-secret-test-not-real";
export const FAKE_SCOPE = "platform/tenants.read platform/tenants.write";

export interface FakeEmployee {
  number: string;
  name: string;
  /** onboarding not approved yet: every route answers 200 {"status": "pending_hr"} */
  draft?: boolean;
}

export type FakePayslip = Record<string, unknown> & { id: string };

export interface FakeHrCall {
  method: string;
  /** under the HR base, e.g. "payslips/abc" */
  path: string;
  search: string;
  school: string | null;
  person: string | null;
  token: string;
  /** every request header, lower-cased, so a test can check what was and was not sent */
  headers: Record<string, string | string[] | undefined>;
}

export class FakeHr {
  private server: Server;
  port = 0;
  /** tenants.id -> HR company */
  companies = new Map<string, string>();
  /** `${company}:${user id}` -> employee */
  people = new Map<string, FakeEmployee>();
  /** employee number -> published payslips */
  payslips = new Map<string, FakePayslip[]>();
  /** what HR's attendance answer lists (empty by default) */
  attendanceDays: Record<string, unknown>[] = [];
  /** what HR's kpis answer lists (empty by default) */
  kpiItems: Record<string, unknown>[] = [];
  /** HR's own switch (MY_HR_API_ENABLED): off answers 503 my_hr_off */
  enabled = true;
  /** answer every HR call with this status; 0 drops the connection */
  down: number | null = null;
  /** answer the next N HR calls with 401 invalid_token (a revoked token) */
  rejectNext = 0;
  /** hold every HR answer back this long */
  delayMs = 0;
  /** answer HR calls with this instead (odd answers) */
  rawAnswer: { status: number; body: string; type: string; headers?: Record<string, string> } | null = null;
  /** answer HR calls with a redirect to this address */
  redirectTo: string | null = null;
  /** HR calls that reached HR with a platform token, in order */
  calls: FakeHrCall[] = [];
  // ------------------------------------------------------------ the token endpoint
  tokensIssued = 0;
  tokenSeconds = 3600;
  /** answer the token endpoint with this status (400 invalid_client for example) instead of a token */
  tokenStatus: number | null = null;
  tokenDelayMs = 0;
  tokenCalls: { authorization: string; contentType: string; body: string }[] = [];
  // ------------------------------------------------------------ the platform's own API (PLATFORM_API_URL)
  platformCalls: { method: string; path: string; body: string; token: string }[] = [];
  platformRejectNext = 0;
  /** For any path the platform part below does not know: answer this. */
  platformStatus = 200;
  platformBody: unknown = { ok: true };
  // The HR & Payroll hand-off (docs/HR-HANDOFF.md, H1), modelled on supabase/functions/_shared/fakePlatform.ts:
  /** schools the platform knows: our tenants.id -> the platform's own id for it (registration) */
  platformTenants = new Map<string, string>();
  /** per platform id: HR's module status ("active" when switched on; missing means never switched on) */
  hrModules = new Map<string, string>();
  /** HR has not registered where it accepts sign-ins: POST /handoffs answers 409 target_no_handoff_url */
  noHandoffUrl = false;
  /** what the module lookup says about caching (seconds), when set */
  moduleCacheSeconds: number | null = null;
  /** answer the hand-off routes with this instead (odd answers): status, body, content type */
  handoffRaw: { status: number; body: string; type: string } | null = null;
  /** answer every platform call with this status; 0 drops the connection */
  platformDown: number | null = null;
  /** hold every platform answer back this long */
  platformDelayMs = 0;
  /** links handed out (url and the one-time code in it), so a test can look for them in logs and audit rows */
  handoffLinks: { url: string; code: string }[] = [];

  constructor() {
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  /** `port` 0 picks a free one (the tests); a fixed one is for running it by hand next to a local API. */
  static async start(port = 0): Promise<FakeHr> {
    const fake = new FakeHr();
    await new Promise<void>((resolve) => fake.server.listen(port, "127.0.0.1", resolve));
    fake.port = (fake.server.address() as AddressInfo).port;
    return fake;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  /** HR_MY_HR_URL */
  get hrUrl(): string {
    return `${this.origin}/api/integrations/my-hr`;
  }
  /** PLATFORM_TOKEN_URL */
  get tokenUrl(): string {
    return `${this.origin}/oauth2/token`;
  }
  /** PLATFORM_API_URL */
  get platformUrl(): string {
    return `${this.origin}/platform-api`;
  }

  link(school: string, company: string): void {
    this.companies.set(school, company);
  }
  hire(company: string, person: string, employee: FakeEmployee): void {
    this.people.set(`${company}:${person}`, employee);
  }
  /** The platform knows the school (registration), under its own id; `hr` switches HR's module on ("active") or sets it. */
  register(school: string, platformId: string, hr: string | null = null): void {
    this.platformTenants.set(school, platformId);
    if (hr === null) this.hrModules.delete(platformId);
    else this.hrModules.set(platformId, hr);
  }
  /** The calls the API made to the platform's hand-off and lookups (paths only). */
  get platformPaths(): string[] {
    return this.platformCalls.map((c) => `${c.method} ${c.path}`);
  }
  /** The HR calls that carried a platform token (every call the API made, in order). */
  get hrCallsWithToken(): FakeHrCall[] {
    return this.calls.filter((c) => c.token.startsWith("token-"));
  }

  // ------------------------------------------------------------------ the server
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.origin);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    if (url.pathname === "/oauth2/token" && req.method === "POST") return void (await this.token(req, res, body));
    if (url.pathname.startsWith("/platform-api/")) return void (await this.platform(req, res, url, body));
    const prefix = "/api/integrations/my-hr/";
    if (!url.pathname.startsWith(prefix)) return send(res, 404, { error: { code: "not_found", message: "Not found." } });
    return void (await this.hr(req, res, url, url.pathname.slice(prefix.length)));
  }

  private async token(req: IncomingMessage, res: ServerResponse, body: string): Promise<void> {
    const authorization = String(req.headers.authorization ?? "");
    this.tokenCalls.push({ authorization, contentType: String(req.headers["content-type"] ?? ""), body });
    if (this.tokenDelayMs) await sleep(this.tokenDelayMs);
    if (this.tokenStatus) return send(res, this.tokenStatus, { error: "invalid_client", error_description: "TOKEN-CANARY-should-never-be-logged" });
    const params = new URLSearchParams(body);
    const expected = `Basic ${Buffer.from(`${FAKE_CLIENT_ID}:${FAKE_CLIENT_SECRET}`).toString("base64")}`;
    if (authorization !== expected || params.get("grant_type") !== "client_credentials") return send(res, 400, { error: "invalid_client" });
    if (params.get("scope") !== FAKE_SCOPE) return send(res, 400, { error: "invalid_scope" });
    this.tokensIssued++;
    send(res, 200, { access_token: `token-${this.tokensIssued}`, expires_in: this.tokenSeconds, token_type: "Bearer" });
  }

  private async platform(req: IncomingMessage, res: ServerResponse, url: URL, body: string): Promise<void> {
    const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!token.startsWith("token-")) return send(res, 401, { error: { code: "unauthorized", message: "No token" } });
    if (this.platformRejectNext > 0) {
      this.platformRejectNext--;
      return send(res, 401, { error: { code: "unauthorized", message: "Revoked" } });
    }
    const path = url.pathname.slice("/platform-api".length);
    this.platformCalls.push({ method: String(req.method), path: path + url.search, body, token });
    if (this.platformDelayMs) await sleep(this.platformDelayMs);
    if (this.platformDown === 0) return void req.socket.destroy();
    if (this.platformDown) return send(res, this.platformDown, { error: { code: "server_error", message: "PLATFORM-CANARY-server-error-text" } });
    if (path === "/handoffs" && req.method === "POST") return this.handoff(res, body);
    const lookup = /^\/tenants\/([^/]+)\/(modules|links)\/([^/]+)$/.exec(path);
    if (lookup && req.method === "GET") return this.tenantLookup(res, decodeURIComponent(lookup[1]!), lookup[2] as "modules" | "links", lookup[3]!);
    send(res, this.platformStatus, this.platformBody);
  }

  /** POST /handoffs (SCHOOLS_HR_HANDOFF_CONTRACT.md section 1, as Schools' own fake has it). */
  private handoff(res: ServerResponse, body: string): void {
    if (this.handoffRaw) {
      res.writeHead(this.handoffRaw.status, { "content-type": this.handoffRaw.type });
      return void res.end(this.handoffRaw.body);
    }
    let b: Record<string, any> | null = null;
    try {
      b = JSON.parse(body) as Record<string, any>;
    } catch {
      b = null;
    }
    const person = b?.person as Record<string, unknown> | undefined;
    if (!b || b.target !== "hr" || typeof b.tenant_local_id !== "string" || !person || typeof person.external_id !== "string" || typeof person.role !== "string") {
      return send(res, 400, { error: { code: "bad_request", message: "PLATFORM-CANARY-bad-request" } });
    }
    const platformId = this.platformTenants.get(b.tenant_local_id);
    if (!platformId) return send(res, 404, { error: { code: "tenant_not_found", message: "PLATFORM-CANARY-unknown-school" } });
    if (this.hrModules.get(platformId) !== "active") return send(res, 409, { error: { code: "target_not_enabled", message: "PLATFORM-CANARY-not-enabled" } });
    if (!this.companies.has(b.tenant_local_id)) return send(res, 409, { error: { code: "target_not_linked", message: "PLATFORM-CANARY-not-linked" } });
    if (this.noHandoffUrl) return send(res, 409, { error: { code: "target_no_handoff_url", message: "PLATFORM-CANARY-no-url" } });
    const code = `CODE-CANARY-${randomUUID()}`;
    const link = `https://hr.example.test/auth/handoff?code=${code}`;
    this.handoffLinks.push({ url: link, code });
    send(res, 201, { url: link, expires_at: new Date(Date.now() + 60_000).toISOString() });
  }

  /** GET /tenants/{platform id}/modules/{module} and /links/{module}: is HR on for the school, and has HR linked it. */
  private tenantLookup(res: ServerResponse, platformId: string, kind: "modules" | "links", module: string): void {
    const localId = [...this.platformTenants.entries()].find(([, p]) => p === platformId)?.[0];
    if (!localId || module !== "hr") return send(res, 404, { error: { code: "not_found", message: "No such tenant." } });
    if (kind === "modules") {
      return send(res, 200, {
        tenant_id: platformId,
        module: "hr",
        module_status: this.hrModules.get(platformId) ?? null,
        ...(this.moduleCacheSeconds === null ? {} : { cache_seconds: this.moduleCacheSeconds }),
      });
    }
    if (this.hrModules.get(platformId) === "active" && this.companies.has(localId)) {
      return send(res, 200, { tenant_id: platformId, module: "hr", local_id: this.companies.get(localId) });
    }
    send(res, 404, { error: { code: "not_linked", message: "HR has no record for this tenant yet." } });
  }

  private async hr(req: IncomingMessage, res: ServerResponse, url: URL, path: string): Promise<void> {
    const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    this.calls.push({
      method: String(req.method),
      path,
      search: url.search,
      school: header(req, "x-figbloom-school"),
      person: header(req, "x-figbloom-person"),
      token,
      headers: { ...req.headers },
    });
    if (this.delayMs) await sleep(this.delayMs);
    if (this.redirectTo) {
      res.writeHead(302, { location: this.redirectTo });
      return void res.end();
    }
    if (this.down === 0) return void req.socket.destroy();
    if (this.down) return send(res, this.down, { error: { code: "server_error", message: "HR-CANARY-server-error-text" } });
    if (!this.enabled) return send(res, 503, { error: { code: "my_hr_off", message: "My HR isn't available yet." } });
    if (!token.startsWith("token-")) return send(res, 401, { error: { code: "invalid_token", message: "A platform token is needed." } });
    if (this.rejectNext > 0) {
      this.rejectNext--;
      return send(res, 401, { error: { code: "invalid_token", message: "The platform token isn't valid." } });
    }
    const company = this.companies.get(header(req, "x-figbloom-school") ?? "");
    if (!company) return send(res, 403, { error: { code: "school_not_linked", message: "This school isn't connected to Figbloom HR." } });
    if (this.rawAnswer) {
      res.writeHead(this.rawAnswer.status, { "content-type": this.rawAnswer.type, ...this.rawAnswer.headers });
      return void res.end(this.rawAnswer.body);
    }
    const person = header(req, "x-figbloom-person") ?? "";
    const employee = this.people.get(`${company}:${person}`);
    if (!employee) return send(res, 404, { error: { code: "not_linked", message: "Your HR record isn't ready yet." } });
    if (employee.draft) return send(res, 200, { status: "pending_hr" });
    const mine = this.payslips.get(employee.number) ?? [];
    const one = /^payslips\/([^/]+)$/.exec(path);
    if (one) {
      const slip = mine.find((p) => p.id === decodeURIComponent(one[1]!));
      return slip ? send(res, 200, { status: "active", payslip: slip }) : send(res, 404, { error: { code: "not_found", message: "No such payslip." } });
    }
    switch (path) {
      case "summary":
        return send(res, 200, {
          status: "active",
          employee: { employee_number: employee.number, name: employee.name, job_title: "Teacher", department: "Academics", branch: null, start_date: "2024-01-08", employment_status: "Active" },
          company: { name: "Reu Academy Ltd" },
          latest_payslip: mine[0] ?? null,
          leave_pending: 0,
        });
      case "payslips":
        return send(res, 200, {
          status: "active",
          payslips: mine.map(({ id, pay_period, currency, gross_pay, total_deductions, net_pay }) => ({ id, pay_period, currency, gross_pay, total_deductions, net_pay, run_status: "paid" })),
        });
      case "leave":
        return send(res, 200, {
          status: "active",
          leave_types: [{ id: "lt-1", name: "Annual", description: null, deductible: true }],
          balances: [{ leave_type_id: "lt-1", leave_type: "Annual", year: 2026, month: null, accrued_days: 21, carried_over_days: 0, used_days: 3, pending_days: 0, available_days: 18 }],
          applications: [],
        });
      case "attendance": {
        const from = url.searchParams.get("from"), to = url.searchParams.get("to");
        return send(res, 200, { status: "active", from, to, days: this.attendanceDays, possible_absence_notices: [], missed_scan_requests: [], absences_recorded: [] });
      }
      case "kpis":
        return send(res, 200, { status: "active", period: { id: "p1", name: "Term 3 2026", starts_on: "2026-09-01", ends_on: "2026-11-30", status: "open" }, items: this.kpiItems, overall: { score: this.kpiItems.length ? 82 : null, scored: this.kpiItems.length, total: this.kpiItems.length }, attendance: null });
      default:
        return send(res, 404, { error: { code: "not_found", message: "Not found." } });
    }
  }
}

/** A server that only counts what reaches it (the target of a redirect: it must never be reached). */
export async function startSink(): Promise<{ origin: string; hits: string[]; stop: () => Promise<void> }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? ""}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    hits,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const header = (req: IncomingMessage, name: string): string | null => {
  const v = req.headers[name];
  return typeof v === "string" ? v : null;
};
function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
