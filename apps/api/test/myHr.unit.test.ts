import { describe, expect, it } from "vitest";
import { isAllowedPlatformUrl, loadConfig } from "../src/config.js";
import { AppError } from "../src/http/errors.js";
import {
  hrBadAnswer,
  hrUnavailable,
  HR_NOT_CONNECTED,
  HR_OFF,
  HR_UNAVAILABLE,
  NOT_READY,
  refusalFromHr,
} from "../src/modules/hr/hrRefusal.js";
import { MY_HR_STAFF_ROLES, myHrSetup, planAttendance, planMyHr, planPayslip, resolveMyHrStatus } from "../src/modules/hr/myHr.js";
import { callHr, HrCallError, hrErrorCode, hrMessage } from "../src/platform/hrApi.js";
import { PlatformError, PlatformTokenClient, platformTokenConfigFrom, PLATFORM_TOKEN_SCOPE } from "../src/platform/platformClient.js";
import type { Tx } from "../src/db/sql.js";

/** My HR without a database: the settings, the planners, the refusal table, the token client and the HR caller (docs/MY-HR.md). */

const BASE_ENV = { DATABASE_URL: "postgresql://figbloom_app:x@127.0.0.1:5432/x", APP_ENV: "test" } as NodeJS.ProcessEnv;
const ALL = {
  MY_HR_ENABLED: "true",
  PLATFORM_CLIENT_ID: "id",
  PLATFORM_CLIENT_SECRET: "secret",
  PLATFORM_TOKEN_URL: "https://auth.platform.example/oauth2/token",
  PLATFORM_API_URL: "https://api.platform.example/",
  HR_MY_HR_URL: "https://hr.example/api/integrations/my-hr/",
};
const cfg = (extra: Record<string, string> = {}) => loadConfig({ ...BASE_ENV, ...extra } as NodeJS.ProcessEnv);
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("My HR settings: all optional, unset = off", () => {
  it("is off with nothing set, and reads none of the names", () => {
    const c = cfg();
    expect(c.myHrEnabled).toBe(false);
    expect([c.platformClientId, c.platformClientSecret, c.platformTokenUrl, c.platformApiUrl, c.hrMyHrUrl]).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(myHrSetup(c)).toEqual({ state: "off", missing: [] });
    expect(platformTokenConfigFrom(c)).toBeNull();
  });

  it("reads the six names; the trailing slash of the two base addresses is dropped", () => {
    const c = cfg(ALL);
    expect(c.myHrEnabled).toBe(true);
    expect(c.hrMyHrUrl).toBe("https://hr.example/api/integrations/my-hr");
    expect(c.platformApiUrl).toBe("https://api.platform.example");
    expect(c.platformTokenUrl).toBe("https://auth.platform.example/oauth2/token");
    expect(myHrSetup(c)).toEqual({ state: "on", missing: [] });
    expect(platformTokenConfigFrom(c)).toMatchObject({ clientId: "id", clientSecret: "secret", apiUrl: "https://api.platform.example", timeoutMs: 15_000 });
  });

  it("the switch alone, or the settings alone, leave it off or incomplete and name what is missing (never a value)", () => {
    expect(myHrSetup(cfg({ ...ALL, MY_HR_ENABLED: "false" }))).toEqual({ state: "off", missing: [] });
    expect(myHrSetup(cfg({ ...ALL, MY_HR_ENABLED: "yes" })).state).toBe("off"); // only the word true switches it on
    const { PLATFORM_CLIENT_SECRET: _s, HR_MY_HR_URL: _h, ...rest } = ALL;
    expect(myHrSetup(cfg(rest))).toEqual({ state: "incomplete", missing: ["PLATFORM_CLIENT_SECRET", "HR_MY_HR_URL"] });
    // PLATFORM_API_URL is not needed for My HR
    const { PLATFORM_API_URL: _a, ...noApi } = ALL;
    expect(myHrSetup(cfg(noApi)).state).toBe("on");
    expect(myHrSetup(cfg({ MY_HR_ENABLED: "true" })).missing).toHaveLength(4);
  });

  it("refuses a value that is set but not usable, naming the setting and never the value", () => {
    for (const [name, value] of [
      ["HR_MY_HR_URL", "http://hr.example/my-hr"],
      ["HR_MY_HR_URL", "https://user:pass@hr.example/my-hr"],
      ["HR_MY_HR_URL", "https://hr.example/my-hr?x=1"],
      ["HR_MY_HR_URL", "not a url"],
      ["PLATFORM_TOKEN_URL", "http://10.0.0.5/oauth2/token"],
      ["PLATFORM_API_URL", "ftp://api.platform.example"],
    ] as const) {
      let message = "";
      try {
        cfg({ ...ALL, [name]: value });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, `${name}=${value}`).toContain(name);
      expect(message).not.toContain(value);
    }
  });

  it("http is allowed only for a loopback host in local and test", () => {
    expect(isAllowedPlatformUrl("http://127.0.0.1:4000/x", "test")).toBe(true);
    expect(isAllowedPlatformUrl("http://localhost:4000/x", "local")).toBe(true);
    expect(isAllowedPlatformUrl("http://[::1]:4000/x", "local")).toBe(true);
    expect(isAllowedPlatformUrl("http://127.0.0.1:4000/x", "staging")).toBe(false);
    expect(isAllowedPlatformUrl("http://127.0.0.1:4000/x", "production")).toBe(false);
    expect(isAllowedPlatformUrl("http://hr.example/x", "test")).toBe(false);
    expect(isAllowedPlatformUrl("https://hr.example/x", "production")).toBe(true);
  });

  it("the timeout setting is bounded", () => {
    expect(cfg({ MY_HR_HTTP_TIMEOUT_MS: "2500" }).myHrHttpTimeoutMs).toBe(2500);
    expect(() => cfg({ MY_HR_HTTP_TIMEOUT_MS: "5" })).toThrow(/myHrHttpTimeoutMs/);
    expect(() => cfg({ MY_HR_HTTP_TIMEOUT_MS: "600000" })).toThrow(/myHrHttpTimeoutMs/);
  });
});

