import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestApp } from "./support.js";

/** DML figbloom_app may hold. Anything else, including TRUNCATE, is drift. */
const EXPECTED: Record<string, string[]> = {
  organizations: ["SELECT"],
  tenants: ["SELECT"],
  users: ["SELECT", "UPDATE"],
  sessions: ["INSERT", "SELECT", "UPDATE"],
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
  org_admin_school_delegations: ["INSERT", "SELECT", "UPDATE"],
  learners: ["INSERT", "SELECT"],
  guardians: ["INSERT", "SELECT"],
  guardian_links: ["INSERT", "SELECT"],
  security_audit_events: ["INSERT"],
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
