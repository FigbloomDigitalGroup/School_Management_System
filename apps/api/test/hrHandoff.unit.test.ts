import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { HandoffGateway, handoffSetup, realEmail, TARGET_REFUSALS } from "../src/modules/hr/handoff.js";

/**
 * The HR & Payroll hand-off (docs/HR-HANDOFF.md, H1) without a database: settings, the e-mail rule, and the gateway's reading
 * of the platform's answers through a stub fetch. The HTTP behaviour is in hrHandoff.test.ts.
 */

const BASE = {
  DATABASE_URL: "postgresql://figbloom_app:x@127.0.0.1:59999/figbloom_api",
  APP_ENV: "test",
  PLATFORM_HANDOFF_ENABLED: "true",
  PLATFORM_CLIENT_ID: "id",
  PLATFORM_CLIENT_SECRET: "secret-not-real",
  PLATFORM_TOKEN_URL: "https://auth.platform.example/oauth2/token",
  PLATFORM_API_URL: "https://api.platform.example/",
};
const config = (env: Record<string, string | undefined> = {}) => loadConfig({ ...BASE, ...env } as NodeJS.ProcessEnv);

/** A stub platform: the token endpoint and one answer for the platform's API. */
function stub(answer: { status: number; body: string } | (() => never)) {
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.endsWith("/oauth2/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    if (typeof answer === "function") answer();
    const a = answer as { status: number; body: string };
    return new Response(a.body, { status: a.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls, fetchFn };
}
const who = { school: "11111111-1111-4111-8111-111111111111", person: { external_id: "u", name: "N", email: null, role: "teacher" } };

describe("hand-off settings", () => {
  it("unset is off; the switch needs the four platform settings; the names of missing ones are given, never values", () => {
    expect(config({ PLATFORM_HANDOFF_ENABLED: undefined }).platformHandoffEnabled).toBe(false);
    expect(handoffSetup(config({ PLATFORM_HANDOFF_ENABLED: undefined }))).toEqual({ state: "off", missing: [] });
    expect(handoffSetup(config({ PLATFORM_HANDOFF_ENABLED: "TRUE" }))).toEqual({ state: "on", missing: [] });
    expect(handoffSetup(config({ PLATFORM_HANDOFF_ENABLED: "1" })).state).toBe("off");
    expect(handoffSetup(config({ PLATFORM_API_URL: undefined, PLATFORM_CLIENT_SECRET: undefined }))).toEqual({
      state: "incomplete",
      missing: ["PLATFORM_CLIENT_SECRET", "PLATFORM_API_URL"],
    });
    expect(new HandoffGateway(config({ PLATFORM_TOKEN_URL: undefined })).on).toBe(false);
    expect(new HandoffGateway(config()).on).toBe(true);
    // My HR's own settings play no part
    expect(handoffSetup(config({ MY_HR_ENABLED: "true", HR_MY_HR_URL: "https://hr.example/api" })).state).toBe("on");
  });

  it("an address that is set but not https stops the start, as for My HR", () => {
    expect(() => config({ PLATFORM_API_URL: "http://api.platform.example" })).toThrow(/PLATFORM_API_URL/);
  });
});

describe("realEmail (open-hr's rule)", () => {
  it("trims and lower-cases a real address, and drops a synthetic or malformed one", () => {
    expect(realEmail("  Mary@School.CO.KE ")).toBe("mary@school.co.ke");
    for (const bad of [null, undefined, "", "no-at-sign", "a@b", "x@login.school.figbloom.internal", "x@kijaniridge-demo.invalid", "a b@c.d"]) {
      expect(realEmail(bad as string | null | undefined), String(bad)).toBeNull();
    }
  });
});

describe("the gateway reads the platform's answers", () => {
  it("201 with an https link: the link (normalised) and its expiry; the platform is asked once, on its own API", async () => {
    const { calls, fetchFn } = stub({ status: 201, body: JSON.stringify({ url: "https://hr.example/handoff?code=abc", expires_at: "2026-11-25T10:01:00Z" }) });
    const result = await new HandoffGateway(config(), { fetch: fetchFn }).open(who);
    expect(result).toEqual({ ok: true, url: "https://hr.example/handoff?code=abc", expiresAt: "2026-11-25T10:01:00Z" });
    expect(calls).toEqual(["POST https://auth.platform.example/oauth2/token", "POST https://api.platform.example/handoffs"]);
  });

  it("an expiry that is missing or odd is null; anything but an https link is a bad answer", async () => {
    const noExpiry = await new HandoffGateway(config(), { fetch: stub({ status: 201, body: '{"url":"https://hr.example/x"}' }).fetchFn }).open(who);
    expect(noExpiry).toMatchObject({ ok: true, expiresAt: null });
    for (const body of ['{"url":"http://hr.example/x"}', '{"url":"ftp://hr.example/x"}', '{"url":"data:text/html,x"}', '{"url":5}', `{"url":"https://hr.example/${"x".repeat(5000)}"}`, "{}", "null", "oops"]) {
      const result = await new HandoffGateway(config(), { fetch: stub({ status: 201, body }).fetchFn }).open(who);
      expect(result.ok, body.slice(0, 40)).toBe(false);
      if (!result.ok) expect(result.error).toMatchObject({ statusCode: 502, code: "hr_bad_answer" });
    }
  });

  it("maps the platform's refusals as open-hr does", async () => {
    const answer = async (status: number, code?: string) =>
      new HandoffGateway(config(), { fetch: stub({ status, body: JSON.stringify(code ? { error: { code, message: "x" } } : {}) }).fetchFn }).open(who);
    for (const code of Object.keys(TARGET_REFUSALS)) {
      expect(await answer(409, code)).toMatchObject({ ok: false, recordNo: code, error: { statusCode: 409, code } });
    }
    expect(await answer(409, "something_else")).toMatchObject({ ok: false, recordNo: null, error: { statusCode: 503, code: "hr_unavailable" } });
    expect(await answer(404)).toMatchObject({ ok: false, recordNo: null, error: { statusCode: 409, code: "school_not_linked" } });
    expect(await answer(429)).toMatchObject({ ok: false, recordNo: null, error: { statusCode: 429, code: "rate_limited" } });
    for (const status of [400, 403, 500, 502, 503]) {
      expect(await answer(status), String(status)).toMatchObject({ ok: false, recordNo: null, error: { statusCode: 503, code: "hr_unavailable" } });
    }
    const unreachable = await new HandoffGateway(config(), { fetch: stub(() => { throw new TypeError("fetch failed"); }).fetchFn }).open(who);
    expect(unreachable).toMatchObject({ ok: false, error: { statusCode: 503, code: "hr_unavailable" } });
  });

  it("the connection: unknown without a platform id or when the check fails; kept a minute, a failure only 15 seconds", async () => {
    let now = 1_000_000;
    let module: { status: number; body: string } = { status: 200, body: JSON.stringify({ module_status: "active", cache_seconds: 600 }) };
    let link: { status: number; body: string } = { status: 200, body: "{}" };
    const calls: string[] = [];
    const fetchFn = (async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/oauth2/token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      const a = url.endsWith("/modules/hr") ? module : link;
      return new Response(a.body, { status: a.status });
    }) as typeof fetch;
    const gw = new HandoffGateway(config(), { fetch: fetchFn, now: () => now });
    const t = "22222222-2222-4222-8222-222222222222";
    expect(await gw.connection(t, { link: null, requestedAt: null })).toBe("not_connected");
    expect(await gw.connection(t, { link: { platformTenantId: null }, requestedAt: null })).toBe("unknown");
    expect(calls).toEqual([]);
    const linked = { link: { platformTenantId: "p/1" }, requestedAt: null };
    expect(await gw.connection(t, linked)).toBe("connected");
    expect(calls.filter((c) => !c.endsWith("/oauth2/token"))).toEqual(["https://api.platform.example/tenants/p%2F1/modules/hr", "https://api.platform.example/tenants/p%2F1/links/hr"]);
    link = { status: 404, body: '{"error":{"code":"not_linked"}}' };
    now += 59_000;
    expect(await gw.connection(t, linked)).toBe("connected"); // still kept (at most 60 s, though the platform said 600)
    now += 2_000;
    expect(await gw.connection(t, linked)).toBe("setting_up");
    gw.forget(t);
    module = { status: 500, body: "" };
    expect(await gw.connection(t, linked)).toBe("unknown");
    module = { status: 200, body: JSON.stringify({ module_status: "suspended" }) };
    now += 14_000;
    expect(await gw.connection(t, linked)).toBe("unknown");
    now += 2_000;
    expect(await gw.connection(t, linked)).toBe("not_connected");
  });
});
