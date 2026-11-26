import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { FakeHr, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET } from "./support/fakeHr.js";
import { createTestApp, type FixtureIds } from "./support.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
type App = Ctx["app"];
const PASSWORD = "correct-horse-battery";
const ENV = ["HR_LEAVE_ENABLED", "PLATFORM_CLIENT_ID", "PLATFORM_CLIENT_SECRET", "PLATFORM_TOKEN_URL", "PLATFORM_API_URL", "HR_MY_HR_URL", "MY_HR_HTTP_TIMEOUT_MS"];
const BASE = (tenant: string) => `/v1/tenants/${tenant}/me/hr/leave`;
const VALID = { decision: "approve" };

describe("HR leave approvals (L1)", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let fake: FakeHr;
  let enabledApp: App;
  const saved: Record<string, string | undefined> = {};
  const tokens: Record<string, string> = {};

  const headers = (token?: string, tenant = ids.tenantA) => ({ ...(token ? { authorization: `Bearer ${token}` } : {}), "x-tenant-id": tenant });
  const send = (method: "GET" | "POST", path: string, token?: string, body?: unknown, tenant = ids.tenantA, app: App = enabledApp) =>
    app.inject({ method, url: `${BASE(tenant)}${path}`, headers: headers(token, tenant), ...(body === undefined ? {} : { payload: body as Record<string, unknown> }) });
  async function appWith(overrides: Record<string, string | undefined> = {}): Promise<App> {
    const env: Record<string, string | undefined> = {
      HR_LEAVE_ENABLED: "true", PLATFORM_CLIENT_ID: FAKE_CLIENT_ID, PLATFORM_CLIENT_SECRET: FAKE_CLIENT_SECRET,
      PLATFORM_TOKEN_URL: fake.tokenUrl, PLATFORM_API_URL: fake.platformUrl, HR_MY_HR_URL: fake.hrUrl,
      MY_HR_HTTP_TIMEOUT_MS: "5000", ...overrides,
    };
    const previous: Record<string, string | undefined> = { DATABASE_URL: process.env.DATABASE_URL };
    for (const name of ENV) previous[name] = process.env[name];
    for (const name of ENV) {
      if (env[name] === undefined) delete process.env[name];
      else process.env[name] = env[name]!;
    }
    process.env.DATABASE_URL = ctx.runtimeUrl;
    try {
      const app = await buildApp(loadConfig(), ctx.runtimePool);
      await app.ready();
      return app;
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  beforeAll(async () => {
    fake = await FakeHr.start();
    for (const name of ENV) saved[name] = process.env[name];
    ctx = await createTestApp();
    ids = ctx.ids;
    enabledApp = await appWith();
    const credentials = { password: PASSWORD };
    const token = async (email: string) => {
      const res = await enabledApp.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email, ...credentials } });
      expect(res.statusCode, res.body).toBe(200);
      return res.json().token as string;
    };
    tokens.admin = await token("admin-a@example.com");
    tokens.super = await token("super@example.com");
    tokens.orgAdmin = await token("orgadmin@example.com");
    for (const [name, loginId] of [["teacher", "TC-0001"], ["parent", "PT-0001"]] as const) {
      const res = await enabledApp.inject({ method: "POST", url: "/v1/auth/login/login-id", payload: { tenantId: ids.tenantA, loginId, ...credentials } });
      expect(res.statusCode, res.body).toBe(200);
      tokens[name] = res.json().token as string;
    }
    await ctx.pool.query(`INSERT INTO platform_school_links (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`, [ids.tenantA]);
    fake.register(ids.tenantA, "platform-school-a", "active");
    fake.link(ids.tenantA, "company-a");
    fake.approverLink("company-a", ids.adminA, "hr-admin-a");
  }, 240_000);

  afterAll(async () => {
    await enabledApp.close();
    await ctx.app.close();
    await ctx.pool.end();
    await fake.stop();
    for (const name of ENV) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name]!;
    }
  });

  beforeEach(async () => {
    fake.calls = [];
    fake.applications = [];
    fake.rejectNext = 0;
    fake.rawAnswer = null;
    await ctx.pool.query(`DELETE FROM auth_rate_buckets WHERE bucket_key LIKE 'hr_leave:%' OR bucket_key = 'platform:token'`);
    await ctx.pool.query(`UPDATE platform_school_links SET hr_enabled = NULL, hr_reason = NULL, hr_checked_at = NULL WHERE tenant_id = $1`, [ids.tenantA]);
  });

  describe("refusals first", () => {
    it("requires a session on access, list and decision", async () => {
      const id = "leave-app-1";
      expect((await send("GET", "/access", undefined)).statusCode).toBe(401);
      expect((await send("GET", "/approvals", undefined)).statusCode).toBe(401);
      expect((await send("POST", `/approvals/${id}/decide`, undefined, VALID)).statusCode).toBe(401);
      expect(fake.calls).toEqual([]);
    });

    it("refuses a parent, a teacher without Leave or Fees, an undelegated org admin, and a platform super admin", async () => {
      for (const who of ["parent", "teacher", "orgAdmin", "super"]) {
        const res = await send("GET", "/approvals", tokens[who]);
        expect(res.statusCode, who).toBe(403);
      }
      expect(fake.calls).toEqual([]);
      const denied = await ctx.pool.query(`SELECT count(*)::int AS n FROM security_audit_events WHERE event_type = 'rbac.permission.denied' AND detail->>'permission' = 'resource.hr.leave_approvals'`);
      expect(denied.rows[0]!.n).toBeGreaterThan(0);
    });

    it("leaves the feature off by default and does not call HR", async () => {
      const offApp = await appWith({ HR_LEAVE_ENABLED: "false" });
      try {
        const access = await send("GET", "/access", tokens.admin, undefined, ids.tenantA, offApp);
        expect(access.json()).toEqual({ status: "off", approver: true });
        const res = await send("GET", "/approvals", tokens.admin, undefined, ids.tenantA, offApp);
        expect(res.statusCode).toBe(403);
        expect(res.json().error.code).toBe("hr_leave_off");
        expect(fake.calls).toEqual([]);
      } finally { await offApp.close(); }
    });

    it("returns the connect-once status when this approver has not linked their HR user", async () => {
      fake.approvers.delete(`company-a:${ids.adminA}`);
      try {
        const res = await send("GET", "/approvals", tokens.admin);
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe("approver_not_linked");
      } finally { fake.approverLink("company-a", ids.adminA, "hr-admin-a"); }
    });

    it("delegated org admins get Leave approvals only from a Leave or Fees delegation, and super admins remain refused", async () => {
      fake.approverLink("company-a", ids.orgAdmin, "hr-admin-org");
      try {
        for (const area of ["area.leave", "area.fees"]) {
          await ctx.pool.query(`INSERT INTO org_admin_school_delegations (organization_id, tenant_id, delegate_user_id, permission_code, granted_by) VALUES ($1,$2,$3,$4,$5)`, [ids.orgA, ids.tenantA, ids.orgAdmin, area, ids.adminA]);
          const ok = await send("GET", "/approvals", tokens.orgAdmin);
          expect(ok.statusCode, area).toBe(200);
          expect(fake.calls.at(-1)?.person, area).toBe(ids.orgAdmin);
          await ctx.pool.query(`DELETE FROM org_admin_school_delegations WHERE tenant_id = $1 AND delegate_user_id = $2`, [ids.tenantA, ids.orgAdmin]);
        }
        expect((await send("GET", "/approvals", tokens.super)).statusCode).toBe(403);
      } finally {
        await ctx.pool.query(`DELETE FROM org_admin_school_delegations WHERE tenant_id = $1 AND delegate_user_id = $2`, [ids.tenantA, ids.orgAdmin]);
        fake.approvers.delete(`company-a:${ids.orgAdmin}`);
      }
    });
  });

  describe("the approver", () => {
    it("reports access without contacting HR, returns approvals with safe links, and decides as their own HR user", async () => {
      fake.apply({ id: "application-1", company: "company-a", person: ids.teacherA, waiting_on: "hr-admin-a", document: { name: "Doctor note" }, followup_document: { name: "Extra note", url: "javascript:alert(1)" } });
      const access = await send("GET", "/access", tokens.admin);
      expect(access.statusCode).toBe(200);
      expect(access.json()).toEqual({ status: "available", approver: true });
      expect(fake.calls).toEqual([]);

      const list = await send("GET", "/approvals", tokens.admin);
      expect(list.statusCode).toBe(200);
      expect(list.json().approvals).toHaveLength(1);
      expect(list.json().approvals[0].document.url).toMatch(/^https:\/\//);
      expect(list.json().approvals[0].followup_document.url).toBeNull();
      expect(fake.calls[0]).toMatchObject({ method: "GET", path: "approvals", school: ids.tenantA, person: ids.adminA });

      const decision = await send("POST", "/approvals/application-1/decide", tokens.admin, { decision: "approve", comment: "  Looks good  " });
      expect(decision.statusCode).toBe(200);
      expect(fake.calls[1]).toMatchObject({ method: "POST", path: "approvals/application-1/decide", person: ids.adminA, body: JSON.stringify({ decision: "approve", comment: "Looks good" }) });
      const audit = await ctx.pool.query(`SELECT detail FROM security_audit_events WHERE event_type = 'hr.leave.decided'`);
      expect(audit.rows).toEqual([{ detail: { applicationId: "application-1", decision: "approve" } }]);
    });

    it("validates decisions and does not spend rate tokens on malformed requests", async () => {
      for (const body of [{ decision: "approve", extra: true }, { decision: "maybe" }, { decision: "decline", comment: "x".repeat(1001) }]) {
        const res = await send("POST", "/approvals/app-2/decide", tokens.admin, body);
        expect(res.statusCode).toBe(400);
      }
      expect(fake.calls).toEqual([]);
    });

    it("reports an already decided application without writing the API audit event", async () => {
      fake.apply({ id: "application-decided", company: "company-a", person: ids.teacherA, waiting_on: "hr-admin-a", status: "approved" });
      const before = Number((await ctx.pool.query(`SELECT count(*)::int AS n FROM security_audit_events WHERE event_type = 'hr.leave.decided'`)).rows[0]!.n);
      const res = await send("POST", "/approvals/application-decided/decide", tokens.admin, VALID);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("already_decided");
      const audit = await ctx.pool.query(`SELECT count(*)::int AS n FROM security_audit_events WHERE event_type = 'hr.leave.decided'`);
      expect(audit.rows[0]!.n).toBe(before);
    });

    it("limits HR requests per person", async () => {
      for (let i = 0; i < 30; i++) expect((await send("GET", "/approvals", tokens.admin)).statusCode).toBe(200);
      const limited = await send("GET", "/approvals", tokens.admin);
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe("rate_limited");
      expect(fake.calls).toHaveLength(30);
    });
  });
});
