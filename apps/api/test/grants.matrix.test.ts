import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestApp } from "./support.js";

/** DML figbloom_app may hold. Anything else, including TRUNCATE, is drift. */
const EXPECTED: Record<string, string[]> = {
  organizations: ["SELECT"],
  tenants: ["SELECT"],
  // Migration 014: session writes are SECURITY DEFINER + HMAC; runtime retains SELECT only.
  sessions: ["SELECT"],
  platform_roles: ["SELECT"],
  organization_memberships: ["SELECT"],
  permissions: ["SELECT"],
  role_permissions: ["SELECT"],
  school_memberships: ["SELECT"],
  school_roles: ["SELECT"],
  school_role_assignments: ["SELECT"],
  auth_rate_buckets: ["INSERT", "SELECT", "UPDATE"],
  external_identities: ["INSERT", "SELECT", "UPDATE"],
  external_identity_link_events: ["INSERT"],
  staff_area_grants: ["DELETE", "INSERT", "SELECT"],
  // Migration 025: UPDATE only on (revoked_at, revoked_by), asserted as column grants below.
  org_admin_school_delegations: ["INSERT", "SELECT"],
  // Migration 027: every directory table's UPDATE is column-level — only the columns its module
  // writes — so no table-level UPDATE appears here. The exact column sets are asserted below.
  learners: ["INSERT", "SELECT"],
  guardians: ["INSERT", "SELECT"],
  guardian_links: ["INSERT", "SELECT"],
  school_profiles: ["INSERT", "SELECT"],
  staff_members: ["INSERT", "SELECT"],
  // Migration 025 (FIG-1614 Option D): grant rows are inserted and soft-revoked (UPDATE), never deleted.
  staff_resource_grants: ["INSERT", "SELECT"],
  directory_documents: ["INSERT", "SELECT"],
  idempotency_keys: ["INSERT", "SELECT", "UPDATE"],
  security_audit_events: ["INSERT"],
};

/**
 * Migration 027 (P3-AUDIT-009). Identity (`id`, `tenant_id`), provenance (`created_at`,
 * `created_by`, `uploaded_by`) and storage-contract columns (`storage_key`, `storage_status`,
 * `logo_object_key`) are absent from every list: no application path updates them, and the
 * privilege is now gone as well as the code. Widening any of these lists is a security change.
 */
const EXPECTED_DIRECTORY_UPDATE_COLUMNS: Record<string, string[]> = {
  learners: [
    "active",
    "admission_no",
    "archived_at",
    "boarding",
    "date_of_birth",
    "full_name",
    "gender",
    "updated_at",
  ],
  guardians: ["active", "alt_phone", "archived_at", "email", "full_name", "phone", "updated_at"],
  guardian_links: ["archived_at", "archived_reason"],
  staff_members: [
    "active",
    "archived_at",
    "classification",
    "email",
    "full_name",
    "phone",
    "staff_title",
    "updated_at",
    "user_id",
  ],
  school_profiles: [
    "accent",
    "contact_email",
    "contact_phone",
    "country",
    "county",
    "institution_type",
    "level",
    "moe_registration",
    "updated_at",
  ],
  directory_documents: ["archived_at", "updated_at"],
};