describe("what to ask HR for", () => {
  it("fixed paths for the four plain routes", () => {
    expect(planMyHr("summary")).toEqual({ route: "summary", path: "summary" });
    expect(planMyHr("kpis").path).toBe("kpis");
  });

  it("a payslip id is HR's own: letters, digits, _ and - only", () => {
    expect(planPayslip("aaaaaaaa-0000-4000-8000-000000000010").path).toBe("payslips/aaaaaaaa-0000-4000-8000-000000000010");
    expect(planPayslip("  abc_123  ").path).toBe("payslips/abc_123");
    for (const bad of ["", "../admin", "a/b", "a b", "a%2Fb", "x".repeat(65), undefined, 5, null, "abc?x=1", "abc#"]) {
      expect(() => planPayslip(bad), String(bad)).toThrow(AppError);
    }
  });

  it("attendance: real dates, in order, 93 days at most; other query fields are ignored and never passed on", () => {
    expect(planAttendance({}).path).toBe("attendance");
    expect(planAttendance({ from: "2026-10-01", to: "2026-10-31" }).path).toBe("attendance?from=2026-10-01&to=2026-10-31");
    expect(planAttendance({ from: "2026-10-01" }).path).toBe("attendance?from=2026-10-01");
    expect(planAttendance({ from: "", to: null }).path).toBe("attendance");
    expect(planAttendance({ from: "2026-10-01", person: "someone-else", school: "x", tenantId: "y" }).path).toBe("attendance?from=2026-10-01");
    expect(planAttendance({ from: "2026-01-01", to: "2026-04-03" }).path).toContain("to=2026-04-03"); // 93 days inclusive
    expect(() => planAttendance({ from: "2026-01-01", to: "2026-04-04" })).toThrow(/93 days or less/); // 94 days
    expect(() => planAttendance({ from: "2026-11-05", to: "2026-11-01" })).toThrow(/after the end date/);
    for (const bad of ["yesterday", "2026-02-31", "2026-13-01", "2026-1-1", "20261001", ["2026-10-01", "2026-10-02"], 20261001, {}]) {
      expect(() => planAttendance({ from: bad }), JSON.stringify(bad)).toThrow(/YYYY-MM-DD/);
    }
  });
});

