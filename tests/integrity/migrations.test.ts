import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * QA 15 (FIG-1248): what the migration files say about themselves, read as text (no database). The live database is checked by
 * supabase/rls-checks/integrity.sql; applying every file from scratch is `npm run db:reset`.
 * A test marked `it.fails` is a bug already filed (its FIG id is in the title): it passes while the bug exists and fails the day
 * it is fixed; then change it.fails to it.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = join(ROOT, "supabase", "migrations");
const files = readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const read = (f: string) => readFileSync(join(DIR, f), "utf8");
const strip = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

/** The tables the migrations create in the public schema and do not later drop. */
function tablesFromMigrations(): Set<string> {
  const tables = new Set<string>();
  for (const f of files) {
    const sql = strip(read(f));
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi)) tables.add(m[1]!.toLowerCase());
    for (const m of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi)) tables.delete(m[1]!.toLowerCase());
  }
  return tables;
}

describe("migration files", () => {
  it("every file is named <14-digit version>_<name>.sql", () => {
    expect(files.filter((f) => !/^\d{14}_[a-z0-9_]+\.sql$/.test(f))).toEqual([]);
    expect(files.length).toBeGreaterThan(90);
  });

  it("no two files share a version (the version is the key the database applies them by)", () => {
    const versions = files.map((f) => f.slice(0, 14));
    expect(versions.filter((v, i) => versions.indexOf(v) !== i)).toEqual([]);
  });

  it("the two 'organizations' files, one second apart, are one change on purpose: an enum value must land in its own transaction before it can be used", () => {
    const [first, second] = files.filter((f) => f.endsWith("_organizations.sql"));
    expect(first).toBe("20260916010000_organizations.sql");
    expect(second).toBe("20260916010001_organizations.sql");
    const a = strip(read(first!)).trim();
    expect(a).toBe("alter type app_role add value 'org_admin';");
    expect(read(first!)).toMatch(/freshly-added enum value/);
    expect(strip(read(second!))).toMatch(/create\s+table\s+organizations/i);
    expect(strip(read(second!))).toMatch(/org_admin/);
  });

  it("the learner-archive migration (20261023100000) moves no data: it adds columns, a guard and two functions, so there is nothing to convert", () => {
    const sql = strip(read("20261023100000_learner_archive.sql")).toLowerCase();
    expect(sql).not.toMatch(/\binsert\s+into\b(?!\s+audit_events)/);
    expect(sql).not.toMatch(/\bupdate\s+students\b(?![\s\S]{0,60}\bset\s+active)/);
    expect(sql).toMatch(/add column archived_at/);
    expect(sql).toMatch(/create trigger students_guard_delete/);
  });

  it("every table a migration creates has row-level security switched on somewhere in the migrations", () => {
    const all = files.map((f) => strip(read(f)).toLowerCase()).join("\n");
    const off = [...tablesFromMigrations()].filter((t) => !new RegExp(`alter\\s+table\\s+(?:only\\s+)?(?:public\\.)?"?${t}"?\\s+enable\\s+row\\s+level\\s+security`).test(all));
    // organization_tenant_summary and login_lookups are switched on in a loop or by their own statement; list anything else here
    expect(off.filter((t) => !["login_lookups"].includes(t))).toEqual([]);
  });
});

describe("supabase/schema.sql and supabase/rls.sql", () => {
  // Both files say they are the source of truth, types.ts says it "mirrors supabase/schema.sql", and PRODUCTION_TODO line 104 says
  // delete them. The migrations are what runs; the two files no longer describe the database.
  it.fails("QA15-STALE-SCHEMA FIG-1469: schema.sql is gone, or it lists every table the migrations create", () => {
    if (!existsSync(join(ROOT, "supabase", "schema.sql"))) return;
    const doc = strip(readFileSync(join(ROOT, "supabase", "schema.sql"), "utf8"));
    const documented = new Set([...doc.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi)].map((m) => m[1]!.toLowerCase()));
    expect([...tablesFromMigrations()].filter((t) => !documented.has(t))).toEqual([]);
  });

  it.fails("QA15-STALE-SCHEMA FIG-1469: rls.sql is gone, or it holds every policy the migrations create", () => {
    if (!existsSync(join(ROOT, "supabase", "rls.sql"))) return;
    const policies = (sql: string) => new Set([...strip(sql).matchAll(/create\s+policy\s+"?([a-z0-9_]+)"?/gi)].map((m) => m[1]!.toLowerCase()));
    const real = new Set(files.flatMap((f) => [...policies(read(f))]));
    const documented = policies(readFileSync(join(ROOT, "supabase", "rls.sql"), "utf8"));
    expect([...real].filter((p) => !documented.has(p))).toEqual([]);
  });
});
