import { readFileSync } from "node:fs";
import { LOCAL_SESSION_MINT_HMAC_KEY } from "../src/modules/auth/sessionProof.js";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadConfig,
  loadDotEnvForLocal,
  loadMigrationConfig,
  resolveAppEnvironment,
} from "../src/config.js";

const SECRET_PW = "p@ss-SECRET-DB-9981";
const SECRET_KEY = "k-SECRET-FINGERPRINT-KEY-0123456789abcdef";
const SECRET_MINT = "k-SECRET-SESSION-MINT-HMAC-0123456789abcdef";
const SECRET_MIG = "mig-SECRET-7731";

const loopback = `postgresql://figbloom_app:${SECRET_PW}@127.0.0.1:58322/figbloom_api`;
const remote = (q = "") => `postgresql://figbloom_app:${SECRET_PW}@db.internal.example:5432/figbloom_api${q}`;

const prod = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  APP_ENV: "production",
  DATABASE_URL: remote("?sslmode=verify-full"),
  IDEMPOTENCY_FINGERPRINT_KEY: SECRET_KEY,
  SESSION_MINT_HMAC_KEY: SECRET_MINT,
  ...over,
});

/** FIG-1618: per-entrypoint typed configuration that fails fast and never echoes a secret. */
describe("environment mode and production refusals", () => {
  it("APP_ENV is explicit: unset is local, NODE_ENV=production without APP_ENV is refused, junk is refused", () => {
    expect(resolveAppEnvironment({})).toBe("local");
    expect(resolveAppEnvironment({ APP_ENV: "staging" })).toBe("staging");
    expect(() => resolveAppEnvironment({ NODE_ENV: "production" })).toThrow(/APP_ENV is required/);
    expect(() => resolveAppEnvironment({ APP_ENV: "prod" })).toThrow(/APP_ENV must be one of/);
    expect(() => loadConfig({ DATABASE_URL: loopback, NODE_ENV: "production" })).toThrow(/APP_ENV is required/);
  });

  it("local/test keep their conveniences: loopback or remote without TLS flags, no fingerprint key", () => {
    expect(() => loadConfig({ DATABASE_URL: loopback })).not.toThrow();
    expect(() => loadConfig({ APP_ENV: "test", DATABASE_URL: remote() })).not.toThrow();
  });

  it.each([
    ["missing database url", prod({ DATABASE_URL: undefined }), /databaseUrl/],
    ["missing fingerprint key", prod({ IDEMPOTENCY_FINGERPRINT_KEY: undefined }), /IDEMPOTENCY_FINGERPRINT_KEY is required/],
    ["short fingerprint key", prod({ IDEMPOTENCY_FINGERPRINT_KEY: "short" }), /idempotencyFingerprintKey/],
    ["missing session mint HMAC key", prod({ SESSION_MINT_HMAC_KEY: undefined }), /SESSION_MINT_HMAC_KEY is required/],
    ["short session mint HMAC key", prod({ SESSION_MINT_HMAC_KEY: "short" }), /sessionMintHmacKey/],
    ["documented local development key", prod({ SESSION_MINT_HMAC_KEY: LOCAL_SESSION_MINT_HMAC_KEY }), /development key/],
    ["remote database without verified TLS", prod({ DATABASE_URL: remote() }), /DATABASE_URL must set sslmode=verify-full/],
    ["sslmode=require is not verification", prod({ DATABASE_URL: remote("?sslmode=require") }), /DATABASE_URL must set sslmode=verify-full/],
    ["sslmode=disable", prod({ DATABASE_URL: remote("?sslmode=disable") }), /DATABASE_URL must set sslmode=verify-full/],
    ["migrator credentials in the API process", prod({ MIGRATION_DATABASE_URL: `postgresql://postgres:${SECRET_MIG}@h/db` }), /MIGRATION_DATABASE_URL must not be set/],
    ["runtime URL not the runtime role", prod({ DATABASE_URL: `postgresql://postgres:${SECRET_PW}@db.internal.example/x?sslmode=verify-full` }), /must equal RUNTIME_ROLE/],
    ["wildcard CORS", prod({ CORS_ALLOWED_ORIGINS: "*" }), /CORS_ALLOWED_ORIGINS/],
    ["trust proxy without CIDRs", prod({ API_TRUST_PROXY_HOPS: "1" }), /API_TRUST_PROXY_CIDRS/],
    ["pool above the cap", prod({ POOL_MAX: "21" }), /POOL_MAX/],
    ["out-of-range session interval", prod({ SESSION_LAST_SEEN_INTERVAL_SECONDS: "99999" }), /sessionLastSeenIntervalSeconds/],
  ] as const)("production refuses: %s", (_name, env, expected) => {
    expect(() => loadConfig(env)).toThrow(expected);
  });

  it("a correct production configuration is accepted", () => {
    const c = loadConfig(prod());
    expect(c.appEnv).toBe("production");
    expect(c.idempotencyTtlSeconds).toBe(86_400);
  });

  it("the migrator also refuses unverified TLS to a remote database outside local/test", () => {
    const base = { APP_ENV: "production" };
    expect(() =>
      loadMigrationConfig({ ...base, MIGRATION_DATABASE_URL: `postgresql://postgres:${SECRET_MIG}@db.internal.example/x` }),
    ).toThrow(/MIGRATION_DATABASE_URL must set sslmode=verify-full/);
    expect(() =>
      loadMigrationConfig({ ...base, MIGRATION_DATABASE_URL: `postgresql://postgres:${SECRET_MIG}@db.internal.example/x?sslmode=verify-full` }),
    ).not.toThrow();
  });

  it("thrown configuration errors never contain a secret value (redaction)", () => {
    const scenarios: NodeJS.ProcessEnv[] = [
      prod({ DATABASE_URL: remote() }),
      prod({ IDEMPOTENCY_FINGERPRINT_KEY: undefined }),
      prod({ IDEMPOTENCY_FINGERPRINT_KEY: "short" }),
      prod({ MIGRATION_DATABASE_URL: `postgresql://postgres:${SECRET_MIG}@h/db` }),
      prod({ DATABASE_URL: `postgresql://postgres:${SECRET_PW}@db.internal.example/x?sslmode=verify-full` }),
      prod({ POOL_MAX: "99" }),
      prod({ CORS_ALLOWED_ORIGINS: "*" }),
      { DATABASE_URL: `postgresql://:${SECRET_PW}@127.0.0.1/x`, IDEMPOTENCY_FINGERPRINT_KEY: SECRET_KEY },
      { DATABASE_URL: `not a url ${SECRET_PW}`, IDEMPOTENCY_FINGERPRINT_KEY: SECRET_KEY },
    ];
    let thrown = 0;
    for (const env of scenarios) {
      try {
        loadConfig(env);
      } catch (e) {
        thrown++;
        const msg = (e as Error).message;
        for (const s of [SECRET_PW, SECRET_KEY, SECRET_MIG, "db.internal.example"]) {
          expect(msg, msg).not.toContain(s);
        }
      }
    }
    expect(thrown).toBe(scenarios.length);
    for (const url of [`postgresql://postgres:${SECRET_MIG}@db.internal.example/x`, `garbage ${SECRET_MIG}`]) {
      try {
        loadMigrationConfig({ APP_ENV: "production", MIGRATION_DATABASE_URL: url });
      } catch (e) {
        expect((e as Error).message).not.toContain(SECRET_MIG);
      }
    }
  });

  it(".env is read only by an explicit local call: never at import, never in staging/production", () => {
    const src = readFileSync(join(process.cwd(), "src", "config.ts"), "utf8");
    expect(src).not.toMatch(/^loadDotEnv\(\);/m);
    expect(loadDotEnvForLocal({ APP_ENV: "production" })).toBe(false);
    expect(loadDotEnvForLocal({ APP_ENV: "staging" })).toBe(false);
    // Only the entrypoints call it.
    const idx = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
    const mig = readFileSync(join(process.cwd(), "src", "db", "migrate.ts"), "utf8");
    expect(idx).toMatch(/loadDotEnvForLocal\(\)/);
    expect(mig).toMatch(/loadDotEnvForLocal\(\)/);
  });

  it("api and migrate read different variables: DATABASE_URL never configures the migrator and vice versa", () => {
    expect(() => loadMigrationConfig({ DATABASE_URL: loopback })).toThrow(/MIGRATION_DATABASE_URL is required/);
    expect(() => loadConfig({ MIGRATION_DATABASE_URL: "postgresql://postgres:x@127.0.0.1/db" })).toThrow(/databaseUrl/);
  });
});