describe("the rule (resolveMyHrStatus)", () => {
  const link = (row: { recent_no: boolean | null } | undefined) =>
    ({ query: async () => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 }) }) as unknown as Tx;
  const noQuery = { query: async () => { throw new Error("must not be asked"); } } as unknown as Tx;
  const member = (role: string, tenant_status = "active") => ({ role, tenant_status }) as never;

  it("staff roles are teacher, driver, staff and school_admin", () => {
    expect([...MY_HR_STAFF_ROLES].sort()).toEqual(["driver", "school_admin", "staff", "teacher"]);
  });

  it("not staff comes first and asks nothing: no membership, a parent, a student, a suspended school", async () => {
    for (const membership of [null, member("parent"), member("student"), member("teacher", "suspended"), member("org_admin"), member("super_admin")]) {
      expect(await resolveMyHrStatus(noQuery, { on: true, tenantId: "t", membership })).toBe("not_staff");
      expect(await resolveMyHrStatus(noQuery, { on: false, tenantId: "t", membership })).toBe("not_staff");
    }
  });

  it("then off, then not_linked, then not_enabled, otherwise available", async () => {
    for (const role of ["teacher", "driver", "staff", "school_admin"]) {
      expect(await resolveMyHrStatus(noQuery, { on: false, tenantId: "t", membership: member(role) })).toBe("off");
      expect(await resolveMyHrStatus(link(undefined), { on: true, tenantId: "t", membership: member(role) })).toBe("not_linked");
      expect(await resolveMyHrStatus(link({ recent_no: true }), { on: true, tenantId: "t", membership: member(role) })).toBe("not_enabled");
      expect(await resolveMyHrStatus(link({ recent_no: false }), { on: true, tenantId: "t", membership: member(role) })).toBe("available");
      expect(await resolveMyHrStatus(link({ recent_no: null }), { on: true, tenantId: "t", membership: member(role) })).toBe("available");
    }
  });
});

