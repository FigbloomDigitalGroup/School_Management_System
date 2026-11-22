import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.js";
import { loginEmailString, uuidString } from "../src/http/schemas.js";
import {
  EMAIL_ACCEPT,
  EMAIL_REJECT,
  UUID_ACCEPT,
  UUID_REJECT,
} from "./support/validationCorpus.js";

/**
 * Stage Z pinned corpus (DEC-02, DEC-03). The expected results live in
 * test/support/validationCorpus.ts and were recorded against Zod 3.25.76
 * before the upgrade. They are the contract; the installed Zod version does not
 * get to redefine them.
 */
describe("validation corpus: identifiers", () => {
  it.each(UUID_ACCEPT)("accepts %s", (v) => {
    expect(uuidString.safeParse(v).success).toBe(true);
  });
  it.each(UUID_REJECT)("rejects %j", (v) => {
    expect(uuidString.safeParse(v).success).toBe(false);
  });

  it("NC-Z1 negative control: Zod's RFC-strict uuid() would narrow the contract, and the corpus detects it", () => {
    const strict = z.string().uuid();
    const narrowed = UUID_ACCEPT.filter((v) => !strict.safeParse(v).success);
    // If this ever becomes empty, the corpus no longer distinguishes guid() from uuid().
    expect(narrowed.length).toBeGreaterThanOrEqual(4);
    expect(narrowed).toContain("11111111-1111-1111-1111-111111111111");
  });
});

describe("validation corpus: sign-in e-mail", () => {
  it.each(EMAIL_ACCEPT)("accepts %s", (v) => {
    expect(loginEmailString.safeParse(v).success).toBe(true);
  });
  it.each(EMAIL_REJECT)("rejects %j", (v) => {
    expect(loginEmailString.safeParse(v).success).toBe(false);
  });
  it("enforces the 254 character bound", () => {
    const at254 = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;
    expect(at254.length).toBe(254);
    expect(loginEmailString.safeParse(at254).success).toBe(true);
    expect(loginEmailString.safeParse(at254 + "e").success).toBe(false);
  });
});

describe("validation corpus: strict objects and configuration", () => {
  it("a strict object rejects unknown keys and accepts the declared ones", () => {
    const s = z.strictObject({ a: uuidString });
    expect(s.safeParse({ a: UUID_ACCEPT[0] }).success).toBe(true);
    expect(s.safeParse({ a: UUID_ACCEPT[0], extra: 1 }).success).toBe(false);
  });

  const base = {
    DATABASE_URL: "postgresql://figbloom_app:local@127.0.0.1:58322/figbloom_api",
    API_TRUST_PROXY_HOPS: "0",
  };

  it("configuration defaults and coercion are unchanged", () => {
    const c = loadConfig({ ...base });
    expect(c).toMatchObject({
      host: "127.0.0.1",
      port: 4100,
      sessionTtlSeconds: 28_800,
      authRateCapacity: 5,
      authRateRefill: 2,
      authRateIntervalMs: 5_000,
      runtimeRole: "figbloom_app",
      poolMax: 10,
      poolAcquireTimeoutMs: 2_000,
      statementTimeoutMs: 15_000,
      lockTimeoutMs: 5_000,
      idleInTransactionSessionTimeoutMs: 15_000,
      applicationName: "figbloom-api",
      trustProxyHops: 0,
      trustProxyCidrs: [],
    });
    expect(loadConfig({ ...base, API_PORT: "4200", POOL_MAX: "7" })).toMatchObject({ port: 4200, poolMax: 7 });
  });

  it.each([
    ["API_PORT", "abc", /port/],
    ["API_PORT", "", /port/],
    ["API_PORT", "-1", /port/],
    ["API_PORT", "1.5", /port/],
    ["POOL_MAX", "0", /poolMax/],
    ["POOL_ACQUIRE_TIMEOUT_MS", "30001", /poolAcquireTimeoutMs/],
    ["STATEMENT_TIMEOUT_MS", "120001", /statementTimeoutMs/],
    ["SESSION_TTL_SECONDS", "x", /sessionTtlSeconds/],
    ["API_TRUST_PROXY_HOPS", "33", /trustProxyHops/],
  ] as const)("configuration refuses %s=%j and names only the field", (key, value, field) => {
    let message = "";
    try {
      loadConfig({ ...base, [key]: value });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(field);
    expect(message).toMatch(/^Invalid API config:/);
    expect(message).not.toContain(value === "" ? "\u0000" : `"${value}"`); // values are not echoed
  });

  it("a missing DATABASE_URL is refused", () => {
    expect(() => loadConfig({})).toThrow(/databaseUrl/);
  });
});
