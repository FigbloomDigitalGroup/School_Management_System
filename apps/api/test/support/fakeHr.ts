import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A fake Figbloom platform and Figbloom HR for the My HR tests: one local HTTP server that is both the platform's token endpoint
 * (POST /oauth2/token, Cognito-style client credentials) and HR's "My HR" API (GET /api/integrations/my-hr/*), modelled on
 * supabase/functions/_shared/fakeHr.ts and fakePlatform.ts. Nothing here talks to a real HR or platform, and the credentials
 * are made up for the test. HR answers only for a school it has linked, and for a person only through its own people list
 * (the API's user id, as HR's external id), as bloomHR does.
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
  platformStatus = 200;
  platformBody: unknown = { ok: true };

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
    if (url.pathname.startsWith("/platform-api/")) return this.platform(req, res, url, body);
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

  private platform(req: IncomingMessage, res: ServerResponse, url: URL, body: string): void {
    const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!token.startsWith("token-")) return send(res, 401, { error: { code: "unauthorized", message: "No token" } });
    if (this.platformRejectNext > 0) {
      this.platformRejectNext--;
      return send(res, 401, { error: { code: "unauthorized", message: "Revoked" } });
    }
    this.platformCalls.push({ method: String(req.method), path: url.pathname.slice("/platform-api".length) + url.search, body, token });
    send(res, this.platformStatus, this.platformBody);
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
