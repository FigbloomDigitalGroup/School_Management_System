import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { setLogSink } from "../src/log.js";
import { TARGET_REFUSALS } from "../src/modules/hr/handoff.js";
import { createTestApp, type FixtureIds } from "./support.js";
import { FakeHr, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET } from "./support/fakeHr.js";
import { loadSpec, responseSchema, validate } from "./support/openapiConformance.js";

/**
 * "HR & Payroll" (docs/HR-HANDOFF.md, slice H1) through the real application and the real figbloom_app login, against a FAKE
 * Figbloom platform (test/support/fakeHr.ts). Nothing here reaches a real platform, a real HR or a real credential.
 * Negative authorisation first, then the switch, then each route and each platform answer, then what must never be written.
 */

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
type App = Ctx["app"];
type Json = Record<string, any>;

const PASSWORD = "correct-horse-battery";
const ENV = [
  "PLATFORM_HANDOFF_ENABLED",
  "MY_HR_ENABLED",
  "PLATFORM_CLIENT_ID",
  "PLATFORM_CLIENT_SECRET",
  "PLATFORM_TOKEN_URL",
  "PLATFORM_API_URL",
  "HR_MY_HR_URL",
  "MY_HR_HTTP_TIMEOUT_MS",
];
const ROUTES = [
  ["GET", "handoff-status"],
  ["POST", "handoff-request"],
  ["POST", "handoff"],
] as const;
const PLATFORM_A = "plat-school-a";

