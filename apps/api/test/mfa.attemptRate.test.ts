import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, MFA_ATTEMPT_RATE_DEFAULTS } from "../src/config.js";
import { computeTotpCode } from "../src/modules/auth/mfa.js";
import { mfaAttemptRatePolicy } from "../src/modules/auth/mfaPolicy.js";
import { createTestApp } from "./support.js";

/**
 * The two-step attempt limit (5 at once, then one a minute, per account) can be loosened for local and test runs
 * only, so a browser-test run that signs in as the same administrator many times is not starved. Staging and
 * production must keep the default or something tighter.
 */

const LOOPBACK = "postgresql://figbloom_app:replace-me@127.0.0.1:58322/figbloom_api";
const local = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({ DATABASE_URL: LOOPBACK, ...over });
const strict = (appEnv: "staging" | "production", over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  APP_ENV: appEnv,
  DATABASE_URL: "postgresql://figbloom_app:replace-me@db.internal.example:5432/figbloom_api?sslmode=verify-full",
  IDEMPOTENCY_FINGERPRINT_KEY: "k-FINGERPRINT-KEY-0123456789abcdef-0123",
  SESSION_MINT_HMAC_KEY: "k-SESSION-MINT-HMAC-0123456789abcdef-0123",
  MFA_ENCRYPTION_KEY: "k-MFA-ENCRYPTION-KEY-0123456789abcdef-0123",
  ...over,
});

describe("MFA attempt limit: configuration", () => {
  it("defaults to 5 attempts, then one a minute, and feeds the token bucket exactly that", () => {
    const c = loadConfig(local());
    expect(c).toMatchObject({ mfaAttemptRateCapacity: 5, mfaAttemptRateRefill: 1, mfaAttemptRateIntervalMs: 60_000 });
    expect(MFA_ATTEMPT_RATE_DEFAULTS).toEqual({ capacity: 5, refill: 1, intervalMs: 60_000 });
    expect(mfaAttemptRatePolicy(c)).toEqual({ authRateCapacity: 5, authRateRefill: 1, authRateIntervalMs: 60_000 });
  });

  it("is independent of the login limit: raising AUTH_RATE_* does not touch it", () => {
    const c = loadConfig(local({ AUTH_RATE_CAPACITY: "1000", AUTH_RATE_REFILL: "1000" }));
    expect(c.authRateCapacity).toBe(1000);
    expect(c.mfaAttemptRateCapacity).toBe(5);
    expect(c.mfaAttemptRateRefill).toBe(1);
  });

  it("local and test may loosen it", () => {
    for (const appEnv of [undefined, "local", "test"]) {
      const c = loadConfig(
        local({ ...(appEnv ? { APP_ENV: appEnv } : {}), MFA_ATTEMPT_RATE_CAPACITY: "1000", MFA_ATTEMPT_RATE_REFILL: "1000", MFA_ATTEMPT_RATE_INTERVAL_MS: "1000" }),
      );
      expect(mfaAttemptRatePolicy(c)).toEqual({ authRateCapacity: 1000, authRateRefill: 1000, authRateIntervalMs: 1000 });
    }
  });

  it.each([
    ["capacity 0 would refuse every attempt", { MFA_ATTEMPT_RATE_CAPACITY: "0" }],
    ["a fractional capacity", { MFA_ATTEMPT_RATE_CAPACITY: "0.5" }],
    ["a negative capacity", { MFA_ATTEMPT_RATE_CAPACITY: "-3" }],
    ["a capacity that is not a number", { MFA_ATTEMPT_RATE_CAPACITY: "lots" }],
    ["an absurd capacity", { MFA_ATTEMPT_RATE_CAPACITY: "100000000" }],
    ["refill 0 would never recover", { MFA_ATTEMPT_RATE_REFILL: "0" }],
    ["a fractional refill", { MFA_ATTEMPT_RATE_REFILL: "1.5" }],
    ["an interval too short to mean anything", { MFA_ATTEMPT_RATE_INTERVAL_MS: "5" }],
    ["an interval of more than an hour", { MFA_ATTEMPT_RATE_INTERVAL_MS: "99999999999" }],
  ] as const)("refuses a bad value even in local: %s", (_name, over) => {
    expect(() => loadConfig(local(over))).toThrow(/mfaAttemptRate/);
  });

  describe.each(["staging", "production"] as const)("%s", (appEnv) => {
    it("accepts the default and anything tighter", () => {
      expect(() => loadConfig(strict(appEnv))).not.toThrow();
      expect(() => loadConfig(strict(appEnv, { MFA_ATTEMPT_RATE_CAPACITY: "5", MFA_ATTEMPT_RATE_REFILL: "1", MFA_ATTEMPT_RATE_INTERVAL_MS: "60000" }))).not.toThrow();
      expect(() => loadConfig(strict(appEnv, { MFA_ATTEMPT_RATE_CAPACITY: "3" }))).not.toThrow();
      expect(() => loadConfig(strict(appEnv, { MFA_ATTEMPT_RATE_INTERVAL_MS: "120000" }))).not.toThrow(); // one every two minutes
      // the same rate written another way: 2 every 2 minutes is 1 a minute
      expect(() => loadConfig(strict(appEnv, { MFA_ATTEMPT_RATE_REFILL: "2", MFA_ATTEMPT_RATE_INTERVAL_MS: "120000" }))).not.toThrow();
    });

    it.each([
      ["a bigger burst", { MFA_ATTEMPT_RATE_CAPACITY: "6" }],
      ["the burst the browser tests use", { MFA_ATTEMPT_RATE_CAPACITY: "1000", MFA_ATTEMPT_RATE_REFILL: "1000" }],
      ["a faster refill", { MFA_ATTEMPT_RATE_REFILL: "2" }],
      ["a shorter refill interval", { MFA_ATTEMPT_RATE_INTERVAL_MS: "30000" }],
      ["a refill that only looks slower (3 every 2 minutes is faster than 1 a minute)", { MFA_ATTEMPT_RATE_REFILL: "3", MFA_ATTEMPT_RATE_INTERVAL_MS: "120000" }],
    ] as const)("refuses %s", (_name, over) => {
      expect(() => loadConfig(strict(appEnv, over))).toThrow(/MFA_ATTEMPT_RATE_\* may not be looser than the default/);
    });
  });
});

