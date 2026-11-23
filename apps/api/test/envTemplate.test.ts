import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, loadMigrationConfig } from "../src/config.js";

/** F-C8: the tracked template must keep the two connections distinct and secret-free. */
describe("env.example", () => {
  const text = readFileSync(join(process.cwd(), "env.example"), "utf8");
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) env[t.slice(0, eq)] = t.slice(eq + 1);
  }

  it("declares DATABASE_URL (runtime role) and MIGRATION_DATABASE_URL (migrator) as different users", () => {
    expect(env.DATABASE_URL).toBeTruthy();
    expect(env.MIGRATION_DATABASE_URL).toBeTruthy();
    const runtimeUser = new URL(env.DATABASE_URL!).username;
    const migratorUser = new URL(env.MIGRATION_DATABASE_URL!).username;
    expect(runtimeUser).toBe(env.RUNTIME_ROLE ?? "figbloom_app");
    expect(migratorUser).not.toBe(runtimeUser);
  });

  it("is accepted by both config loaders as written (each reads only its own variable)", () => {
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => loadMigrationConfig(env as NodeJS.ProcessEnv)).not.toThrow();
    // The migrator never falls back to the runtime URL.
    expect(() => loadMigrationConfig({ DATABASE_URL: env.DATABASE_URL! })).toThrow(
      /MIGRATION_DATABASE_URL is required/,
    );
  });

  it("holds no real secret: only the replace-me placeholder or the well-known local default", () => {
    expect(new URL(env.DATABASE_URL!).password).toBe("replace-me");
    expect(["postgres"]).toContain(new URL(env.MIGRATION_DATABASE_URL!).password);
    expect(env.MIGRATION_DATABASE_URL).toMatch(/@(127\.0\.0\.1|localhost):/);
  });
});