describe("HR & Payroll hand-off on the API", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let fake: FakeHr;
  const savedEnv: Record<string, string | undefined> = {};
  const extraApps: App[] = [];
  const tokens: Record<string, string> = {};
  const people: Record<string, string> = {};
  let schoolC = "";

  const baseEnv = (): Record<string, string | undefined> => ({
    PLATFORM_HANDOFF_ENABLED: "true",
    MY_HR_ENABLED: undefined,
    PLATFORM_CLIENT_ID: FAKE_CLIENT_ID,
    PLATFORM_CLIENT_SECRET: FAKE_CLIENT_SECRET,
    PLATFORM_TOKEN_URL: fake.tokenUrl,
    PLATFORM_API_URL: fake.platformUrl,
    HR_MY_HR_URL: undefined,
    MY_HR_HTTP_TIMEOUT_MS: "5000",
  });

  /** Another app on the same database and runtime login, with its own settings, token and connection memory. */
  async function appWith(overrides: Record<string, string | undefined> = {}): Promise<App> {
    const env = { ...baseEnv(), ...overrides };
    const before: Record<string, string | undefined> = {};
    for (const name of [...ENV, "DATABASE_URL"]) before[name] = process.env[name];
    for (const name of ENV) {
      if (env[name] === undefined) delete process.env[name];
      else process.env[name] = env[name];
    }
    process.env.DATABASE_URL = ctx.runtimeUrl;
    try {
      const app = await buildApp(loadConfig(), ctx.runtimePool);
      await app.ready();
      extraApps.push(app);
      return app;
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  const url = (path: string, tenantId: string) => `/v1/tenants/${tenantId}/me/hr/${path}`;
  function call(
    method: "GET" | "POST",
    path: string,
    who: string | null,
    opts: { tenantId?: string; header?: string | null; app?: App; payload?: unknown; extra?: Record<string, string> } = {},
  ) {
    const tenantId = opts.tenantId ?? ids.tenantA;
    const header = opts.header === undefined ? tenantId : opts.header;
    return (opts.app ?? ctx.app).inject({
      method,
      url: url(path, tenantId),
      headers: {
        ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}),
        ...(header ? { "x-tenant-id": header } : {}),
        ...(opts.payload !== undefined ? { "content-type": "application/json" } : {}),
        ...opts.extra,
      },
      ...(opts.payload !== undefined ? { payload: JSON.stringify(opts.payload) } : {}),
    });
  }
  const status = (who: string, opts: Parameters<typeof call>[3] = {}) => call("GET", "handoff-status", who, opts);
  const open = (who: string, opts: Parameters<typeof call>[3] = {}) => call("POST", "handoff", who, opts);
  const ask = (who: string, opts: Parameters<typeof call>[3] = {}) => call("POST", "handoff-request", who, opts);

  async function login(body: Json): Promise<string> {
    const res = await ctx.app.inject({ method: "POST", url: body.email ? "/v1/auth/login/email" : "/v1/auth/login/login-id", payload: body });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    return res.json().token as string;
  }
  async function newUser(email: string | null, name: string): Promise<string> {
    const id = randomUUID();
    const hash = (await ctx.pool.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [ids.adminA])).rows[0]!.password_hash;
    await ctx.pool.query(`INSERT INTO users (id, email, password_hash, full_name, status) VALUES ($1, $2, $3, $4, 'active')`, [id, email, hash, name]);
    return id;
  }
  async function member(role: string, loginId: string, tenantId: string, name: string): Promise<{ id: string; token: string }> {
    const id = await newUser(null, name);
    await ctx.pool.query(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, $3, $4)`, [id, tenantId, role, loginId]);
    return { id, token: await login({ tenantId, loginId, password: PASSWORD }) };
  }
  /** When the current test started, by the database's clock: audit rows are append-only, so each test reads its own. */
  let since = new Date(0);
  const audits = async (type: string, tenantId: string = ids.tenantA) =>
    (
      await ctx.pool.query<{ actor_user_id: string; tenant_id: string; detail: Json }>(
        `SELECT actor_user_id, tenant_id, detail FROM security_audit_events
          WHERE event_type = $1 AND tenant_id = $2 AND occurred_at >= $3 ORDER BY occurred_at, id`,
        [type, tenantId, since],
      )
    ).rows;
  const linkRow = async (tenantId: string = ids.tenantA) =>
    (
      await ctx.pool.query<{ hr_enabled: boolean | null; hr_reason: string | null; recent: boolean }>(
        `SELECT hr_enabled, hr_reason, coalesce(hr_checked_at > now() - interval '1 minute', false) AS recent FROM platform_school_links WHERE tenant_id = $1`,
        [tenantId],
      )
    ).rows[0];

  beforeAll(async () => {
    fake = await FakeHr.start();
    for (const name of ENV) savedEnv[name] = process.env[name];
    for (const [name, value] of Object.entries(baseEnv())) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    ctx = await createTestApp();
    ids = ctx.ids;

    tokens.admin = await login({ email: "admin-a@example.com", password: PASSWORD });
    tokens.teacher = await login({ tenantId: ids.tenantA, loginId: "TC-0001", password: PASSWORD });
    tokens.parent = await login({ tenantId: ids.tenantA, loginId: "PT-0001", password: PASSWORD });
    tokens.teacherB = await login({ tenantId: ids.tenantB, loginId: "TC-0001", password: PASSWORD });
    tokens.super = await login({ email: "super@example.com", password: PASSWORD });
    tokens.orgAdmin = await login({ email: "orgadmin@example.com", password: PASSWORD });

    // the bursar: a teacher holding the Fees area directly
    const bursar = await member("teacher", "TC-0101", ids.tenantA, "Bea Bursar");
    await ctx.pool.query(`INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'fees')`, [ids.tenantA, bursar.id]);
    // an accounts clerk: other staff holding the Fees area through a school role
    const clerk = await member("staff", "ST-0101", ids.tenantA, "Cal Clerk");
    const role = await ctx.pool.query<{ id: string }>(`INSERT INTO school_roles (tenant_id, name, areas) VALUES ($1, 'Accounts', '{fees}') RETURNING id`, [ids.tenantA]);
    await ctx.pool.query(`INSERT INTO school_role_assignments (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`, [ids.tenantA, clerk.id, role.rows[0]!.id]);
    // staff of school A without the Fees area
    const driver = await member("driver", "DR-0101", ids.tenantA, "Dan Driver");
    const learner = await member("student", "ST-0901", ids.tenantA, "Lee Learner");
    const office = await member("staff", "ST-0102", ids.tenantA, "Pat People");
    await ctx.pool.query(`INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'people')`, [ids.tenantA, office.id]);
    // an organisation administrator of school A's organisation WITH a delegation of the Fees area there
    const delegate = await newUser("org-delegate@example.com", "Olu Delegate");
    await ctx.pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role) VALUES ($1, $2, 'org_admin')`, [delegate, ids.orgA]);
    await ctx.pool.query(
      `INSERT INTO org_admin_school_delegations (organization_id, tenant_id, delegate_user_id, permission_code, granted_by) VALUES ($1, $2, $3, 'area.fees', $4)`,
      [ids.orgA, ids.tenantA, delegate, ids.orgAdmin],
    );
    // school B's administrator (school B is not known to the platform)
    const adminB = await newUser("admin-b-hr@example.com", "Bo Admin");
    await ctx.pool.query(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'school_admin', 'AD-0101')`, [adminB, ids.tenantB]);
    // school C, whose administrator signs in before it is suspended
    schoolC = randomUUID();
    await ctx.pool.query(`INSERT INTO tenants (id, organization_id, name, slug, status) VALUES ($1, $2, 'School C', 'school-c-hr', 'active')`, [schoolC, ids.orgA]);
    const adminC = await newUser("admin-c-hr@example.com", "Cy Admin");
    await ctx.pool.query(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'school_admin', 'AD-0102')`, [adminC, schoolC]);
    await ctx.pool.query(`INSERT INTO platform_school_links (tenant_id, platform_tenant_id) VALUES ($1, 'plat-school-c')`, [schoolC]);

    Object.assign(people, { bursar: bursar.id, clerk: clerk.id, delegate, adminB, adminC });
    Object.assign(tokens, {
      bursar: bursar.token,
      clerk: clerk.token,
      driver: driver.token,
      learner: learner.token,
      office: office.token,
      delegate: await login({ email: "org-delegate@example.com", password: PASSWORD }),
      adminB: await login({ email: "admin-b-hr@example.com", password: PASSWORD }),
      adminC: await login({ email: "admin-c-hr@example.com", password: PASSWORD }),
    });
    await ctx.pool.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [schoolC]);

    // the documented operator step (docs/MY-HR.md, "Linking a school"), with the platform's own id for the school (117)
    await ctx.pool.query(`INSERT INTO platform_school_links (tenant_id, platform_tenant_id) VALUES ($1, $2)`, [ids.tenantA, PLATFORM_A]);
  }, 240_000);

  afterAll(async () => {
    for (const app of extraApps) await app.close();
    await ctx.app.close();
    await ctx.pool.end();
    await fake.stop();
    for (const name of ENV) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  beforeEach(async () => {
    // the platform: school A is registered, HR is switched on and its company linked; school B and C are unknown to it
    fake.platformTenants.clear();
    fake.hrModules.clear();
    fake.companies.clear();
    fake.register(ids.tenantA, PLATFORM_A, "active");
    fake.link(ids.tenantA, "company-a");
    fake.platformCalls = [];
    fake.platformRejectNext = 0;
    fake.platformDown = null;
    fake.platformDelayMs = 0;
    fake.handoffRaw = null;
    fake.noHandoffUrl = false;
    fake.moduleCacheSeconds = null;
    fake.tokenStatus = null;
    fake.tokenSeconds = 3600;
    await ctx.pool.query(`UPDATE platform_school_links SET platform_tenant_id = $2, hr_enabled = NULL, hr_reason = NULL, hr_checked_at = NULL WHERE tenant_id = $1`, [ids.tenantA, PLATFORM_A]);
    await ctx.pool.query(`UPDATE tenants SET hr_requested_at = NULL, hr_requested_by = NULL`);
    await ctx.pool.query(`DELETE FROM auth_rate_buckets WHERE bucket_key LIKE 'hr_handoff:%' OR bucket_key = 'my_hr:platform'`);
    since = (await ctx.pool.query<{ t: Date }>(`SELECT clock_timestamp() AS t`)).rows[0]!.t;
  });

  // ------------------------------------------------------------------ negative authorisation first
  describe("who may not (negative first)", () => {
    it("a parent, a learner, a teacher or other staff without the Fees area, and a driver are 403 forbidden on every route", async () => {
      const app = await appWith();
      const tokenCalls = fake.tokenCalls.length;
      for (const who of ["parent", "learner", "teacher", "driver", "office"]) {
        for (const [method, path] of ROUTES) {
          const res = await call(method, path, who, { app });
          expect(res.statusCode, `${who} ${method} ${path}`).toBe(403);
          expect(res.json().error).toMatchObject({ code: "forbidden", message: "HR & Payroll is for the school's administrators and the bursar." });
        }
      }
      expect(fake.platformCalls).toEqual([]);
      expect(fake.tokenCalls.length).toBe(tokenCalls);
      expect((await ctx.pool.query(`SELECT count(*)::int AS n FROM tenants WHERE hr_requested_at IS NOT NULL`)).rows[0].n).toBe(0);
    });

    it("an organisation administrator without a delegation of the Fees area is 403 (the API's stricter rule, R5)", async () => {
      for (const [method, path] of ROUTES) {
        const res = await call(method, path, "orgAdmin");
        expect(res.statusCode, `${method} ${path}`).toBe(403);
        expect(res.json().error.code).toBe("forbidden");
      }
      expect(fake.platformCalls).toEqual([]);
    });

    it("Figbloom staff (platform super administrator) are 403 everywhere, though they hold every permission; the refusal is audited", async () => {
      const before = (await audits("rbac.permission.denied")).filter((a) => a.actor_user_id === ids.superAdmin && a.detail.permission === "resource.hr.handoff").length;
      for (const [method, path] of ROUTES) {
        const res = await call(method, path, "super");
        expect(res.statusCode, `${method} ${path}`).toBe(403);
        expect(res.json().error).toMatchObject({ code: "forbidden", message: "HR & Payroll is for the school's administrators and the bursar." });
      }
      const after = (await audits("rbac.permission.denied")).filter((a) => a.actor_user_id === ids.superAdmin && a.detail.permission === "resource.hr.handoff");
      expect(after.length - before).toBe(3);
      expect(after.at(-1)!.detail).toMatchObject({ reason: "platform_super_admin" });
      expect(fake.platformCalls).toEqual([]);
    });

    it("a refusal for a missing permission is the standard audited denial", async () => {
      const before = (await audits("rbac.permission.denied")).length;
      expect((await open("teacher")).statusCode).toBe(403);
      const rows = await audits("rbac.permission.denied");
      expect(rows.length).toBe(before + 1);
      expect(rows.at(-1)).toMatchObject({ actor_user_id: ids.teacherA, detail: { permission: "resource.hr.handoff" } });
    });

    it("another school's people cannot reach this school, by the path or by X-Tenant-Id, and the answer names nothing", async () => {
      for (const [method, path] of ROUTES) {
        // school B's administrator naming school A in the path (header B, header A, no header)
        for (const header of [ids.tenantB, ids.tenantA, null]) {
          const res = await call(method, path, "adminB", { tenantId: ids.tenantA, header });
          expect(res.statusCode, `${method} ${path} header ${header}`).toBe(403);
          expect(res.body).not.toContain(ids.tenantA);
        }
        // school A's administrator naming school B, by the path and by the header
        expect((await call(method, path, "admin", { tenantId: ids.tenantB })).statusCode).toBe(403);
        expect((await call(method, path, "admin", { tenantId: ids.tenantA, header: ids.tenantB })).statusCode).toBe(403);
        expect((await call(method, path, "teacherB", { tenantId: ids.tenantA })).statusCode).toBe(403);
      }
      expect(fake.platformCalls).toEqual([]);
    });

    it("a suspended school's administrator is refused (403), and so is everyone in it", async () => {
      for (const [method, path] of ROUTES) {
        const res = await call(method, path, "adminC", { tenantId: schoolC });
        expect(res.statusCode, `${method} ${path}`).toBe(403);
      }
      expect(fake.platformCalls).toEqual([]);
    });

    it("no session, a bad token or a malformed school id never reaches the rule", async () => {
      for (const [method, path] of ROUTES) {
        expect((await call(method, path, null)).statusCode).toBe(401);
        expect((await ctx.app.inject({ method, url: url(path, ids.tenantA), headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
        expect((await ctx.app.inject({ method, url: url(path, "not-a-uuid"), headers: { authorization: `Bearer ${tokens.admin}` } })).statusCode).toBe(400);
      }
      expect(fake.platformCalls).toEqual([]);
    });

    it("a school or person named in the body, the query or a header changes nothing", async () => {
      const res = await ctx.app.inject({
        method: "POST",
        url: `${url("handoff", ids.tenantA)}?tenant_id=${ids.tenantB}&person=${ids.superAdmin}`,
        headers: {
          authorization: `Bearer ${tokens.bursar}`,
          "x-tenant-id": ids.tenantA,
          "x-figbloom-school": ids.tenantB,
          "x-figbloom-person": ids.adminA,
          "content-type": "application/json",
        },
        payload: JSON.stringify({ tenant_id: ids.tenantB, tenant_local_id: ids.tenantB, person: { external_id: ids.adminA, role: "school_admin" }, action: "status" }),
      });
      expect(res.statusCode).toBe(200);
      const sent = JSON.parse(fake.platformCalls.at(-1)!.body);
      expect(sent).toEqual({ target: "hr", tenant_local_id: ids.tenantA, person: { external_id: people.bursar, name: "Bea Bursar", email: null, role: "teacher" } });
    });
  });

  // ------------------------------------------------------------------ off by default
  describe("off unless switched on and complete", () => {
    it("with nothing set: status says enabled false, open and request are 403 handoff_off, and nothing is called", async () => {
      const tokenCalls = fake.tokenCalls.length;
      const app = await appWith(Object.fromEntries(ENV.map((n) => [n, undefined])));
      expect((await status("admin", { app })).json()).toEqual({ enabled: false, connection: null, requested_at: null, can_request_hr: false });
      const opened = await open("admin", { app });
      expect(opened.statusCode).toBe(403);
      expect(opened.json().error).toMatchObject({ code: "handoff_off", message: "Signing in to HR & Payroll from Figbloom Schools isn't available yet." });
      const asked = await ask("bursar", { app });
      expect(asked.statusCode).toBe(403);
      expect(asked.json().error).toMatchObject({ code: "handoff_off", message: "HR & Payroll isn't available from Figbloom Schools yet." });
      // the rule still comes first: someone who may not have it is forbidden, off or not
      expect((await status("teacher", { app })).statusCode).toBe(403);
      expect((await open("super", { app })).statusCode).toBe(403);
      expect(fake.platformCalls).toEqual([]);
      expect(fake.tokenCalls.length).toBe(tokenCalls);
      expect((await ctx.pool.query(`SELECT count(*)::int AS n FROM tenants WHERE hr_requested_at IS NOT NULL`)).rows[0].n).toBe(0);
    });

    it("the switch not true, or any of the four platform settings missing, is off; My HR's switch does not turn it on", async () => {
      const tokenCalls = fake.tokenCalls.length;
      for (const overrides of [
        { PLATFORM_HANDOFF_ENABLED: undefined },
        { PLATFORM_HANDOFF_ENABLED: "false" },
        { PLATFORM_HANDOFF_ENABLED: "yes" },
        { PLATFORM_CLIENT_ID: undefined },
        { PLATFORM_CLIENT_SECRET: undefined },
        { PLATFORM_TOKEN_URL: undefined },
        { PLATFORM_API_URL: undefined },
        { PLATFORM_HANDOFF_ENABLED: undefined, MY_HR_ENABLED: "true", HR_MY_HR_URL: fake.hrUrl },
      ]) {
        const app = await appWith(overrides);
        expect((await status("admin", { app })).json(), JSON.stringify(overrides)).toMatchObject({ enabled: false });
        expect((await open("admin", { app })).json().error.code, JSON.stringify(overrides)).toBe("handoff_off");
      }
      expect(fake.platformCalls).toEqual([]);
      expect(fake.tokenCalls.length).toBe(tokenCalls);
    });
  });

  // ------------------------------------------------------------------ status
  describe("GET handoff-status", () => {
    it("connected: the school's administrator, the bursar, other staff with the Fees area and a delegated organisation administrator", async () => {
      const app = await appWith();
      for (const who of ["admin", "bursar", "clerk", "delegate"]) {
        const res = await status(who, { app });
        expect(res.statusCode, who).toBe(200);
        expect(res.json(), who).toEqual({ enabled: true, connection: "connected", requested_at: null, can_request_hr: true });
      }
      // asked once and kept a minute: the module, then the link
      expect(fake.platformPaths).toEqual([`GET /tenants/${PLATFORM_A}/modules/hr`, `GET /tenants/${PLATFORM_A}/links/hr`]);
    });

    it("not_connected for a school the platform does not know (no row), without asking it", async () => {
      const res = await status("adminB", { tenantId: ids.tenantB, app: await appWith() });
      expect(res.json()).toEqual({ enabled: true, connection: "not_connected", requested_at: null, can_request_hr: true });
      expect(fake.platformCalls).toEqual([]);
    });

    it("not_connected while HR's module is not active; setting_up while it is but HR has not linked the school", async () => {
      fake.register(ids.tenantA, PLATFORM_A, "trial");
      expect((await status("admin", { app: await appWith() })).json().connection).toBe("not_connected");
      fake.register(ids.tenantA, PLATFORM_A, null);
      expect((await status("admin", { app: await appWith() })).json().connection).toBe("not_connected");
      fake.register(ids.tenantA, PLATFORM_A, "active");
      fake.companies.clear();
      expect((await status("admin", { app: await appWith() })).json().connection).toBe("setting_up");
    });

    it("unknown when the platform cannot be asked: down, no token, slow, or the platform's id for the school is not recorded", async () => {
      fake.platformDown = 503;
      expect((await status("admin", { app: await appWith() })).json().connection).toBe("unknown");
      fake.platformDown = 0;
      expect((await status("admin", { app: await appWith() })).json().connection).toBe("unknown");
      fake.platformDown = null;
      fake.tokenStatus = 400;
      expect((await status("admin", { app: await appWith() })).json().connection).toBe("unknown");
      fake.tokenStatus = null;
      fake.platformDelayMs = 1500;
      const started = Date.now();
      expect((await status("admin", { app: await appWith({ MY_HR_HTTP_TIMEOUT_MS: "250" }) })).json().connection).toBe("unknown");
      expect(Date.now() - started).toBeLessThan(1400);
      fake.platformDelayMs = 0;
      fake.platformCalls = [];
      await ctx.pool.query(`UPDATE platform_school_links SET platform_tenant_id = NULL WHERE tenant_id = $1`, [ids.tenantA]);
      expect((await status("admin", { app: await appWith() })).json()).toEqual({ enabled: true, connection: "unknown", requested_at: null, can_request_hr: true });
      expect(fake.platformCalls).toEqual([]);
    });

    it("a 401 from the platform is retried once with a fresh token", async () => {
      const app = await appWith();
      fake.platformRejectNext = 1;
      const issued = fake.tokensIssued;
      expect((await status("admin", { app })).json().connection).toBe("connected");
      expect(fake.tokensIssued - issued).toBe(2);
    });

    it("shows the school's request once made", async () => {
      await ctx.pool.query(`UPDATE tenants SET hr_requested_at = '2026-11-20T08:30:00.123Z', hr_requested_by = $2 WHERE id = $1`, [ids.tenantB, people.adminB]);
      expect((await status("adminB", { tenantId: ids.tenantB })).json()).toEqual({
        enabled: true,
        connection: "not_connected",
        requested_at: "2026-11-20T08:30:00.123Z",
        can_request_hr: true,
      });
    });
  });

  // ------------------------------------------------------------------ request
  describe("POST handoff-request", () => {
    it("records the school's request once: the first time is kept, one audit row, and Figbloom staff see it on the school list", async () => {
      const first = await ask("adminB", { tenantId: ids.tenantB });
      expect(first.statusCode).toBe(200);
      const at = first.json().requested_at as string;
      expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      const again = await ask("adminB", { tenantId: ids.tenantB });
      expect(again.json()).toEqual({ requested_at: at });
      const row = (await ctx.pool.query(`SELECT hr_requested_by FROM tenants WHERE id = $1`, [ids.tenantB])).rows[0];
      expect(row.hr_requested_by).toBe(people.adminB);
      const rows = await audits("hr.handoff.requested", ids.tenantB);
      expect(rows).toEqual([{ actor_user_id: people.adminB, tenant_id: ids.tenantB, detail: { target: "hr" } }]);
      expect((await status("adminB", { tenantId: ids.tenantB })).json().requested_at).toBe(at);
      const list = await ctx.app.inject({ method: "GET", url: `/v1/platform/schools/${ids.tenantB}`, headers: { authorization: `Bearer ${tokens.super}` } });
      expect(list.json()).toMatchObject({ hrRequestedAt: at, hrRequestedBy: people.adminB });
      expect(fake.platformCalls).toEqual([]); // school B has no platform row: nothing to ask
    });

    it("409 already_connected while HR is connected or being set up, and nothing is recorded", async () => {
      const connected = await ask("bursar", { app: await appWith() });
      expect(connected.statusCode).toBe(409);
      expect(connected.json().error).toMatchObject({ code: "already_connected", message: "Figbloom HR is already switched on for this school." });
      fake.companies.clear();
      expect((await ask("bursar", { app: await appWith() })).json().error.code).toBe("already_connected");
      expect((await ctx.pool.query(`SELECT hr_requested_at FROM tenants WHERE id = $1`, [ids.tenantA])).rows[0].hr_requested_at).toBeNull();
      expect(await audits("hr.handoff.requested")).toEqual([]);
    });

    it("a school whose HR is not switched on, or that cannot be checked, may ask", async () => {
      fake.register(ids.tenantA, PLATFORM_A, null);
      expect((await ask("delegate", { app: await appWith() })).statusCode).toBe(200);
      expect((await ctx.pool.query(`SELECT hr_requested_by FROM tenants WHERE id = $1`, [ids.tenantA])).rows[0].hr_requested_by).toBe(people.delegate);
      await ctx.pool.query(`UPDATE tenants SET hr_requested_at = NULL, hr_requested_by = NULL WHERE id = $1`, [ids.tenantA]);
      fake.platformDown = 500;
      expect((await ask("clerk", { app: await appWith() })).statusCode).toBe(200);
    });

    it("the database keeps the rule too: no request without a school and a person, for a parent, or for Figbloom staff, and no direct write", async () => {
      const asApp = async (tenantId: string | null, userId: string | null, sql: string) => {
        const client = await ctx.runtimePool.connect();
        try {
          await client.query("BEGIN");
          if (userId) await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
          if (tenantId) await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
          return await client.query(sql);
        } finally {
          await client.query("ROLLBACK").catch(() => undefined);
          client.release();
        }
      };
      const fn = `SELECT * FROM public.hr_record_request()`;
      await expect(asApp(null, null, fn)).rejects.toMatchObject({ code: "42501" });
      await expect(asApp(ids.tenantA, null, fn)).rejects.toMatchObject({ code: "42501" });
      await expect(asApp(ids.tenantA, ids.parentA, fn)).rejects.toMatchObject({ code: "42501" });
      await expect(asApp(ids.tenantA, ids.superAdmin, fn)).rejects.toMatchObject({ code: "42501" });
      await expect(asApp(ids.tenantA, ids.orgAdmin, fn)).rejects.toMatchObject({ code: "42501" }); // no Fees delegation
      await expect(asApp(ids.tenantA, ids.teacherB, fn)).rejects.toMatchObject({ code: "42501" }); // another school's teacher
      await expect(asApp(schoolC, people.adminC!, fn)).rejects.toMatchObject({ code: "42501" }); // suspended
      const ok = await asApp(ids.tenantA, ids.adminA, fn);
      expect(ok.rows[0]).toMatchObject({ recorded: true });
      for (const sql of [
        `UPDATE tenants SET hr_requested_at = now(), hr_requested_by = '${ids.adminA}' WHERE id = '${ids.tenantA}'`,
        `UPDATE tenants SET hr_requested_at = NULL`,
      ]) {
        await expect(asApp(ids.tenantA, ids.adminA, sql), sql).rejects.toMatchObject({ code: "42501" });
      }
      await expect(ctx.pool.query(`UPDATE tenants SET hr_requested_by = $2 WHERE id = $1`, [ids.tenantA, ids.adminA])).rejects.toMatchObject({ code: "23514" });
    });
  });

  // ------------------------------------------------------------------ open
  describe("POST handoff", () => {
    it("returns the platform's one-time https link for the caller, as themselves, records the yes, and writes one audit row without the link", async () => {
      const res = await open("admin");
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.keys(body).sort()).toEqual(["expires_at", "url"]);
      expect(body.url).toBe(fake.handoffLinks.at(-1)!.url);
      expect(body.url.startsWith("https://")).toBe(true);
      expect(body.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(res.headers["cache-control"]).toBe("no-store");
      const sent = fake.platformCalls.at(-1)!;
      expect(`${sent.method} ${sent.path}`).toBe("POST /handoffs");
      expect(JSON.parse(sent.body)).toEqual({
        target: "hr",
        tenant_local_id: ids.tenantA,
        person: { external_id: ids.adminA, name: "Admin A", email: "admin-a@example.com", role: "school_admin" },
      });
      expect(await linkRow()).toEqual({ hr_enabled: true, hr_reason: null, recent: true });
      const rows = await audits("hr.handoff.opened");
      expect(rows).toEqual([{ actor_user_id: ids.adminA, tenant_id: ids.tenantA, detail: { target: "hr" } }]);
    });

    it("each person is sent as themselves: the bursar (no real e-mail), other staff, and a delegated organisation administrator", async () => {
      for (const [who, person] of [
        ["bursar", { external_id: people.bursar, name: "Bea Bursar", email: null, role: "teacher" }],
        ["clerk", { external_id: people.clerk, name: "Cal Clerk", email: null, role: "staff" }],
        ["delegate", { external_id: people.delegate, name: "Olu Delegate", email: "org-delegate@example.com", role: "org_admin" }],
      ] as const) {
        const res = await open(who);
        expect(res.statusCode, who).toBe(200);
        expect(JSON.parse(fake.platformCalls.at(-1)!.body).person, who).toEqual(person);
      }
      expect((await audits("hr.handoff.opened")).map((r) => r.actor_user_id)).toEqual([people.bursar, people.clerk, people.delegate]);
    });

    it("a school the platform does not know: 409 school_not_linked, without asking it (no row) or without recording (the platform's 404)", async () => {
      const noRow = await open("adminB", { tenantId: ids.tenantB });
      expect(noRow.statusCode).toBe(409);
      expect(noRow.json().error).toMatchObject({ code: "school_not_linked", message: "This school isn't connected to the Figbloom platform yet. Try again later, or ask Figbloom." });
      expect(fake.platformCalls).toEqual([]);
      fake.platformTenants.clear();
      const unknown = await open("admin");
      expect(unknown.statusCode).toBe(409);
      expect(unknown.json().error).toMatchObject({ code: "school_not_linked", message: "The Figbloom platform doesn't know this school yet. Try again later, or ask Figbloom." });
      expect(await linkRow()).toEqual({ hr_enabled: null, hr_reason: null, recent: false });
      expect(await audits("hr.handoff.opened")).toEqual([]);
    });

    it("each of the platform's 409s is passed on with its code and sentence, and recorded as a no", async () => {
      const cases: Array<[string, () => void]> = [
        ["target_not_enabled", () => fake.register(ids.tenantA, PLATFORM_A, null)],
        ["target_not_linked", () => fake.companies.clear()],
        ["target_no_handoff_url", () => { fake.noHandoffUrl = true; }],
      ];
      for (const [code, arrange] of cases) {
        fake.register(ids.tenantA, PLATFORM_A, "active");
        fake.link(ids.tenantA, "company-a");
        fake.noHandoffUrl = false;
        arrange();
        const res = await open("admin");
        expect(res.statusCode, code).toBe(409);
        expect(res.json().error).toEqual({ code, message: TARGET_REFUSALS[code as keyof typeof TARGET_REFUSALS], request_id: expect.any(String) });
        expect(await linkRow(), code).toEqual({ hr_enabled: false, hr_reason: code, recent: true });
      }
      expect(await audits("hr.handoff.opened")).toEqual([]);
    });

    it("a recorded no hides My HR for an hour for two of the three codes (the hand-off closes My HR's open 'who writes not_enabled')", async () => {
      const myHr = await appWith({ MY_HR_ENABLED: "true", HR_MY_HR_URL: fake.hrUrl });
      const myStatus = async () => (await myHr.inject({ method: "GET", url: url("status", ids.tenantA), headers: { authorization: `Bearer ${tokens.bursar}`, "x-tenant-id": ids.tenantA } })).json().status;
      expect(await myStatus()).toBe("available");
      fake.register(ids.tenantA, PLATFORM_A, null);
      expect((await open("admin")).statusCode).toBe(409);
      expect(await myStatus()).toBe("not_enabled");
      fake.register(ids.tenantA, PLATFORM_A, "active");
      expect((await open("admin")).statusCode).toBe(200);
      expect(await myStatus()).toBe("available");
    });

    it("the platform's 429 is 429 rate_limited", async () => {
      fake.handoffRaw = { status: 429, body: '{"error":{"code":"rate_limited","message":"PLATFORM-CANARY-429"}}', type: "application/json" };
      const res = await open("admin");
      expect(res.statusCode).toBe(429);
      expect(res.json().error).toMatchObject({ code: "rate_limited", message: "Too many HR sign-ins for this school in the last minute. Wait a moment and try again." });
      expect(res.body).not.toContain("CANARY");
    });

    it("the platform down (5xx), unreachable, or with no token: 503 hr_unavailable with Retry-After, none of its words, no audit, nothing recorded", async () => {
      for (const down of [500, 502, 503, 504, 0]) {
        fake.platformDown = down;
        const res = await open("admin");
        expect(res.statusCode, String(down)).toBe(503);
        expect(res.json().error).toMatchObject({ code: "hr_unavailable", message: "HR & Payroll can't be reached right now. Try again in a minute." });
        expect(res.headers["retry-after"]).toBe("30");
        expect(res.body).not.toContain("CANARY");
      }
      fake.platformDown = null;
      fake.platformCalls = [];
      fake.tokenStatus = 400;
      const noToken = await open("admin", { app: await appWith() });
      expect(noToken.statusCode).toBe(503);
      expect(noToken.json().error.code).toBe("hr_unavailable");
      expect(noToken.body).not.toMatch(/CANARY|secret|invalid_client/i);
      expect(fake.platformCalls).toEqual([]);
      expect(await audits("hr.handoff.opened")).toEqual([]);
      expect(await linkRow()).toEqual({ hr_enabled: null, hr_reason: null, recent: false });
    });

    it("no token at first: a 401 is retried once with a fresh token; a second 401 is 503", async () => {
      const app = await appWith();
      expect((await status("admin", { app })).statusCode).toBe(200); // the token is now kept
      fake.platformRejectNext = 1;
      const issued = fake.tokensIssued;
      expect((await open("admin", { app })).statusCode).toBe(200);
      expect(fake.tokensIssued - issued).toBe(1);
      fake.platformRejectNext = 2;
      const twice = await open("admin", { app });
      expect(twice.statusCode).toBe(503);
      expect(twice.json().error.code).toBe("hr_unavailable");
    });

    it("a platform that does not answer in time is 503 within the timeout", async () => {
      const app = await appWith({ MY_HR_HTTP_TIMEOUT_MS: "250" });
      await status("admin", { app }); // token fetched
      fake.platformDelayMs = 1500;
      const started = Date.now();
      const res = await open("admin", { app });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("hr_unavailable");
      expect(Date.now() - started).toBeLessThan(1400);
    });

    it("anything but an https link is 502 hr_bad_answer, never handed out, and not audited", async () => {
      for (const body of [
        '{"url":"http://hr.example.test/auth/handoff?code=CODE-CANARY-plain","expires_at":"2026-11-25T10:00:00Z"}',
        '{"url":"javascript:alert(1)//CODE-CANARY-js","expires_at":"2026-11-25T10:00:00Z"}',
        '{"url":"not a url CODE-CANARY-text"}',
        '{"expires_at":"2026-11-25T10:00:00Z"}',
        "<html>CODE-CANARY-html</html>",
        "[]",
      ]) {
        fake.handoffRaw = { status: 201, body, type: body.startsWith("<") ? "text/html" : "application/json" };
        const res = await open("admin");
        expect(res.statusCode, body).toBe(502);
        expect(res.json().error).toMatchObject({ code: "hr_bad_answer" });
        expect(res.body).not.toContain("CANARY");
      }
      expect(await audits("hr.handoff.opened")).toEqual([]);
      expect(await linkRow()).toEqual({ hr_enabled: null, hr_reason: null, recent: false });
    });

    it("is rate limited per person: 10 a minute, then 429 with Retry-After, and the platform is not asked for the refused one", async () => {
      for (let i = 0; i < 10; i++) expect((await open("clerk")).statusCode, `open ${i + 1}`).toBe(200);
      const calls = fake.platformCalls.length;
      const res = await open("clerk");
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe("rate_limited");
      expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
      expect(fake.platformCalls.length).toBe(calls);
      expect((await open("bursar")).statusCode).toBe(200); // another person is not affected
    });

    it("responses and refusals match the OpenAPI contract", async () => {
      const spec = loadSpec();
      const check = (method: string, path: string, statusCode: number, body: unknown) => {
        const schema = responseSchema(spec, method, path, statusCode);
        expect(typeof schema, `${method} ${path} ${statusCode}`).toBe("object");
        expect(validate(spec, schema, body), `${method} ${path} ${statusCode}`).toEqual([]);
      };
      const P = "/v1/tenants/{tenantId}/me/hr";
      check("GET", `${P}/handoff-status`, 200, (await status("admin")).json());
      check("GET", `${P}/handoff-status`, 200, (await status("admin", { app: await appWith({ PLATFORM_HANDOFF_ENABLED: undefined }) })).json());
      check("POST", `${P}/handoff`, 200, (await open("admin")).json());
      fake.register(ids.tenantA, PLATFORM_A, null);
      check("POST", `${P}/handoff-request`, 200, (await ask("admin", { app: await appWith() })).json());
      const errorSchema = { $ref: "#/components/schemas/Error" };
      for (const res of [await open("teacher"), await open("adminB", { tenantId: ids.tenantB }), await open("admin")]) {
        expect([403, 409]).toContain(res.statusCode);
        expect(validate(spec, errorSchema, res.json())).toEqual([]);
      }
      fake.register(ids.tenantA, PLATFORM_A, "active");
      expect(validate(spec, errorSchema, (await ask("admin", { app: await appWith() })).json())).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ what must never be written
  it("the one-time link and its code never reach a log line, an audit row or an error; nor do tokens, secrets, names or e-mails", async () => {
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    const links: string[] = [];
    try {
      const app = await appWith();
      for (const who of ["admin", "bursar", "delegate"]) {
        const res = await open(who, { app });
        expect(res.statusCode).toBe(200);
        links.push(res.json().url);
      }
      await status("admin", { app });
      await ask("adminB", { tenantId: ids.tenantB, app });
      fake.platformDown = 500;
      await open("admin", { app });
      fake.platformDown = 0;
      await open("admin", { app });
      fake.platformDown = null;
      fake.handoffRaw = { status: 201, body: '{"url":"http://hr.example.test/x?code=CODE-CANARY-http"}', type: "application/json" };
      await open("admin", { app });
      fake.handoffRaw = { status: 409, body: '{"error":{"code":"target_not_enabled","message":"PLATFORM-CANARY-409"}}', type: "application/json" };
      await open("admin", { app });
      fake.handoffRaw = null;
      fake.platformRejectNext = 2;
      await open("admin", { app });
      fake.tokenStatus = 400;
      await open("admin", { app: await appWith() });
      fake.tokenStatus = null;
      await open("super", { app });
      await open("teacher", { app });
    } finally {
      restore();
    }
    const all = lines.join("\n");
    expect(lines.length).toBeGreaterThan(10);
    expect(all).toContain("hr_handoff_failed"); // failures are logged, by reason only
    expect(all).toContain("hr_handoff_bad_answer");
    const codes = fake.handoffLinks.map((l) => l.code);
    expect(codes.length).toBeGreaterThanOrEqual(3);
    for (const secret of [...links, ...codes, "CODE-CANARY", "CANARY", "hr.example.test", "handoff?code", FAKE_CLIENT_SECRET, "token-", "Basic ", "Bearer", "Admin A", "Bea Bursar", "Olu Delegate", "admin-a@example.com", "org-delegate@example.com", fake.tokenUrl, fake.platformUrl, "invalid_client"]) {
      expect(all, secret).not.toContain(secret);
    }
    for (const line of lines) {
      expect(Object.keys(JSON.parse(line)).every((k) => ["level", "time", "msg", "request_id", "method", "route", "status", "duration_ms", "tenant_id", "user_id", "error_code", "error_class", "sqlstate", "outcome", "reason", "job_id", "job_type", "attempt"].includes(k))).toBe(true);
    }
    // no audit row anywhere holds a link or a code
    const audit = (await ctx.pool.query<{ t: string }>(`SELECT coalesce(string_agg(event_type || ' ' || detail::text, E'\\n'), '') AS t FROM security_audit_events`)).rows[0]!.t;
    for (const secret of [...links, ...codes, "CODE-CANARY", "hr.example.test"]) expect(audit, secret).not.toContain(secret);
    expect(audit).toContain("hr.handoff.opened");
  });
});