describe("HR's refusals: one table", () => {
  const ask = (status: number, body: unknown, options?: { notFound?: string }, retryAfterSeconds: number | null = null) =>
    refusalFromHr({ status, json: body, retryAfterSeconds }, options);
  const shape = (e: AppError) => [e.statusCode, e.code, e.message];

  it("not_linked and pending_hr are 'your record isn't ready yet', whatever the status", () => {
    expect(shape(ask(404, { error: { code: "not_linked", message: "HR-CANARY" } }))).toEqual([404, "not_linked", NOT_READY]);
    expect(shape(ask(200, { status: "pending_hr" }))).toEqual([404, "pending_hr", NOT_READY]);
    expect(shape(ask(409, { code: "pending_hr" }))).toEqual([404, "pending_hr", NOT_READY]);
    expect(NOT_READY).toBe("Your HR record isn't ready yet. Ask the school's HR administrator.");
  });

  it("another 404 is not_found, with the sentence the route chose", () => {
    expect(shape(ask(404, { error: { code: "not_found" } }))).toEqual([404, "not_found", "That isn't available in HR."]);
    expect(shape(ask(404, {}, { notFound: "That payslip isn't available." }))).toEqual([404, "not_found", "That payslip isn't available."]);
  });

  it("400 and 422 are validation errors in HR's own short sentence, else a plain one", () => {
    expect(shape(ask(400, { error: { code: "bad_request", message: "Choose a range of 93 days or less." } }))).toEqual([400, "validation_error", "Choose a range of 93 days or less."]);
    expect(shape(ask(422, { message: "Give a reason." }))).toEqual([400, "validation_error", "Give a reason."]);
    expect(ask(400, "<html>").message).toBe("HR couldn't take that. Check the details and try again.");
    expect(ask(400, { message: "x".repeat(301) }).message).toBe("HR couldn't take that. Check the details and try again.");
  });

  it("409 is a conflict", () => {
    expect(shape(ask(409, {}))).toEqual([409, "conflict", "That can't be done any more. Reload and try again."]);
    expect(ask(409, { error: { message: "Already done." } }).message).toBe("Already done.");
  });

  it("401, school_not_linked and invalid_token are 502 hr_not_connected", () => {
    for (const [status, body] of [[401, {}], [403, { error: { code: "school_not_linked" } }], [500, { code: "invalid_token" }], [200, { error: "school_not_linked" }]] as const) {
      expect(shape(ask(status, body))).toEqual([502, "hr_not_connected", HR_NOT_CONNECTED]);
    }
  });

  it("any other 403 is hr_forbidden", () => {
    expect(shape(ask(403, {}))).toEqual([403, "hr_forbidden", "Figbloom HR didn't allow that."]);
    expect(ask(403, { error: { message: "No access to payroll." } }).message).toBe("No access to payroll.");
  });

  it("429 keeps HR's wait", () => {
    const e = ask(429, {}, undefined, 42);
    expect([e.statusCode, e.code, e.retryAfterSeconds]).toEqual([429, "rate_limited", 42]);
    expect(ask(429, {}).retryAfterSeconds).toBe(60);
  });

  it("HR's own switch is 503 hr_off: the same answer on every route", () => {
    expect(shape(ask(503, { error: { code: "my_hr_off", message: "My HR isn't available yet." } }))).toEqual([503, "hr_off", HR_OFF]);
    expect(shape(ask(503, { error: { code: "my_hr_off" } }, { notFound: "anything" }))).toEqual([503, "hr_off", HR_OFF]);
  });

  it("everything else is 503 hr_unavailable, and HR's words are never used", () => {
    for (const status of [500, 502, 503, 504, 418, 302]) {
      const e = ask(status, { error: { message: "HR-CANARY-server-error-text" } });
      expect(shape(e)).toEqual([503, "hr_unavailable", HR_UNAVAILABLE]);
      expect(e.message).not.toContain("CANARY");
    }
    expect(shape(hrUnavailable())).toEqual([503, "hr_unavailable", HR_UNAVAILABLE]);
    expect(shape(hrBadAnswer())).toEqual([502, "hr_bad_answer", HR_UNAVAILABLE]);
  });

  it("reads HR's code and message in every shape HR uses", () => {
    expect(hrErrorCode({ error: { code: "a_b" } })).toBe("a_b");
    expect(hrErrorCode({ code: "c" })).toBe("c");
    expect(hrErrorCode({ status: "pending_hr" })).toBe("pending_hr");
    expect(hrErrorCode({ error: "not_found" })).toBe("not_found");
    expect(hrErrorCode({ error: "Not Found!" })).toBeNull();
    expect(hrErrorCode(null)).toBeNull();
    expect(hrMessage({ error: { message: "  hi " } })).toBe("hi");
    expect(hrMessage({ message: "yo" })).toBe("yo");
    expect(hrMessage([])).toBeNull();
  });
});

