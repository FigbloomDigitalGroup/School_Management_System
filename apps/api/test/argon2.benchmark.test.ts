import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { ARGON2_PARAMS } from "../src/modules/identity/password.js";

/**
 * Residual closure workstream 7: the deployment-hardware benchmark is reproducible and safe. This smoke run proves the script works with
 * the configured parameters, reports the environment, and never emits a password or a hash. Its numbers are NOT asserted (hardware).
 */
describe("argon2 benchmark script", () => {
  it("runs, reports the configured parameters and environment, and leaks no hash or password", () => {
    const r = spawnSync("npx", ["tsx", "scripts/argon2-benchmark.mts", "--iterations", "5", "--concurrency", "1,2"], { encoding: "utf8", shell: true, timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as { environment: { configured: typeof ARGON2_PARAMS; logicalCpus: number; node: string }; sequential: { hash: { p50: number }; verifyCorrectPassword: { p95: number } }; concurrency: { concurrentVerifications: number; throughputPerSecond: number }[] };
    expect(out.environment.configured).toEqual(ARGON2_PARAMS);
    expect(out.environment.logicalCpus).toBeGreaterThan(0);
    expect(out.sequential.hash.p50).toBeGreaterThan(0);
    expect(out.sequential.verifyCorrectPassword.p95).toBeGreaterThan(0);
    expect(out.concurrency.map((c) => c.concurrentVerifications)).toEqual([1, 2]);
    expect(r.stdout).not.toMatch(/\$argon2id\$|scrypt\$/);
  }, 150_000);
});