describe("MFA attempt limit: the API uses the configured numbers", () => {
  const PASSWORD = "correct-horse-battery";
  const CAPACITY = 8; // more than the default 5, so reaching it proves the setting is read
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  const saved: Record<string, string | undefined> = {};
  const email = `mfa-rate-${randomUUID()}@example.com`;

  const post = (token: string, url: string, payload?: unknown) =>
    ctx.app.inject({ method: "POST", url, headers: { authorization: `Bearer ${token}` }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const login = async () => {
    const r = await ctx.app.inject({ method: "POST", url: "/v1/auth/login/email", payload: { email, password: PASSWORD } });
    expect(r.statusCode, r.body).toBe(200);
    return r.json().token as string;
  };

  beforeAll(async () => {
    const env = {
      MFA_ENFORCEMENT_TEST: "enforce",
      MFA_ENCRYPTION_KEY: "k".repeat(40),
      MFA_ATTEMPT_RATE_CAPACITY: String(CAPACITY),
    };
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    ctx = await createTestApp();
    expect(ctx.config.mfaAttemptRateCapacity).toBe(CAPACITY);
    expect(ctx.config.mfaAttemptRateRefill).toBe(1);
    // A second administrator, copied from the fixture admin so the password is known.
    const id = randomUUID();
    await ctx.pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, status) SELECT $1, $3, password_hash, $4, 'active' FROM users WHERE id = $2`,
      [id, ctx.ids.adminA, email, "Rate Test"],
    );
    await ctx.pool.query(`INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1,$2,'school_admin','AD-7001')`, [id, ctx.ids.tenantA]);
  }, 180_000);

  beforeEach(async () => {
    await ctx.pool.query(`DELETE FROM auth_rate_buckets`); // throttle state is persistent; start clean
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("answers exactly the configured number of attempts, then throttles with Retry-After", async () => {
    const t = await login();
    const e = await post(t, "/v1/auth/mfa/totp/enroll");
    expect(e.statusCode, e.body).toBe(200);
    const { secret } = e.json() as { secret: string };
    const v = await post(t, "/v1/auth/mfa/totp/verify", { code: computeTotpCode(secret) });
    expect(v.statusCode, v.body).toBe(200); // attempt 1 of 8

    const t2 = await login();
    // Attempts 2 to 8 are wrong codes: each is answered (401), not throttled. With the default of 5 the 5th of
    // these would already be a 429.
    for (let attempt = 2; attempt <= CAPACITY; attempt++) {
      const r = await post(t2, "/v1/auth/mfa/challenge", { code: "000000" });
      expect(r.statusCode, `attempt ${attempt}`).toBe(401);
    }
    const throttled = await post(t2, "/v1/auth/mfa/challenge", { code: "000000" });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers["retry-after"]).toBeDefined();
  });
});