describe("migration 009 grants and policies", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("UPDATE on the two grant tables is column-level, revocation columns only (review M-1)", async () => {
    const r = await ctx.pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.column_privileges
        WHERE grantee = 'figbloom_app' AND table_schema = 'public' AND privilege_type = 'UPDATE'
          AND table_name IN ('org_admin_school_delegations', 'staff_resource_grants')
        ORDER BY table_name, column_name`,
    );
    const by: Record<string, string[]> = {};
    for (const row of r.rows) (by[row.table_name] ??= []).push(row.column_name);
    expect(by).toEqual({
      org_admin_school_delegations: ["revoked_at", "revoked_by"],
      staff_resource_grants: ["revoke_reason", "revoked_at", "revoked_by"],
    });
  });

  it("directory tables: UPDATE is column-level and names only the columns the modules write (P3-AUDIT-009)", async () => {
    const tables = Object.keys(EXPECTED_DIRECTORY_UPDATE_COLUMNS);
    const r = await ctx.pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.column_privileges
        WHERE grantee = 'figbloom_app' AND table_schema = 'public' AND privilege_type = 'UPDATE'
          AND table_name = ANY($1::text[])
        ORDER BY table_name, column_name`,
      [tables],
    );
    const by: Record<string, string[]> = {};
    for (const row of r.rows) (by[row.table_name] ??= []).push(row.column_name);
    expect(by).toEqual(EXPECTED_DIRECTORY_UPDATE_COLUMNS);

    // The point of the change: identity and provenance are not updatable at all, as PostgreSQL
    // itself computes it — not merely absent from the list above.
    for (const [table, columns] of Object.entries(EXPECTED_DIRECTORY_UPDATE_COLUMNS)) {
      const forbidden = ["id", "tenant_id", "created_at", "created_by"].filter(
        (c) => !columns.includes(c),
      );
      for (const column of forbidden) {
        const exists = await ctx.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
          [table, column],
        );
        if (exists.rows[0]!.n === 0) continue;
        const eff = await ctx.pool.query<{ upd: boolean }>(
          `SELECT has_column_privilege('figbloom_app', $1, $2, 'UPDATE') AS upd`,
          [`public.${table}`, column],
        );
        expect(eff.rows[0]?.upd, `${table}.${column} UPDATE`).toBe(false);
      }
      // Table-level UPDATE really is gone, and only the column-level privilege remains.
      const priv = await ctx.pool.query<{ tbl: boolean; any_col: boolean }>(
        `SELECT has_table_privilege('figbloom_app', $1, 'UPDATE') AS tbl,
                has_any_column_privilege('figbloom_app', $1, 'UPDATE') AS any_col`,
        [`public.${table}`],
      );
      expect(priv.rows[0]?.tbl, `${table} table-level UPDATE`).toBe(false);
      expect(priv.rows[0]?.any_col, `${table} any-column UPDATE`).toBe(true);
    }
  });

  it("row locking still works under column-level grants, so read-modify-write stays serialised (P3-AUDIT-012)", async () => {
    // The lost-update fix depends on SELECT ... FOR UPDATE, which needs an UPDATE privilege.
    // PostgreSQL accepts a column-level one, but that is not obvious from the catalogue
    // (has_table_privilege says false), so it is proved by executing the lock.
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE figbloom_app");
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ctx.ids.tenantA]);
      for (const table of Object.keys(EXPECTED_DIRECTORY_UPDATE_COLUMNS)) {
        await client.query("SAVEPOINT sp_lock");
        await expect(
          client.query(`SELECT 1 FROM ${table} LIMIT 1 FOR UPDATE`),
          `${table} FOR UPDATE`,
        ).resolves.toBeDefined();
        await client.query("RELEASE SAVEPOINT sp_lock");
      }
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("matches the code-audit grant matrix", async () => {
    const grants = await ctx.pool.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type
       FROM information_schema.role_table_grants
       WHERE grantee = 'figbloom_app' AND table_schema = 'public'
       ORDER BY table_name, privilege_type`,
    );
    const actual: Record<string, string[]> = {};
    for (const row of grants.rows) {
      (actual[row.table_name] ??= []).push(row.privilege_type);
    }
    expect(actual).toEqual(EXPECTED);
    const excess = grants.rows.filter((r) =>
      ["TRUNCATE", "REFERENCES", "TRIGGER"].includes(r.privilege_type),
    );
    expect(excess).toEqual([]);
  });

  it("users: no table-level privilege; password_hash is neither selectable nor updatable by the runtime role (migrations 011 and 013)", async () => {
    const cols = await ctx.pool.query<{ column_name: string; privilege_type: string }>(
      `SELECT column_name, privilege_type
         FROM information_schema.role_column_grants
        WHERE grantee = 'figbloom_app' AND table_schema = 'public' AND table_name = 'users'
        ORDER BY privilege_type, column_name`,
    );
    const sel = cols.rows.filter((r) => r.privilege_type === "SELECT").map((r) => r.column_name).sort();
    const upd = cols.rows.filter((r) => r.privilege_type === "UPDATE").map((r) => r.column_name).sort();
    expect(sel).toEqual(["created_at", "email", "full_name", "id", "must_change_password", "phone", "status", "updated_at"]);
    expect(sel).not.toContain("password_hash");
    expect(upd).toEqual([]);
    expect(cols.rows.filter((r) => !["SELECT", "UPDATE"].includes(r.privilege_type))).toEqual([]);
    // Effective privilege on the hash column, as PostgreSQL computes it.
    const eff = await ctx.pool.query<{ sel: boolean; upd: boolean; ins: boolean; tbl_sel: boolean }>(
      `SELECT has_column_privilege('figbloom_app', 'public.users', 'password_hash', 'SELECT') AS sel,
              has_column_privilege('figbloom_app', 'public.users', 'password_hash', 'UPDATE') AS upd,
              has_column_privilege('figbloom_app', 'public.users', 'password_hash', 'INSERT') AS ins,
              has_table_privilege('figbloom_app', 'public.users', 'SELECT') AS tbl_sel`,
    );
    expect(eff.rows[0]).toEqual({ sel: false, upd: false, ins: false, tbl_sel: false });
  });

  it("revokes CREATE on schema public and does not reference a mode GUC", async () => {
    const create = await ctx.pool.query<{ app: boolean; pub: number }>(
      `SELECT has_schema_privilege('figbloom_app', 'public', 'CREATE') AS app,
              (SELECT count(*)::int FROM pg_namespace n, aclexplode(n.nspacl) x
                WHERE n.nspname = 'public' AND x.grantee = 0 AND x.privilege_type = 'CREATE') AS pub`,
    );
    expect(create.rows[0]?.app).toBe(false);
    expect(create.rows[0]?.pub).toBe(0);

    const sql = readFileSync(join(process.cwd(), "migrations", "009_runtime_rls_hardening.sql"), "utf8");
    expect(sql).not.toMatch(/authz_mode/);
    const policies = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_policy
       WHERE pg_get_expr(polqual, polrelid) ILIKE '%authz_mode%'
          OR pg_get_expr(polwithcheck, polrelid) ILIKE '%authz_mode%'`,
    );
    expect(policies.rows[0]?.n).toBe(0);

    const owner = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_policy WHERE polname LIKE '%_owner' AND pg_get_expr(polqual, polrelid) ILIKE '%relowner%'`,
    );
    expect(owner.rows[0]?.n).toBeGreaterThanOrEqual(8);
  });

  it("asserts TEMPORARY is revoked from figbloom_app (effective privilege)", async () => {
    const temp = await ctx.pool.query<{ app_temp: boolean; public_temp: boolean }>(
      `SELECT has_database_privilege('figbloom_app', current_database(), 'TEMPORARY') AS app_temp,
              has_database_privilege('public', current_database(), 'TEMPORARY') AS public_temp`,
    );
    expect(temp.rows[0]?.app_temp).toBe(false);
    expect(temp.rows[0]?.public_temp).toBe(false);
  });

  it("a probe role with SELECT is not the owner and sees zero learner rows", async () => {
    await ctx.pool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'figbloom_probe') THEN
          REVOKE ALL ON TABLE public.learners FROM figbloom_probe;
          REVOKE ALL ON SCHEMA public FROM figbloom_probe;
          IF EXISTS (
            SELECT 1 FROM pg_auth_members m
            JOIN pg_roles granted ON granted.oid = m.roleid
            JOIN pg_roles member ON member.oid = m.member
            WHERE granted.rolname = 'figbloom_probe' AND member.rolname = current_user
          ) THEN
            REVOKE figbloom_probe FROM CURRENT_USER;
          END IF;
          DROP ROLE figbloom_probe;
        END IF;
      END $$
    `);
    await ctx.pool.query(`CREATE ROLE figbloom_probe NOLOGIN`);
    await ctx.pool.query(`GRANT figbloom_probe TO CURRENT_USER`);
    await ctx.pool.query(`GRANT USAGE ON SCHEMA public TO figbloom_probe`);
    await ctx.pool.query(`GRANT SELECT ON learners TO figbloom_probe`);
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE figbloom_probe");
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ctx.ids.tenantA]);
      const rows = await client.query(`SELECT id FROM learners`);
      expect(rows.rowCount).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      await ctx.pool.query(`REVOKE figbloom_probe FROM CURRENT_USER`);
      await ctx.pool.query(`REVOKE ALL ON TABLE public.learners FROM figbloom_probe`);
      await ctx.pool.query(`REVOKE ALL ON SCHEMA public FROM figbloom_probe`);
      await ctx.pool.query(`DROP ROLE figbloom_probe`);
    }
  });
});
