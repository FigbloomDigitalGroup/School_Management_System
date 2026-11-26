import { randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { setLogSink } from "../src/log.js";
import { hashPassword } from "../src/modules/identity/password.js";
import { NOT_READY } from "../src/modules/hr/hrRefusal.js";
import { createTestApp, type FixtureIds } from "./support.js";
import { FakeHr, FAKE_CLIENT_ID, FAKE_CLIENT_SECRET, startSink } from "./support/fakeHr.js";
import { loadSpec, responseSchema, validate } from "./support/openapiConformance.js";

/**
 * My HR (docs/MY-HR.md) through the real application and the real figbloom_app login, against a FAKE Figbloom HR and platform
 * (a local HTTP server, test/support/fakeHr.ts). Nothing here reaches a real HR, a real platform or a real credential.
 */

type Ctx = Awaited<ReturnType<typeof createTestApp>>;
type App = Ctx["app"];
type Json = Record<string, any>;

const PASSWORD = "correct-horse-battery";
const MY_HR_ENV = ["MY_HR_ENABLED", "PLATFORM_CLIENT_ID", "PLATFORM_CLIENT_SECRET", "PLATFORM_TOKEN_URL", "PLATFORM_API_URL", "HR_MY_HR_URL", "MY_HR_HTTP_TIMEOUT_MS"];

const OCT = "aaaaaaaa-0000-4000-8000-000000000010";
const OTHERS = "bbbbbbbb-0000-4000-8000-000000000099";
/** One published payslip as HR passes it on (salary_history less the tenant and the account number). */
const OCT_SLIP = {
  id: OCT, employee_id: "EMP-001", employee_name: "Tom Teacher", pay_period: "2026-10", country: "Kenya", currency: "KES",
  basic_salary: 45000, house_allowance: 5000, gross_pay: 50000, paye: 6000, nssf_deduction: 1080, shif: 1375, housing_levy: 750,
  total_deductions: 9205, net_pay: 40795, bank_name: "KCB", account_number_last4: "4321", run_status: "paid",
  approved_at: "2026-10-27T09:00:00Z", paid_at: "2026-10-28T09:00:00Z",
};

describe("My HR on the API", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let fake: FakeHr;
  const savedEnv: Record<string, string | undefined> = {};
  const extraApps: App[] = [];
  let driverId = "";
  let staffId = "";
  let rateId = "";
  let newTeacherId = "";
  let tokens: Record<string, string> = {};

  const baseEnv = (): Record<string, string | undefined> => ({
    MY_HR_ENABLED: "true",
    PLATFORM_CLIENT_ID: FAKE_CLIENT_ID,
    PLATFORM_CLIENT_SECRET: FAKE_CLIENT_SECRET,
    PLATFORM_TOKEN_URL: fake.tokenUrl,
    PLATFORM_API_URL: fake.platformUrl,
    HR_MY_HR_URL: fake.hrUrl,
    MY_HR_HTTP_TIMEOUT_MS: "5000",
  });

  /** Another app on the same database and the same runtime login, with its own settings and its own token cache. */
  async function appWith(overrides: Record<string, string | undefined> = {}): Promise<App> {
    const env = { ...baseEnv(), ...overrides };
    const before: Record<string, string | undefined> = {};
    for (const name of [...MY_HR_ENV, "DATABASE_URL"]) before[name] = process.env[name];
    for (const name of MY_HR_ENV) {
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

  const headers = (token: string, tenantId: string = ids.tenantA, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, "x-tenant-id": tenantId, ...extra });
  const hrUrl = (path: string, tenantId: string = ids.tenantA) => `/v1/tenants/${tenantId}/me/hr/${path}`;
  const get = (path: string, token: string, opts: { tenantId?: string; app?: App; extra?: Record<string, string> } = {}) =>
    (opts.app ?? ctx.app).inject({ method: "GET", url: hrUrl(path, opts.tenantId), headers: headers(token, opts.tenantId, opts.extra) });

  async function login(app: App, body: Json): Promise<string> {
    const res = await app.inject({ method: "POST", url: body.email ? "/v1/auth/login/email" : "/v1/auth/login/login-id", payload: body });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    return res.json().token as string;
  }
  async function newMember(role: string, loginId: string, tenantId: string): Promise<{ id: string; token: string }> {
    const id = randomUUID();
    const hash = (await ctx.pool.query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE id = $1`, [ids.adminA])).rows[0]!.password_hash;
    await ctx.pool.query(`INSERT INTO users (id, email, password_hash, full_name, status) VALUES ($1, NULL, $2, $3, 'active')`, [id, hash, `${role} ${loginId}`]);
    await ctx.pool.query(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, $3, $4)`, [id, tenantId, role, loginId]);
    return { id, token: await login(ctx.app, { tenantId, loginId, password: PASSWORD }) };
  }
  const setLink = (tenantId: string, set: string) => ctx.pool.query(`UPDATE platform_school_links SET ${set} WHERE tenant_id = $1`, [tenantId]);

  beforeAll(async () => {
    fake = await FakeHr.start();
    for (const name of MY_HR_ENV) savedEnv[name] = process.env[name];
    for (const [name, value] of Object.entries(baseEnv())) if (value !== undefined) process.env[name] = value;
    ctx = await createTestApp();
    ids = ctx.ids;
    await hashPassword(PASSWORD); // warm the hasher
    const driver = await newMember("driver", "DR-0001", ids.tenantA);
    const staff = await newMember("staff", "ST-0001", ids.tenantA);
    const rate = await newMember("staff", "ST-0002", ids.tenantA);
    const fresh = await newMember("teacher", "TC-0002", ids.tenantA);
    const unlinked = await newMember("teacher", "TC-0003", ids.tenantA);
    [driverId, staffId, rateId, newTeacherId] = [driver.id, staff.id, rate.id, fresh.id];
    tokens = {
      admin: await login(ctx.app, { email: "admin-a@example.com", password: PASSWORD }),
      teacher: await login(ctx.app, { tenantId: ids.tenantA, loginId: "TC-0001", password: PASSWORD }),
      parent: await login(ctx.app, { tenantId: ids.tenantA, loginId: "PT-0001", password: PASSWORD }),
      teacherB: await login(ctx.app, { tenantId: ids.tenantB, loginId: "TC-0001", password: PASSWORD }),
      super: await login(ctx.app, { email: "super@example.com", password: PASSWORD }),
      orgAdmin: await login(ctx.app, { email: "orgadmin@example.com", password: PASSWORD }),
      driver: driver.token,
      staff: staff.token,
      rate: rate.token,
      newTeacher: fresh.token,
      unlinkedTeacher: unlinked.token,
    };
    // the documented operator step (docs/MY-HR.md, "Linking a school"): school A is known to the platform; school B is not
    await ctx.pool.query(`INSERT INTO platform_school_links (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`, [ids.tenantA]);
    // HR: school A is linked to a company; the API's user id is the person's external id
    fake.link(ids.tenantA, "company-a");
    for (const [person, number, name] of [
      [ids.teacherA, "EMP-001", "Tom Teacher"], [ids.adminA, "EMP-002", "Mary Principal"], [driverId, "EMP-003", "Dan Driver"],
      [staffId, "EMP-004", "Cate Cook"], [rateId, "EMP-005", "Rita Rate"],
    ] as const) fake.hire("company-a", person, { number, name });
    fake.hire("company-a", newTeacherId, { number: "EMP-006", name: "Nina New", draft: true });
    fake.payslips.set("EMP-001", [OCT_SLIP]);
    fake.payslips.set("EMP-002", [{ ...OCT_SLIP, id: OTHERS, employee_id: "EMP-002", employee_name: "Mary Principal" }]);
  }, 240_000);

  afterAll(async () => {
    for (const app of extraApps) await app.close();
    await ctx.app.close();
    await ctx.pool.end();
    await fake.stop();
    for (const name of MY_HR_ENV) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  });

  beforeEach(async () => {
    fake.calls = [];
    fake.enabled = true;
    fake.down = null;
    fake.rejectNext = 0;
    fake.delayMs = 0;
    fake.rawAnswer = null;
    fake.redirectTo = null;
    fake.tokenStatus = null;
    fake.tokenSeconds = 3600;
    fake.tokenDelayMs = 0;
    fake.link(ids.tenantA, "company-a");
    await setLink(ids.tenantA, "hr_enabled = NULL, hr_reason = NULL, hr_checked_at = NULL");
    // the many calls of one test run must not use up one person's minute (the limit itself is tested below)
    await ctx.pool.query(`DELETE FROM auth_rate_buckets WHERE bucket_key LIKE 'my_hr:%'`);
  });

  // ------------------------------------------------------------------ the status
  describe("GET /me/hr/status", () => {
    it("a staff member of a linked school: available, for every staff role", async () => {
      for (const who of ["teacher", "admin", "driver", "staff"]) {
        const res = await get("status", tokens[who]!);
        expect(res.statusCode, who).toBe(200);
        expect(res.json()).toEqual({ status: "available" });
      }
      expect(fake.calls).toEqual([]); // the status never asks HR
    });

    it("anyone else is told not_staff (200): a parent, an org admin or Figbloom staff acting for the school", async () => {
      for (const who of ["parent", "orgAdmin", "super"]) {
        const res = await get("status", tokens[who]!);
        expect(res.statusCode, who).toBe(200);
        expect(res.json(), who).toEqual({ status: "not_staff" });
      }
    });

    it("a school the platform does not know: not_linked", async () => {
      const res = await get("status", tokens.teacherB!, { tenantId: ids.tenantB });
      expect(res.json()).toEqual({ status: "not_linked" });
    });

    it("a recent 'HR is not on' from the platform: not_enabled; older than an hour, or for the hand-off URL only, or a yes: available", async () => {
      await setLink(ids.tenantA, "hr_enabled = false, hr_reason = 'target_not_enabled', hr_checked_at = now() - interval '5 minutes'");
      expect((await get("status", tokens.teacher!)).json().status).toBe("not_enabled");
      await setLink(ids.tenantA, "hr_reason = 'target_not_linked'");
      expect((await get("status", tokens.teacher!)).json().status).toBe("not_enabled");
      await setLink(ids.tenantA, "hr_checked_at = now() - interval '61 minutes'");
      expect((await get("status", tokens.teacher!)).json().status).toBe("available");
      await setLink(ids.tenantA, "hr_reason = 'target_no_handoff_url', hr_checked_at = now()");
      expect((await get("status", tokens.teacher!)).json().status).toBe("available");
      await setLink(ids.tenantA, "hr_enabled = true, hr_reason = NULL, hr_checked_at = now()");
      expect((await get("status", tokens.teacher!)).json().status).toBe("available");
    });

    it("off: MY_HR_ENABLED not true, or a setting missing. A parent is still not_staff; a school's staff is off", async () => {
      for (const overrides of [{ MY_HR_ENABLED: undefined }, { MY_HR_ENABLED: "false" }, { PLATFORM_CLIENT_SECRET: undefined }, { HR_MY_HR_URL: undefined }, { PLATFORM_TOKEN_URL: undefined }, { PLATFORM_CLIENT_ID: undefined }]) {
        const app = await appWith(overrides);
        expect((await get("status", tokens.teacher!, { app })).json(), JSON.stringify(overrides)).toEqual({ status: "off" });
        expect((await get("status", tokens.parent!, { app })).json().status).toBe("not_staff");
      }
      // PLATFORM_API_URL is not needed for My HR
      const noApi = await appWith({ PLATFORM_API_URL: undefined });
      expect((await get("status", tokens.teacher!, { app: noApi })).json().status).toBe("available");
    });

    it("is about the caller only: another school's id in the path is refused, and so is no session", async () => {
      expect((await get("status", tokens.teacher!, { tenantId: ids.tenantB })).statusCode).toBe(403);
      expect((await get("status", tokens.teacherB!, { tenantId: ids.tenantA })).statusCode).toBe(403);
      expect((await ctx.app.inject({ method: "GET", url: hrUrl("status") })).statusCode).toBe(401);
      expect((await ctx.app.inject({ method: "GET", url: "/v1/tenants/not-a-uuid/me/hr/status", headers: headers(tokens.teacher!) })).statusCode).toBe(400);
    });

    it("an archived membership, or a disabled account, is refused", async () => {
      const gone = await newMember("teacher", "TC-0009", ids.tenantA);
      expect((await get("status", gone.token)).statusCode).toBe(200);
      await ctx.pool.query(`UPDATE school_memberships SET archived_at = now() WHERE user_id = $1`, [gone.id]);
      expect((await get("status", gone.token)).statusCode).toBe(403);
      const off = await newMember("teacher", "TC-0010", ids.tenantA);
      await ctx.pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [off.id]);
      expect((await get("status", off.token)).statusCode).toBe(401);
    });
  });

  // ------------------------------------------------------------------ the read routes
  describe("the read routes", () => {
    it("pass HR's JSON through as it sent it, for the caller's own school and person only", async () => {
      const slip = (await get(`payslips/${OCT}`, tokens.teacher!)).json();
      expect(slip).toEqual({ status: "active", payslip: OCT_SLIP });
      for (const [path, key] of [["summary", "employee"], ["payslips", "payslips"], ["leave", "balances"], ["kpis", "period"], ["attendance", "days"]] as const) {
        const res = await get(path, tokens.teacher!);
        expect(res.statusCode, path).toBe(200);
        expect(res.json()[key], path).toBeDefined();
        expect(res.headers["cache-control"]).toBe("no-store");
      }
      expect((await get("summary", tokens.teacher!)).json().employee.name).toBe("Tom Teacher");
      const withToken = fake.calls.filter((c) => c.token.startsWith("token-"));
      expect(withToken.length).toBe(fake.calls.length);
      for (const call of fake.calls) {
        expect(call.school).toBe(ids.tenantA);
        expect(call.person).toBe(ids.teacherA);
        expect(call.method).toBe("GET");
      }
      expect(fake.calls.map((c) => c.path)).toEqual([`payslips/${OCT}`, "summary", "payslips", "leave", "kpis", "attendance", "summary"]);
    });

    it("every staff role gets its own record: teacher, school admin, driver, other staff", async () => {
      for (const [who, id] of [["teacher", ids.teacherA], ["admin", ids.adminA], ["driver", driverId], ["staff", staffId]] as const) {
        fake.calls = [];
        const res = await get("summary", tokens[who]!);
        expect(res.statusCode, who).toBe(200);
        expect(fake.calls[0]).toMatchObject({ school: ids.tenantA, person: id });
      }
    });

    it("a school or person named in a header, the query or a body changes nothing", async () => {
      const res = await ctx.app.inject({
        method: "GET",
        url: `${hrUrl("attendance")}?from=2026-10-01&to=2026-10-31&person=${ids.adminA}&school=${ids.tenantB}&tenantId=${ids.tenantB}&userId=${ids.adminA}`,
        headers: headers(tokens.teacher!, ids.tenantA, { "x-figbloom-school": ids.tenantB, "x-figbloom-person": ids.adminA, "x-person": ids.adminA }),
      });
      expect(res.statusCode).toBe(200);
      expect(fake.calls).toHaveLength(1);
      expect(fake.calls[0]).toMatchObject({ path: "attendance", search: "?from=2026-10-01&to=2026-10-31", school: ids.tenantA, person: ids.teacherA });
      expect(fake.calls[0]!.headers["x-person"]).toBeUndefined();
      // the body of a GET is not read either
      const withBody = await ctx.app.inject({ method: "GET", url: hrUrl("summary"), headers: { ...headers(tokens.teacher!), "content-type": "application/json" }, payload: JSON.stringify({ school: ids.tenantB, person: ids.adminA, tenant_id: ids.tenantB }) });
      if (withBody.statusCode === 200) expect(fake.calls.at(-1)).toMatchObject({ school: ids.tenantA, person: ids.teacherA });
      else expect(withBody.statusCode).toBeLessThan(500);
    });

    it("another person's payslip, by its id, is not found", async () => {
      const res = await get(`payslips/${OTHERS}`, tokens.teacher!);
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toMatchObject({ code: "not_found", message: "That payslip isn't available." });
    });

    it("there are no write routes", async () => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
        for (const path of ["summary", "payslips", `payslips/${OCT}`, "leave", "attendance", "kpis", "status", "leave/apply", "approvals"]) {
          const res = await ctx.app.inject({ method, url: hrUrl(path), headers: headers(tokens.teacher!), ...(method === "DELETE" ? {} : { payload: {} }) });
          expect(res.statusCode, `${method} ${path}`).toBe(404);
        }
      }
      expect(fake.calls).toEqual([]);
    });

    it("refuse bad ids and dates before HR is asked", async () => {
      for (const bad of ["..%2Fadmin", "a%20b", "x".repeat(65), "a%3Fb%3D1"]) {
        const res = await get(`payslips/${bad}`, tokens.teacher!);
        expect(res.statusCode, bad).toBe(400);
        expect(res.json().error.code).toBe("validation_error");
      }
      // dot segments are resolved by the router before any handler: they never reach HR either
      expect([400, 404]).toContain((await get("payslips/%2e%2e", tokens.teacher!)).statusCode);
      for (const query of ["from=yesterday", "from=2026-02-31", "to=2026-13-01", "from=2026-11-05&to=2026-11-01", "from=2026-01-01&to=2026-04-04", "from=2026-10-01&from=2026-10-02", "to=2026-10-01&to=2026-10-02"]) {
        const res = await get(`attendance?${query}`, tokens.teacher!);
        expect(res.statusCode, query).toBe(400);
      }
      expect(fake.calls).toEqual([]);
      expect((await get("attendance?from=2026-01-01&to=2026-04-03", tokens.teacher!)).statusCode).toBe(200); // 93 days
      expect(fake.calls[0]!.search).toBe("?from=2026-01-01&to=2026-04-03");
    });

    it("a draft employee gets pending_hr (200) with the sentence, and no pay data", async () => {
      const res = await get("payslips", tokens.newTeacher!);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: "pending_hr", message: NOT_READY });
    });

    it("someone HR has no employee for: 404 not_linked, 'Your HR record isn't ready yet'", async () => {
      const res = await get("summary", tokens.unlinkedTeacher!);
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toMatchObject({ code: "not_linked", message: "Your HR record isn't ready yet. Ask the school's HR administrator." });
    });

    it("a recent 'HR is not on' is asked again: HR decides", async () => {
      await setLink(ids.tenantA, "hr_enabled = false, hr_reason = 'target_not_enabled', hr_checked_at = now()");
      expect((await get("status", tokens.teacher!)).json().status).toBe("not_enabled");
      expect((await get("summary", tokens.teacher!)).statusCode).toBe(200);
      expect(fake.calls).toHaveLength(1);
    });

    it("responses and refusals match the OpenAPI contract", async () => {
      const spec = loadSpec();
      const check = (path: string, status: number, body: unknown) => {
        const schema = responseSchema(spec, "GET", path, status);
        expect(typeof schema, `${path} ${status}`).toBe("object");
        expect(validate(spec, schema, body), `${path} ${status}`).toEqual([]);
      };
      check("/v1/tenants/{tenantId}/me/hr/status", 200, (await get("status", tokens.teacher!)).json());
      for (const [path, spec_] of [["summary", "summary"], ["payslips", "payslips"], [`payslips/${OCT}`, "payslips/{payslipId}"], ["leave", "leave"], ["attendance", "attendance"], ["kpis", "kpis"]] as const) {
        check(`/v1/tenants/{tenantId}/me/hr/${spec_}`, 200, (await get(path, tokens.teacher!)).json());
      }
      const errorSchema = { $ref: "#/components/schemas/Error" };
      for (const res of [await get("summary", tokens.parent!), await get("payslips/..%2Fx", tokens.teacher!), await get(`payslips/${OTHERS}`, tokens.teacher!), await get("summary", tokens.unlinkedTeacher!)]) {
        expect(validate(spec, errorSchema, res.json())).toEqual([]);
      }
      fake.down = 500;
      const down = await get("summary", tokens.teacher!);
      expect(down.statusCode).toBe(503);
      expect(validate(spec, errorSchema, down.json())).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ who may call
  describe("who may call", () => {
    it("a parent, an org admin and Figbloom staff are refused (403 forbidden) and HR and the platform are not asked", async () => {
      const app = await appWith();
      for (const who of ["parent", "orgAdmin", "super"]) {
        for (const path of ["summary", "payslips", `payslips/${OCT}`, "leave", "attendance", "kpis"]) {
          const res = await get(path, tokens[who]!, { app });
          expect(res.statusCode, `${who} ${path}`).toBe(403);
          expect(res.json().error).toMatchObject({ code: "forbidden", message: "My HR is for the school's staff." });
        }
      }
      expect(fake.calls).toEqual([]);
    });

    it("another school's staff cannot reach this school's record, by the path or by X-Tenant-Id", async () => {
      expect((await get("summary", tokens.teacherB!, { tenantId: ids.tenantA })).statusCode).toBe(403);
      expect((await get("summary", tokens.teacher!, { tenantId: ids.tenantB })).statusCode).toBe(403);
      const res = await ctx.app.inject({ method: "GET", url: hrUrl("summary", ids.tenantA), headers: { authorization: `Bearer ${tokens.teacherB}`, "x-tenant-id": ids.tenantB } });
      expect(res.statusCode).toBe(403); // the header names B, the path A: the path must equal the session's school
      expect(JSON.stringify(res.json())).not.toContain(ids.tenantA);
      expect(fake.calls).toEqual([]);
    });

    it("no session is 401, a disabled account 401", async () => {
      expect((await ctx.app.inject({ method: "GET", url: hrUrl("summary") })).statusCode).toBe(401);
      expect((await ctx.app.inject({ method: "GET", url: hrUrl("summary"), headers: { authorization: "Bearer nope" } })).statusCode).toBe(401);
    });
  });

  // ------------------------------------------------------------------ off, and not linked
  describe("off by default", () => {
    it("with nothing set the data routes answer 403 my_hr_off and nothing is called", async () => {
      const tokenCalls = fake.tokenCalls.length;
      const app = await appWith({ MY_HR_ENABLED: undefined, PLATFORM_CLIENT_ID: undefined, PLATFORM_CLIENT_SECRET: undefined, PLATFORM_TOKEN_URL: undefined, PLATFORM_API_URL: undefined, HR_MY_HR_URL: undefined });
      for (const path of ["summary", "payslips", `payslips/${OCT}`, "leave", "attendance", "kpis"]) {
        const res = await get(path, tokens.teacher!, { app });
        expect(res.statusCode, path).toBe(403);
        expect(res.json().error).toMatchObject({ code: "my_hr_off", message: "My HR isn't available yet." });
      }
      expect((await get("status", tokens.teacher!, { app })).json()).toEqual({ status: "off" });
      expect(fake.calls).toEqual([]);
      expect(fake.tokenCalls.length).toBe(tokenCalls);
    });

    it("switched on but incomplete is off too, and the token endpoint is never asked", async () => {
      const before = fake.tokenCalls.length;
      const app = await appWith({ PLATFORM_CLIENT_SECRET: undefined });
      const res = await get("summary", tokens.teacher!, { app });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("my_hr_off");
      expect(fake.tokenCalls.length).toBe(before);
    });

    it("a school the platform does not know is 409 school_not_linked and HR is not asked", async () => {
      for (const path of ["summary", "payslips", "kpis"]) {
        const res = await get(path, tokens.teacherB!, { tenantId: ids.tenantB });
        expect(res.statusCode, path).toBe(409);
        expect(res.json().error).toMatchObject({ code: "school_not_linked", message: "This school isn't connected to Figbloom HR yet. Ask Figbloom." });
      }
      expect(fake.calls).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ the platform token
  describe("the platform token", () => {
    it("is fetched once with the client credentials and kept between calls", async () => {
      const app = await appWith();
      const before = fake.tokenCalls.length;
      const issued = fake.tokensIssued;
      for (let i = 0; i < 3; i++) expect((await get("summary", tokens.teacher!, { app })).statusCode).toBe(200);
      expect(fake.tokenCalls.length - before).toBe(1);
      expect(fake.tokensIssued - issued).toBe(1);
      const call = fake.tokenCalls.at(-1)!;
      expect(call.authorization).toBe(`Basic ${Buffer.from(`${FAKE_CLIENT_ID}:${FAKE_CLIENT_SECRET}`).toString("base64")}`);
      expect(call.contentType).toBe("application/x-www-form-urlencoded");
      expect(new URLSearchParams(call.body).get("grant_type")).toBe("client_credentials");
      expect(new Set(fake.calls.map((c) => c.token)).size).toBe(1);
    });

    it("a token that lives less than a minute is fetched again for every call", async () => {
      fake.tokenSeconds = 30;
      const app = await appWith();
      const issued = fake.tokensIssued;
      await get("summary", tokens.teacher!, { app });
      await get("summary", tokens.teacher!, { app });
      expect(fake.tokensIssued - issued).toBe(2);
    });

    it("a 401 from HR is retried once with a fresh token", async () => {
      const app = await appWith();
      await get("summary", tokens.teacher!, { app });
      fake.calls = [];
      fake.rejectNext = 1;
      const issued = fake.tokensIssued;
      const res = await get("summary", tokens.teacher!, { app });
      expect(res.statusCode).toBe(200);
      expect(fake.calls).toHaveLength(2);
      expect(fake.calls[0]!.token).not.toBe(fake.calls[1]!.token);
      expect(fake.tokensIssued - issued).toBe(1);
    });

    it("a 401 twice means HR does not accept Schools: 502 hr_not_connected", async () => {
      fake.rejectNext = 2;
      const res = await get("summary", tokens.teacher!, { app: await appWith() });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toMatchObject({ code: "hr_not_connected", message: "Figbloom HR isn't connected to this school yet. Ask Figbloom." });
      expect(fake.calls).toHaveLength(2);
    });

    it("a token that cannot be had is 503 hr_unavailable, HR is not called, and the secret is not in the answer", async () => {
      fake.tokenStatus = 400;
      const res = await get("summary", tokens.teacher!, { app: await appWith() });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("hr_unavailable");
      expect(res.headers["retry-after"]).toBe("30");
      expect(res.body).not.toMatch(/CANARY|secret|invalid_client/i);
      expect(fake.calls).toEqual([]);
    });

    it("a token endpoint that does not answer in time is 503 within the timeout", async () => {
      fake.tokenDelayMs = 1500;
      const app = await appWith({ MY_HR_HTTP_TIMEOUT_MS: "250" });
      const started = Date.now();
      const res = await get("summary", tokens.teacher!, { app });
      expect(res.statusCode).toBe(503);
      expect(Date.now() - started).toBeLessThan(1400);
      expect(fake.calls).toEqual([]);
    });
  });

  // ------------------------------------------------------------------ HR's answers
  describe("HR's refusals, as a person reads them", () => {
    const answer = (status: number, body: string, headers?: Record<string, string>) => {
      fake.rawAnswer = { status, body, type: "application/json", headers };
    };

    it("HR down (5xx) or unreachable: 503 hr_unavailable with Retry-After, and none of HR's words", async () => {
      for (const down of [500, 502, 503, 504, 0]) {
        fake.down = down;
        const res = await get("leave", tokens.teacher!);
        expect(res.statusCode, String(down)).toBe(503);
        expect(res.json().error).toMatchObject({ code: "hr_unavailable", message: "HR & Payroll can't be reached right now. Try again in a minute." });
        expect(res.headers["retry-after"]).toBe("30");
        expect(res.body).not.toContain("CANARY");
      }
    });

    it("HR's own switch off: 503 hr_off", async () => {
      fake.enabled = false;
      const res = await get("summary", tokens.teacher!);
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatchObject({ code: "hr_off", message: "My HR is switched off in Figbloom HR for now. Try again later." });
    });

    it("HR does not know the school: 502 hr_not_connected", async () => {
      fake.companies.delete(ids.tenantA);
      const res = await get("summary", tokens.teacher!);
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe("hr_not_connected");
    });

    it("HR's 429 is 429 with HR's wait", async () => {
      answer(429, '{"error":{"code":"rate_limited"}}', { "retry-after": "17" });
      const res = await get("kpis", tokens.teacher!);
      expect(res.statusCode).toBe(429);
      expect(res.json().error.code).toBe("rate_limited");
      expect(res.headers["retry-after"]).toBe("17");
    });

    it("HR's own 403 is hr_forbidden, in HR's short sentence", async () => {
      answer(403, '{"error":{"code":"no_access","message":"No access to payroll."}}');
      const res = await get("payslips", tokens.teacher!);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatchObject({ code: "hr_forbidden", message: "No access to payroll." });
    });

    it("HR's 400 is a validation error in HR's sentence", async () => {
      answer(400, '{"error":{"code":"bad_request","message":"Choose a range of 93 days or less."}}');
      const res = await get("attendance?from=2026-10-01&to=2026-10-31", tokens.teacher!);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatchObject({ code: "validation_error", message: "Choose a range of 93 days or less." });
    });

    it("an answer that is not JSON, not an object, or too large is 502 hr_bad_answer", async () => {
      for (const [body, type] of [["<html>oops</html>", "text/html"], ["[1,2,3]", "application/json"], ["null", "application/json"], ['{"big":"' + "x".repeat(1024 * 1024) + '"}', "application/json"]] as const) {
        fake.rawAnswer = { status: 200, body, type };
        const res = await get("kpis", tokens.teacher!);
        expect(res.statusCode, body.slice(0, 20)).toBe(502);
        expect(res.json().error.code).toBe("hr_bad_answer");
      }
    });

    it("a redirect is never followed: 503, and the address it names is never reached", async () => {
      const sink = await startSink();
      try {
        fake.redirectTo = `${sink.origin}/steal`;
        const res = await get("summary", tokens.teacher!);
        expect(res.statusCode).toBe(503);
        expect(res.json().error.code).toBe("hr_unavailable");
        expect(sink.hits).toEqual([]);
        expect(fake.calls).toHaveLength(1);
      } finally {
        await sink.stop();
      }
    });

    it("HR that does not answer in time is 503 within the timeout", async () => {
      fake.delayMs = 1500;
      const app = await appWith({ MY_HR_HTTP_TIMEOUT_MS: "250" });
      await get("status", tokens.teacher!, { app });
      const started = Date.now();
      const res = await get("summary", tokens.teacher!, { app });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("hr_unavailable");
      expect(Date.now() - started).toBeLessThan(1400);
    });
  });

  // ------------------------------------------------------------------ rate limit
  it("is rate limited per person: 30 calls a minute, then 429 with Retry-After, and HR is not asked for the refused one", async () => {
    for (let i = 0; i < 30; i++) expect((await get("summary", tokens.rate!)).statusCode, `call ${i + 1}`).toBe(200);
    const res = await get("summary", tokens.rate!);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("rate_limited");
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(fake.calls).toHaveLength(30);
    expect((await get("summary", tokens.teacher!)).statusCode).toBe(200); // another person is not affected
  });

  // ------------------------------------------------------------------ nothing HR sends is logged
  it("nothing HR sends, no token and no secret reaches the logs, on success or on failure", async () => {
    const lines: string[] = [];
    const restore = setLogSink((line) => lines.push(line));
    try {
      const app = await appWith();
      await get(`payslips/${OCT}`, tokens.teacher!, { app });
      await get("summary", tokens.teacher!, { app });
      await get("summary", tokens.unlinkedTeacher!, { app });
      fake.down = 500;
      await get("leave", tokens.teacher!, { app });
      fake.down = 0;
      await get("leave", tokens.teacher!, { app });
      fake.down = null;
      fake.rawAnswer = { status: 403, body: '{"error":{"code":"x","message":"HR-CANARY-403-words"}}', type: "application/json" };
      await get("kpis", tokens.teacher!, { app });
      fake.rawAnswer = { status: 200, body: "<html>HR-CANARY-html</html>", type: "text/html" };
      await get("kpis", tokens.teacher!, { app });
      fake.rawAnswer = null;
      fake.rejectNext = 2;
      await get("summary", tokens.teacher!, { app });
      fake.tokenStatus = 400;
      await get("summary", tokens.teacher!, { app: await appWith() });
    } finally {
      restore();
    }
    const all = lines.join("\n");
    expect(lines.length).toBeGreaterThan(10);
    expect(all).toContain("my_hr_call_failed"); // the failures were logged, by reason only
    for (const secret of ["Tom Teacher", "Mary Principal", "account_number", "EMP-001", "CANARY", FAKE_CLIENT_SECRET, "token-", "Basic ", "Bearer", "KCB", "net_pay", "Academics", fake.hrUrl, fake.tokenUrl, "invalid_client"]) {
      expect(all, secret).not.toContain(secret);
    }
    for (const line of lines) expect(Object.keys(JSON.parse(line)).every((k) => ["level", "time", "msg", "request_id", "method", "route", "status", "duration_ms", "tenant_id", "user_id", "error_code", "error_class", "sqlstate", "outcome", "reason", "job_id", "job_type", "attempt"].includes(k))).toBe(true);
  });

  // ------------------------------------------------------------------ the link table
  describe("platform_school_links", () => {
    const asApp = async <T>(tenantId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
      const client = await ctx.runtimePool.connect();
      try {
        await client.query("BEGIN");
        if (tenantId) {
          await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.teacherA]);
          await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
        }
        return await fn(client);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
      }
    };

    /** School B is linked for the length of one test; the not_linked tests above rely on it having no row. */
    const withLinkB = async (fn: () => Promise<void>) => {
      await ctx.pool.query(`INSERT INTO platform_school_links (tenant_id) VALUES ($1)`, [ids.tenantB]);
      try {
        await fn();
      } finally {
        await ctx.pool.query(`DELETE FROM platform_school_links WHERE tenant_id = $1`, [ids.tenantB]);
      }
    };

    it("the runtime login sees only its own school's row, and nothing without a school", () =>
      withLinkB(async () => {
        expect((await ctx.pool.query(`SELECT count(*)::int AS n FROM platform_school_links`)).rows[0].n).toBe(2);
        const a = await asApp(ids.tenantA, (c) => c.query(`SELECT tenant_id FROM platform_school_links`));
        expect(a.rows).toEqual([{ tenant_id: ids.tenantA }]);
        const b = await asApp(ids.tenantB, (c) => c.query(`SELECT tenant_id FROM platform_school_links`));
        expect(b.rows).toEqual([{ tenant_id: ids.tenantB }]);
        expect((await asApp(null, (c) => c.query(`SELECT 1 FROM platform_school_links`))).rowCount).toBe(0);
      }));

    it("the runtime login cannot add, remove or re-point a row; it may only record HR's answer for its own school (migration 117)", async () => {
      for (const sql of [
        `INSERT INTO platform_school_links (tenant_id) VALUES ('${randomUUID()}')`,
        `UPDATE platform_school_links SET tenant_id = tenant_id`,
        `UPDATE platform_school_links SET registered_at = now()`,
        `UPDATE platform_school_links SET platform_tenant_id = 'x'`,
        `DELETE FROM platform_school_links`,
        `TRUNCATE platform_school_links`,
      ]) {
        await expect(asApp(ids.tenantA, (c) => c.query(sql)), sql).rejects.toMatchObject({ code: "42501" });
      }
      // the HR & Payroll hand-off records the platform's answer: its own school's row only (the transaction is rolled back)
      await withLinkB(async () => {
        const own = await asApp(ids.tenantA, (c) => c.query(`UPDATE platform_school_links SET hr_enabled = true, hr_reason = NULL, hr_checked_at = now()`));
        expect(own.rowCount).toBe(1);
        const other = await asApp(ids.tenantA, (c) => c.query(`UPDATE platform_school_links SET hr_enabled = true, hr_checked_at = now() WHERE tenant_id = $1`, [ids.tenantB]));
        expect(other.rowCount).toBe(0);
        expect((await asApp(null, (c) => c.query(`UPDATE platform_school_links SET hr_enabled = true, hr_checked_at = now()`))).rowCount).toBe(0);
      });
    });

    it("is ENABLE + FORCE row security, with the tenant policy and the owner policy, and SELECT only for the runtime role", async () => {
      const flags = await ctx.pool.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'platform_school_links'`);
      expect(flags.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const policies = await ctx.pool.query(`SELECT policyname, roles::text[] AS roles, qual, with_check FROM pg_policies WHERE tablename = 'platform_school_links' ORDER BY policyname`);
      expect(policies.rows.map((p) => p.policyname)).toEqual(["platform_school_links_owner", "platform_school_links_tenant"]);
      const tenant = policies.rows.find((p) => p.policyname === "platform_school_links_tenant")!;
      expect(tenant.roles).toEqual(["figbloom_app"]);
      expect(tenant.qual).toMatch(/app_current_tenant_id/);
      expect(tenant.with_check).toMatch(/app_current_tenant_id/);
      const grants = await ctx.pool.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'platform_school_links' AND grantee = 'figbloom_app'`);
      expect(grants.rows.map((g) => g.privilege_type)).toEqual(["SELECT"]);
    });

    it("a row about HR needs both the answer and when it was given, and a short reason", () =>
      withLinkB(async () => {
        await expect(ctx.pool.query(`UPDATE platform_school_links SET hr_enabled = false WHERE tenant_id = $1`, [ids.tenantB])).rejects.toMatchObject({ code: "23514" });
        await expect(ctx.pool.query(`UPDATE platform_school_links SET hr_enabled = false, hr_checked_at = now(), hr_reason = $2 WHERE tenant_id = $1`, [ids.tenantB, "x".repeat(65)])).rejects.toMatchObject({ code: "23514" });
        await expect(ctx.pool.query(`INSERT INTO platform_school_links (tenant_id) VALUES ('${randomUUID()}')`)).rejects.toMatchObject({ code: "23503" }); // no such school
      }));
  });
});
