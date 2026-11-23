import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";
import { findTenantBoundaryViolations, UNRESOLVED_SQL } from "./support/tenantBoundary.js";

const SRC = join(process.cwd(), "src");
const TSCONFIG = join(process.cwd(), "tsconfig.json");

/**
 * Reviewed exceptions to "tenant tables only through a Tx handle". Adding a line
 * here is a security-relevant change and must carry a reason.
 */
const IDENTITY_EXCEPTIONS = [
  {
    file: "*",
    table: "school_memberships",
    reason: "AD-4: user-scoped self-read policy (login, /auth/me, select-tenant)",
  },
  ...["staff_area_grants", "school_role_assignments", "school_roles", "org_admin_school_delegations"].flatMap(
    (table) =>
      ["modules/rbac/authorize.ts", "modules/rbac/delegations.ts"].map((file) => ({
        file,
        table,
        reason:
          "authorisation helpers run on both paths; the tenant branches need a tenantId, which only a tenant transaction has",
      })),
  ),
];

// FIG-1614: the effective-permission loader (authorize.ts) reads the caller's own explicit
// guardian grants through the same TxOrIdentity handle as staff_area_grants. It needs a tenant id,
// which it receives only after the tenant is authorised; a null tenant returns before any query.
IDENTITY_EXCEPTIONS.push({
  file: "modules/rbac/authorize.ts",
  table: "staff_resource_grants",
  reason: "effective-permission loader runs on both paths, like staff_area_grants; skips when tenantId is null",
});

/**
 * SUPPLEMENTARY pattern check (F-C7). A regex over source text can be evaded
 * (string concatenation, a variable, an indirect helper). It is NOT proof that
 * an application-controlled bypass is impossible. The primary evidence is
 * PostgreSQL behaviour as figbloom_app: stageC.negativeControls / runtimeRls
 * tests set `app.authz_mode` through the real runtime login, inspect live
 * pg_policies and prove the setting changes nothing.
 */
const BYPASS_RE = /\bauthz_mode\b|\bbypass\b.*\bowner\b|set_config\(\s*['"]app\.authz_mode/i;

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

/** Supplementary: application source must not mention an authz bypass/owner mode. */
export function findBypassModeReferences(srcRoot: string): string[] {
  const hits: string[] = [];
  for (const file of listTs(srcRoot)) {
    const rel = relative(srcRoot, file).split("\\").join("/");
    if (rel.startsWith("db/migrate")) continue;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i]!.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
      if (BYPASS_RE.test(lines[i]!) && /authz_mode|set_config/.test(lines[i]!)) {
        hits.push(`${rel}:${i + 1}`);
      }
    }
  }
  return hits;
}

