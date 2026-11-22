import { describe, expect, it } from "vitest";
import { loadConfig, loadMigrationConfig, POOL_MAX_CAP } from "../src/config.js";

const base = {
  DATABASE_URL: "postgresql://figbloom_app:local@127.0.0.1:58322/figbloom_api",
  API_TRUST_PROXY_HOPS: "0",
};

describe("runtime and migration config", () => {
  it("refuses a pool max above the safety cap", () => {
    expect(() => loadConfig({ ...base, POOL_MAX: String(POOL_MAX_CAP + 1) })).toThrow(/POOL_MAX/);
  });

  it("refuses DATABASE_URL when the username is not the runtime role", () => {
    expect(() =>
      loadConfig({
        ...base,
        DATABASE_URL: "postgresql://postgres:local@127.0.0.1:58322/figbloom_api",
      }),
    ).toThrow(/DATABASE_URL user \(postgres\) must equal RUNTIME_ROLE/);
    expect(() =>
      loadConfig({
        ...base,
        DATABASE_URL: "postgresql://figbloom_app:local@127.0.0.1:58322/figbloom_api",
        RUNTIME_ROLE: "other_runtime",
      }),
    ).toThrow(/must equal RUNTIME_ROLE/);
  });

  it("requires MIGRATION_DATABASE_URL and refuses the runtime role and a transaction pooler", () => {
    expect(() => loadMigrationConfig({})).toThrow(/MIGRATION_DATABASE_URL/);
    expect(() =>
      loadMigrationConfig({
        MIGRATION_DATABASE_URL: "postgresql://figbloom_app:local@127.0.0.1:58322/figbloom_api",
      }),
    ).toThrow(/runtime role/);
    expect(() =>
      loadMigrationConfig({
        MIGRATION_DATABASE_URL: "postgresql://postgres:local@127.0.0.1:58322/figbloom_api?pgbouncer=true",
      }),
    ).toThrow(/pooler/);
    const ok = loadMigrationConfig({
      MIGRATION_DATABASE_URL: "postgresql://postgres:local@127.0.0.1:58322/figbloom_api",
      MIGRATION_LOCK_TIMEOUT_MS: "4000",
    });
    expect(ok.migrationLockTimeoutMs).toBe(4000);
    expect(ok.migrationDatabaseUrl).not.toContain("figbloom_app");
  });
});
