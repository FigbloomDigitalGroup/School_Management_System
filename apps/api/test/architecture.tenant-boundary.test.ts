import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const TENANT_ROUTE_FILES = [
  "http/routes/learners.ts",
  "http/routes/guardians.ts",
  "http/routes/rbac.ts",
  "http/routes/resources.ts",
  "http/routes/tenancy.ts",
] as const;

const BYPASS_RE = /\bauthz_mode\b|\bbypass\b.*\bowner\b|set_config\(\s*['"]app\.authz_mode/i;
const WITH_TENANT_REQUEST = /withTenantRequest\s*\(/;
const WITH_TENANT_TX = /withTenantTransaction\s*\(/;

function listTs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) walk(full);
      else if (name.name.endsWith(".ts")) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Routes that touch tenant business data must use withTenantRequest. */
export function tenantRoutesMissingPrimitive(srcRoot: string): string[] {
  const missing: string[] = [];
  for (const rel of TENANT_ROUTE_FILES) {
    const text = readFileSync(join(srcRoot, rel), "utf8");
    if (!WITH_TENANT_REQUEST.test(text)) missing.push(rel);
  }
  return missing;
}

/** Application source must not reintroduce an authz bypass/owner mode. */
export function findBypassModeReferences(srcRoot: string): string[] {
  const hits: string[] = [];
  for (const file of listTs(srcRoot)) {
    const rel = relative(srcRoot, file).split("\\").join("/");
    if (rel.startsWith("db/migrate")) continue;
    const text = readFileSync(file, "utf8");
    // Comments mentioning historical bypass removal are allowed; executable references are not.
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      if (BYPASS_RE.test(line) && /authz_mode|set_config/.test(line)) {
        hits.push(`${rel}:${i + 1}`);
      }
    }
  }
  return hits;
}

describe("architecture: tenant boundary", () => {
  const src = join(process.cwd(), "src");

  it("requires withTenantRequest on every tenant business route", () => {
    expect(tenantRoutesMissingPrimitive(src)).toEqual([]);
  });

  it("NC-2 negative control: a route file without withTenantRequest is detected", () => {
    const dir = mkdtempSync(join(tmpdir(), "figbloom-tenant-route-"));
    try {
      writeFileSync(
        join(dir, "learners.ts"),
        `export function register() { return pool.query("select 1"); }\n`,
        "utf8",
      );
      const text = readFileSync(join(dir, "learners.ts"), "utf8");
      expect(WITH_TENANT_REQUEST.test(text)).toBe(false);
      expect(WITH_TENANT_TX.test(text)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forbids application-controlled bypass/owner mode references", () => {
    expect(findBypassModeReferences(src)).toEqual([]);
  });

  it("NC-6 negative control: a reintroduced authz_mode setter is detected", () => {
    const dir = mkdtempSync(join(tmpdir(), "figbloom-bypass-"));
    try {
      writeFileSync(
        join(dir, "leak.ts"),
        `await client.query("SELECT set_config('app.authz_mode', 'bypass', true)");\n`,
        "utf8",
      );
      const text = readFileSync(join(dir, "leak.ts"), "utf8");
      expect(BYPASS_RE.test(text)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