describe("architecture: tenant boundary (F-C6, F-C7)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let tenantTables: string[];

  beforeAll(async () => {
    ctx = await createTestApp();
    // Derived from the live catalogue, not from a list in this file: every
    // public table with a tenant_id column and row security enabled.
    const r = await ctx.pool.query<{ table_name: string }>(
      `SELECT c.relname AS table_name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity
        ORDER BY 1`,
    );
    tenantTables = r.rows.map((x) => x.table_name);
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("derives a non-trivial tenant table set from the catalogue", () => {
    for (const t of ["learners", "guardians", "guardian_links", "school_memberships", "staff_area_grants"]) {
      expect(tenantTables).toContain(t);
    }
  });

  it("no SQL naming a tenant table runs through anything but a tenant handle (Tx)", () => {
    const violations = findTenantBoundaryViolations({
      tsconfigPath: TSCONFIG,
      srcRoot: SRC,
      tenantTables,
      identityAllowed: IDENTITY_EXCEPTIONS,
    });
    expect(violations).toEqual([]);
  }, 120_000);

  it("NC-2 negative control: identity, generic, pool and untyped receivers are all detected", () => {
    const dir = mkdtempSync(join(tmpdir(), "figbloom-tenant-nc2-"));
    try {
      const file = join(dir, "leak.ts");
      writeFileSync(
        file,
        [
          `import type pg from "pg";`,
          `import type { Tx, IdentityDb, SqlClient } from "${join(SRC, "db", "sql.js").split("\\").join("/")}";`,
          `export async function viaIdentity(db: IdentityDb) { return db.query("SELECT * FROM learners"); }`,
          `export async function viaGeneric(db: SqlClient) { return db.query(\`UPDATE guardians SET x = 1\`); }`,
          `export async function viaPool(pool: pg.Pool) { return pool.query("DELETE FROM guardian_links"); }`,
          `export async function viaConcat(db: SqlClient) { return db.query("SELECT 1 " + "FROM school_memberships"); }`,
          `export async function viaObject(db: SqlClient) { return db.query({ text: "INSERT INTO learners (id) VALUES ($1)" }); }`,
          `export async function okTenant(tx: Tx) { return tx.query("SELECT * FROM learners"); }`,
          `export async function okIdentityOtherTable(db: IdentityDb) { return db.query("SELECT * FROM users"); }`,
        ].join("\n"),
        "utf8",
      );
      const violations = findTenantBoundaryViolations({
        tsconfigPath: TSCONFIG,
        srcRoot: SRC,
        tenantTables,
        extraFiles: [file],
      }).filter((v) => v.file.endsWith("leak.ts"));
      expect(violations.map((v) => v.table).sort()).toEqual(
        ["guardian_links", "guardians", "learners", "learners", "school_memberships"].sort(),
      );
      expect(violations.some((v) => v.line === 8 || v.line === 9)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("NC-2b: an identity handle is accepted only for a reviewed exception, not for other tables or files", () => {
    const dir = mkdtempSync(join(tmpdir(), "figbloom-tenant-nc2b-"));
    try {
      const file = join(dir, "other.ts");
      writeFileSync(
        file,
        [
          `import type { IdentityDb, TxOrIdentity } from "${join(SRC, "db", "sql.js").split("\\").join("/")}";`,
          `export async function a(db: IdentityDb) { return db.query("SELECT * FROM school_memberships"); }`,
          `export async function b(db: TxOrIdentity) { return db.query("SELECT * FROM staff_area_grants"); }`,
        ].join("\n"),
        "utf8",
      );
      const v =findTenantBoundaryViolations({
        tsconfigPath: TSCONFIG,
        srcRoot: SRC,
        tenantTables,
        extraFiles: [file],
        identityAllowed: IDENTITY_EXCEPTIONS,
      }).filter((x) => x.file.endsWith("other.ts"));
      // school_memberships is excepted for any file; staff_area_grants is excepted only in the two authz modules.
      expect(v.map((x) => x.table)).toEqual(["staff_area_grants"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("NC-2c (review R-07): SQL held in a const, a conditional or an `as const` value is resolved; unresolvable SQL is reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "figbloom-tenant-nc2c-"));
    try {
      const file = join(dir, "indirect.ts");
      writeFileSync(
        file,
        [
          `import type { Tx, IdentityDb, SqlClient } from "${join(SRC, "db", "sql.js").split("\\").join("/")}";`,
          `const READ = "SELECT * FROM learners";`,
          `const WRITE = \`UPDATE guardians SET x = 1\`;`,
          `const PICK = process.env.X ? "SELECT 1" : "SELECT * FROM guardian_links";`,
          `const TYPED = "DELETE FROM school_memberships" as const;`,
          `const BASE = "SELECT * FROM ";`,
          `const JOINED = BASE + "staff_area_grants";`,
          `export async function viaConst(db: IdentityDb) { return db.query(READ); }`,
          `export async function viaTemplateConst(db: SqlClient) { return db.query(WRITE); }`,
          `export async function viaConditional(db: SqlClient) { return db.query(PICK); }`,
          `export async function viaAs(db: SqlClient) { return db.query(TYPED); }`,
          `export async function viaChain(db: SqlClient) { return db.query(JOINED); }`,
          `export async function okTenant(tx: Tx) { return tx.query(READ); }`,
          `export async function okOtherTable(db: IdentityDb) { const s = "SELECT 1 FROM users"; return db.query(s); }`,
          `export async function unresolvedParam(db: IdentityDb, sql: string) { return db.query(sql); }`,
          `export async function unresolvedCall(db: IdentityDb) { return db.query(String(Date.now())); }`,
          `let mutable = "SELECT 1";`,
          `export async function unresolvedLet(db: IdentityDb) { return db.query(mutable); }`,
        ].join("\n"),
        "utf8",
      );
      const all = findTenantBoundaryViolations({
        tsconfigPath: TSCONFIG,
        srcRoot: SRC,
        tenantTables,
        extraFiles: [file],
        reportUnresolved: true,
      }).filter((v) => v.file.endsWith("indirect.ts"));
      const named = all.filter((v) => v.table !== UNRESOLVED_SQL).map((v) => v.table).sort();
      expect(named).toEqual(
        ["guardian_links", "guardians", "learners", "school_memberships", "staff_area_grants"].sort(),
      );
      // the three SQL values nothing can resolve are reported, not silently skipped
      expect(all.filter((v) => v.table === UNRESOLVED_SQL)).toHaveLength(3);
      // without the option nothing unresolved is reported, and the named ones are unchanged
      const quiet = findTenantBoundaryViolations({
        tsconfigPath: TSCONFIG,
        srcRoot: SRC,
        tenantTables,
        extraFiles: [file],
      }).filter((v) => v.file.endsWith("indirect.ts"));
      expect(quiet.map((v) => v.table).sort()).toEqual(named);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("no query outside src/db has SQL that the detector cannot resolve (so the boundary check sees every statement)", () => {
    const unresolved = findTenantBoundaryViolations({
      tsconfigPath: TSCONFIG,
      srcRoot: SRC,
      tenantTables,
      identityAllowed: IDENTITY_EXCEPTIONS,
      reportUnresolved: true,
    }).filter((v) => v.table === UNRESOLVED_SQL);
    expect(unresolved).toEqual([]);
  }, 120_000);

  it("supplementary: no application-controlled bypass/owner mode text in src (pattern check only)", () => {
    expect(findBypassModeReferences(SRC)).toEqual([]);
  });

  it("NC-6 (supplementary detector self-test): a reintroduced authz_mode setter matches the pattern", () => {
    expect(
      BYPASS_RE.test(`await client.query("SELECT set_config('app.authz_mode', 'bypass', true)");`),
    ).toBe(true);
  });
});
