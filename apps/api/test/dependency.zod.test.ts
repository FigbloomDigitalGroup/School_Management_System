import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * GHSA-mrhx-c7xc-m3w5: Zod below 4.6.6 can exhaust memory validating oversized
 * constrained collections. The fix is the package version, not request-size limits.
 * This test fails if any copy of Zod below the fixed version is installed, locked
 * or permitted by the declared range, so a second old copy cannot hide.
 */
export const ZOD_FIXED_IN = "4.6.6";

export function parseVersion(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
  if (!m) throw new Error(`unparseable version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function versionAtLeast(version: string, floor: string): boolean {
  const a = parseVersion(version);
  const b = parseVersion(floor);
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return true;
}

/** Pure check over a root package-lock.json object: every zod entry must be fixed. */
export function lockfileZodVersions(lock: {
  packages?: Record<string, { version?: string }>;
}): Array<{ path: string; version: string }> {
  const out: Array<{ path: string; version: string }> = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === "node_modules/zod" || path.endsWith("/node_modules/zod")) {
      out.push({ path, version: entry.version ?? "" });
    }
  }
  return out;
}

export function zodIsRemediated(versions: ReadonlyArray<{ version: string }>): boolean {
  return versions.length > 0 && versions.every((v) => versionAtLeast(v.version, ZOD_FIXED_IN));
}

describe("zod advisory GHSA-mrhx-c7xc-m3w5", () => {
  const apiRoot = process.cwd();
  const repoRoot = resolve(apiRoot, "..", "..");

  it("version helpers: the vulnerable and fixed lines are told apart", () => {
    expect(versionAtLeast("3.25.76", ZOD_FIXED_IN)).toBe(false);
    expect(versionAtLeast("4.6.5", ZOD_FIXED_IN)).toBe(false);
    expect(versionAtLeast("4.6.6", ZOD_FIXED_IN)).toBe(true);
    expect(versionAtLeast("4.6.7", ZOD_FIXED_IN)).toBe(true);
    expect(versionAtLeast("4.10.0", ZOD_FIXED_IN)).toBe(true);
    expect(versionAtLeast("5.0.0", ZOD_FIXED_IN)).toBe(true);
  });

  it("NC-Z2 negative control: the pre-upgrade state is reported as NOT remediated", () => {
    expect(zodIsRemediated([{ version: "3.25.76" }])).toBe(false);
    // A second, older copy hidden beside a fixed one must still fail.
    expect(zodIsRemediated([{ version: "4.6.7" }, { version: "3.25.76" }])).toBe(false);
    const oldLock = {
      packages: {
        "": {},
        "node_modules/zod": { version: "3.25.76" },
        "node_modules/x/node_modules/zod": { version: "4.6.7" },
      },
    };
    expect(zodIsRemediated(lockfileZodVersions(oldLock))).toBe(false);
    expect(zodIsRemediated([])).toBe(false); // absence of evidence is not remediation
  });

  it("the installed zod is a fixed version", () => {
    const req = createRequire(join(apiRoot, "package.json"));
    const pkg = JSON.parse(readFileSync(req.resolve("zod/package.json"), "utf8")) as { version: string };
    expect(zodIsRemediated([{ version: pkg.version }])).toBe(true);
  });

  it("every zod entry in the root package-lock.json is a fixed version", () => {
    const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));
    const found = lockfileZodVersions(lock);
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((f) => !versionAtLeast(f.version, ZOD_FIXED_IN))).toEqual([]);
  });

  it("the declared range cannot resolve below the fixed version", () => {
    const pkg = JSON.parse(readFileSync(join(apiRoot, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const declared = pkg.dependencies.zod!;
    expect(declared).toMatch(/^\^?\d+\.\d+\.\d+$/);
    expect(versionAtLeast(declared.replace(/^\^/, ""), ZOD_FIXED_IN)).toBe(true);
  });

  it("no other workspace consumes zod (single consumer, so one fix covers the tree)", () => {
    const root = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8")) as {
      packages: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
    };
    const consumers = Object.entries(root.packages)
      .filter(([, p]) => p.dependencies?.zod || p.devDependencies?.zod)
      .map(([k]) => k);
    expect(consumers).toEqual(["apps/api"]);
  });
});