describe("the platform token client", () => {
  const config = { clientId: "id", clientSecret: "s3cret", tokenUrl: "https://auth.example/oauth2/token", apiUrl: "https://api.example", timeoutMs: 1000 };

  function tokenFetch(opts: { seconds?: number; status?: number } = {}) {
    const seen: { url: string; init: RequestInit }[] = [];
    let n = 0;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (opts.status) return json({ error: "invalid_client", error_description: "SECRET-CANARY" }, opts.status);
      n++;
      return json({ access_token: `tok-${n}`, expires_in: opts.seconds ?? 3600, token_type: "Bearer" });
    }) as unknown as typeof fetch;
    return { fetchFn, seen };
  }

  it("signs in with the client credentials and the schools scope", async () => {
    const { fetchFn, seen } = tokenFetch();
    expect(await new PlatformTokenClient(config, { fetch: fetchFn }).accessToken()).toBe("tok-1");
    const { url, init } = seen[0]!;
    expect(url).toBe(config.tokenUrl);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("id:s3cret").toString("base64")}`);
    expect(new URLSearchParams(String(init.body)).get("grant_type")).toBe("client_credentials");
    expect(new URLSearchParams(String(init.body)).get("scope")).toBe(PLATFORM_TOKEN_SCOPE);
    expect(init.redirect).toBe("error");
  });

  it("keeps the token until a minute before it expires, then fetches another", async () => {
    let now = 1_000_000;
    const { fetchFn, seen } = tokenFetch({ seconds: 3600 });
    const client = new PlatformTokenClient(config, { fetch: fetchFn, now: () => now });
    expect(await client.accessToken()).toBe("tok-1");
    now += 3600_000 - 61_000; // 61 s before it expires
    expect(await client.accessToken()).toBe("tok-1");
    expect(seen).toHaveLength(1);
    now += 2_000; // 59 s before: inside the margin
    expect(await client.accessToken()).toBe("tok-2");
    expect(seen).toHaveLength(2);
  });

  it("a missing or odd expires_in means an hour; a huge one is capped at a day", async () => {
    let now = 0;
    const fetchFn = (async () => json({ access_token: "t", expires_in: "soon" })) as unknown as typeof fetch;
    const c1 = new PlatformTokenClient(config, { fetch: fetchFn, now: () => now });
    await c1.accessToken();
    now = 3_539_000;
    expect(await c1.accessToken()).toBe("t");
    const calls: number[] = [];
    const big = (async () => { calls.push(1); return json({ access_token: `t${calls.length}`, expires_in: 10 ** 9 }); }) as unknown as typeof fetch;
    now = 0;
    const c2 = new PlatformTokenClient(config, { fetch: big, now: () => now });
    await c2.accessToken();
    now = 86_400_000 - 59_000;
    expect(await c2.accessToken()).toBe("t2");
  });

  it("a burst of callers shares one fetch", async () => {
    const { fetchFn, seen } = tokenFetch();
    const client = new PlatformTokenClient(config, { fetch: fetchFn });
    const tokens = await Promise.all(Array.from({ length: 20 }, () => client.accessToken()));
    expect(new Set(tokens)).toEqual(new Set(["tok-1"]));
    expect(seen).toHaveLength(1);
  });

  it("forgetToken drops the refused token only, so a newer one another caller fetched survives", async () => {
    const { fetchFn, seen } = tokenFetch();
    const client = new PlatformTokenClient(config, { fetch: fetchFn });
    const first = await client.accessToken();
    client.forgetToken("some-other-token");
    expect(await client.accessToken()).toBe(first);
    client.forgetToken(first);
    expect(await client.accessToken()).toBe("tok-2");
    expect(seen).toHaveLength(2);
  });

  it("a refused sign-in is a PlatformError with the status and a short code, and never the secret or the platform's words", async () => {
    const { fetchFn } = tokenFetch({ status: 400 });
    const err = await new PlatformTokenClient(config, { fetch: fetchFn }).accessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err).toMatchObject({ status: 400, code: "token_failed", message: "Could not get a platform token (400 invalid_client)." });
    expect(String((err as Error).message)).not.toMatch(/s3cret|CANARY/);
    expect((err as PlatformError).retryable).toBe(false);
  });

  it("an unreachable platform is status 0 and retryable; a bad answer is a PlatformError too", async () => {
    const down = (async () => { throw new TypeError("fetch failed: connection refused to https://auth.example SECRET-CANARY"); }) as unknown as typeof fetch;
    const err = await new PlatformTokenClient(config, { fetch: down }).accessToken().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 0, code: "unreachable" });
    expect((err as PlatformError).retryable).toBe(true);
    expect((err as Error).message).not.toContain("CANARY");
    const noToken = (async () => json({ hello: "world" })) as unknown as typeof fetch;
    await expect(new PlatformTokenClient(config, { fetch: noToken }).accessToken()).rejects.toMatchObject({ code: "token_failed", status: 200 });
  });

  it("call(): the platform's API with the same token, JSON in and out, one retry on 401", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    let tokens = 0;
    let reject = 1;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      if (url === config.tokenUrl) return json({ access_token: `tok-${++tokens}`, expires_in: 3600 });
      if (reject-- > 0) return json({ error: { code: "unauthorized", message: "Revoked" } }, 401);
      return json({ url: "https://hr.example/handoff?code=x" }, 201);
    }) as unknown as typeof fetch;
    const client = new PlatformTokenClient(config, { fetch: fetchFn });
    const out = await client.call<{ url: string }>("POST", "/handoffs", { target: "hr" });
    expect(out.url).toContain("handoff");
    const api = seen.filter((s) => s.url !== config.tokenUrl);
    expect(api.map((s) => [s.init.method, s.url])).toEqual([["POST", "https://api.example/handoffs"], ["POST", "https://api.example/handoffs"]]);
    expect((api[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
    expect((api[1]!.init.headers as Record<string, string>).authorization).toBe("Bearer tok-2");
    expect(api[1]!.init.body).toBe(JSON.stringify({ target: "hr" }));
    expect(api[1]!.init.redirect).toBe("error");
    expect(tokens).toBe(2);
  });

  it("call() throws PlatformError with the platform's own code and status; not_configured without PLATFORM_API_URL", async () => {
    const fetchFn = (async (url: string) =>
      url === config.tokenUrl ? json({ access_token: "t", expires_in: 3600 }) : json({ error: { code: "target_not_enabled", message: "Not on for this school" } }, 409)) as unknown as typeof fetch;
    const client = new PlatformTokenClient(config, { fetch: fetchFn });
    await expect(client.call("POST", "/handoffs", {})).rejects.toMatchObject({ status: 409, code: "target_not_enabled", message: "Not on for this school" });
    const plain = (async (url: string) => (url === config.tokenUrl ? json({ access_token: "t", expires_in: 3600 }) : new Response("nope", { status: 502 }))) as unknown as typeof fetch;
    await expect(new PlatformTokenClient(config, { fetch: plain }).call("GET", "/x")).rejects.toMatchObject({ status: 502, code: "http_502" });
    await expect(new PlatformTokenClient({ ...config, apiUrl: undefined }, { fetch: fetchFn }).call("GET", "/x")).rejects.toMatchObject({ code: "not_configured" });
  });
});

describe("the HR caller", () => {
  const tokenConfig = { clientId: "id", clientSecret: "s", tokenUrl: "https://auth.example/t", timeoutMs: 1000 };
  function setup(hr: (n: number, init: RequestInit) => Response | Promise<Response>) {
    const hrCalls: { url: string; init: RequestInit }[] = [];
    let tokens = 0;
    const fetchFn = (async (url: string, init: RequestInit) => {
      if (url === tokenConfig.tokenUrl) return json({ access_token: `tok-${++tokens}`, expires_in: 3600 });
      hrCalls.push({ url, init });
      return hr(hrCalls.length, init);
    }) as unknown as typeof fetch;
    return { hrCalls, fetchFn, client: new PlatformTokenClient(tokenConfig, { fetch: fetchFn }), tokens: () => tokens };
  }
  const headersOf = (c: { init: RequestInit }) => c.init.headers as Record<string, string>;

  it("sends the bearer token, the school and the person; no redirects", async () => {
    const { hrCalls, fetchFn, client } = setup(() => json({ status: "active" }));
    const answer = await callHr(client, "https://hr.example/my-hr/summary", { school: "school-1", person: "person-1" }, fetchFn);
    expect(answer).toMatchObject({ status: 200, json: { status: "active" }, tooLarge: false });
    expect(headersOf(hrCalls[0]!)).toMatchObject({ authorization: "Bearer tok-1", "x-figbloom-school": "school-1", "x-figbloom-person": "person-1", accept: "application/json" });
    expect(hrCalls[0]!.init.method).toBe("GET");
    expect(hrCalls[0]!.init.redirect).toBe("error");
    expect(hrCalls[0]!.init.body).toBeUndefined();
  });

  it("a 401 is retried once with a fresh token; a second 401 is returned", async () => {
    let s = setup((n) => json({ error: { code: "invalid_token" } }, n === 1 ? 401 : 200));
    expect((await callHr(s.client, "https://hr.example/x", { school: "a", person: "b" }, s.fetchFn)).status).toBe(200);
    expect(s.hrCalls.map((c) => headersOf(c).authorization)).toEqual(["Bearer tok-1", "Bearer tok-2"]);
    s = setup(() => json({ error: { code: "invalid_token" } }, 401));
    expect((await callHr(s.client, "https://hr.example/x", { school: "a", person: "b" }, s.fetchFn)).status).toBe(401);
    expect(s.hrCalls).toHaveLength(2);
    expect(s.tokens()).toBe(2);
  });

  it("a POST sends JSON; the person is optional", async () => {
    const { hrCalls, fetchFn, client } = setup(() => json({ ok: true }, 201));
    await callHr(client, "https://hr.example/x", { method: "POST", school: "a", body: { hello: "world" } }, fetchFn);
    expect(hrCalls[0]!.init.body).toBe('{"hello":"world"}');
    expect(headersOf(hrCalls[0]!)["content-type"]).toBe("application/json");
    expect(headersOf(hrCalls[0]!)["x-figbloom-person"]).toBeUndefined();
  });

  it("an answer that is not JSON, empty or too large is returned as such, not as an error", async () => {
    let s = setup(() => new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect(await callHr(s.client, "https://hr.example/x", { school: "a" }, s.fetchFn)).toMatchObject({ status: 200, json: undefined, tooLarge: false });
    s = setup(() => new Response("x".repeat(1024 * 1024 + 1), { status: 200 }));
    expect(await callHr(s.client, "https://hr.example/x", { school: "a" }, s.fetchFn)).toMatchObject({ json: undefined, tooLarge: true });
    s = setup(() => new Response("{}", { status: 200, headers: { "content-length": String(5 * 1024 * 1024) } }));
    expect((await callHr(s.client, "https://hr.example/x", { school: "a" }, s.fetchFn)).tooLarge).toBe(true);
  });

  it("reads HR's Retry-After as whole seconds from 1 to 300", async () => {
    for (const [header, want] of [["42", 42], ["0", 1], ["9999", 300], ["soon", null], ["1.5", null]] as const) {
      const s = setup(() => json({}, 429, { "retry-after": header }));
      expect((await callHr(s.client, "https://hr.example/x", { school: "a" }, s.fetchFn)).retryAfterSeconds, header).toBe(want);
    }
  });

  it("a network failure, a timeout and a caller who left are HrCallErrors with a reason and no words of HR's", async () => {
    const failing = setup(() => { throw new TypeError("fetch failed (HR-CANARY)"); });
    const err = await callHr(failing.client, "https://hr.example/x", { school: "a" }, failing.fetchFn).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HrCallError);
    expect(err).toMatchObject({ reason: "network" });
    expect((err as Error).message).not.toContain("CANARY");

    const slow = setup((_n, init) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const started = Date.now();
    await expect(callHr(slow.client, "https://hr.example/x", { school: "a", timeoutMs: 120 }, slow.fetchFn)).rejects.toMatchObject({ reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);

    const gone = new AbortController();
    const waiting = callHr(slow.client, "https://hr.example/x", { school: "a", timeoutMs: 5000, signal: gone.signal }, slow.fetchFn);
    setTimeout(() => gone.abort(), 50);
    await expect(waiting).rejects.toMatchObject({ reason: "aborted" });
  });

  it("the platform token failing is a PlatformError, and HR is not called", async () => {
    const hrCalls: string[] = [];
    const fetchFn = (async (url: string) => {
      if (url === tokenConfig.tokenUrl) return json({ error: "invalid_client" }, 400);
      hrCalls.push(url);
      return json({});
    }) as unknown as typeof fetch;
    await expect(callHr(new PlatformTokenClient(tokenConfig, { fetch: fetchFn }), "https://hr.example/x", { school: "a" }, fetchFn)).rejects.toBeInstanceOf(PlatformError);
    expect(hrCalls).toEqual([]);
  });
});
