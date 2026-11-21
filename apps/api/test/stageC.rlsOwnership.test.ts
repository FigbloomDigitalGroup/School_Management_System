import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { createTestApp, type FixtureIds } from "./support.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

async function loginEmail(app: Ctx["app"], email: string): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/auth/login/email",
    payload: { email, password: "correct-horse-battery" },
  });
  expect(res.statusCode).toBe(200);
  return res.json().token as string;
}

function bearer(token: string, tenantId: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, "x-tenant-id": tenantId };
}

describe("Stage C RLS ownership, membership and TEMPORARY", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let adminToken: string;
  let superToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    adminToken = await loginEmail(ctx.app, "admin-a@example.com");
    superToken = await loginEmail(ctx.app, "super@example.com");

    await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: bearer(adminToken, ids.tenantA),
      payload: { admission_no: "OWN-A", full_name: "Owner A", gender: "female" },
    });
    await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantB}/learners`,
      headers: bearer(superToken, ids.tenantB),
      payload: { admission_no: "OWN-B", full_name: "Owner B", gender: "male" },
    });
  }, 120_000);

  afterAll(async () => {
    await ctx.pool.query(`DROP TABLE IF EXISTS figbloom_owner_policy_probe CASCADE`).catch(() => undefined);
    await ctx.pool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'figbloom_owner_rls') THEN
          REVOKE ALL ON SCHEMA public FROM figbloom_owner_rls;
          IF EXISTS (
            SELECT 1 FROM pg_auth_members m
            JOIN pg_roles granted ON granted.oid = m.roleid
            JOIN pg_roles member ON member.oid = m.member
            WHERE granted.rolname = 'figbloom_owner_rls' AND member.rolname = current_user
          ) THEN
            REVOKE figbloom_owner_rls FROM CURRENT_USER;
          END IF;
          DROP ROLE figbloom_owner_rls;
        END IF;
      END $$
    `).catch(() => undefined);
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("proves positive owner-policy behaviour with a non-superuser non-BYPASSRLS owner role", async () => {
    const password = randomBytes(18).toString("base64url");
    const literal = `'${password.replace(/'/g, "''")}'`;
    await ctx.pool.query(`DROP TABLE IF EXISTS figbloom_owner_policy_probe CASCADE`);
    await ctx.pool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'figbloom_owner_rls') THEN
          REVOKE ALL ON SCHEMA public FROM figbloom_owner_rls;
          IF EXISTS (
            SELECT 1 FROM pg_auth_members m
            JOIN pg_roles granted ON granted.oid = m.roleid
            JOIN pg_roles member ON member.oid = m.member
            WHERE granted.rolname = 'figbloom_owner_rls' AND member.rolname = current_user
          ) THEN
            REVOKE figbloom_owner_rls FROM CURRENT_USER;
          END IF;
          DROP ROLE figbloom_owner_rls;
        END IF;
      END $$
    `);
    await ctx.pool.query(
      `CREATE ROLE figbloom_owner_rls NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEROLE NOCREATEDB`,
    );
    await ctx.pool.query(`GRANT figbloom_owner_rls TO CURRENT_USER`);
    await ctx.pool.query(`GRANT CREATE, USAGE ON SCHEMA public TO figbloom_owner_rls`);
    await ctx.pool.query(`
      CREATE TABLE figbloom_owner_policy_probe (
        id uuid PRIMARY KEY,
        tenant_id uuid NOT NULL,
        label text NOT NULL
      )
    `);
    await ctx.pool.query(`ALTER TABLE figbloom_owner_policy_probe OWNER TO figbloom_owner_rls`);
    await ctx.pool.query(`ALTER TABLE figbloom_owner_policy_probe ENABLE ROW LEVEL SECURITY`);
    await ctx.pool.query(`ALTER TABLE figbloom_owner_policy_probe FORCE ROW LEVEL SECURITY`);
    await ctx.pool.query(`
      CREATE POLICY figbloom_owner_policy_probe_tenant ON figbloom_owner_policy_probe
      FOR ALL TO figbloom_app
      USING (tenant_id = app_current_tenant_id())
      WITH CHECK (tenant_id = app_current_tenant_id())
    `);
    await ctx.pool.query(`
      CREATE POLICY figbloom_owner_policy_probe_owner ON figbloom_owner_policy_probe
      FOR ALL TO PUBLIC
      USING (current_user = (
        SELECT pg_get_userbyid(c.relowner) FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'figbloom_owner_policy_probe'
      ))
      WITH CHECK (current_user = (
        SELECT pg_get_userbyid(c.relowner) FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = 'figbloom_owner_policy_probe'
      ))
    `);
    await ctx.pool.query(`GRANT SELECT, INSERT ON figbloom_owner_policy_probe TO figbloom_app`);
    await ctx.pool.query(
      `INSERT INTO figbloom_owner_policy_probe (id, tenant_id, label) VALUES
        ($1, $2, 'A'), ($3, $4, 'B')`,
      [randomUUID(), ids.tenantA, randomUUID(), ids.tenantB],
    );

    const flags = await ctx.pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'figbloom_owner_rls'`,
    );
    expect(flags.rows[0]?.rolsuper).toBe(false);
    expect(flags.rows[0]?.rolbypassrls).toBe(false);

    await ctx.pool.query(`ALTER ROLE figbloom_owner_rls WITH LOGIN PASSWORD ${literal}`);
    const ownerUrl = new URL(
      process.env.MIGRATION_DATABASE_URL ??
        process.env.DATABASE_URL ??
        "",
    );
    ownerUrl.username = "figbloom_owner_rls";
    ownerUrl.password = password;

    const { default: pg } = await import("pg");
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.toString(), max: 1 });
    try {
      const asOwner = await ownerPool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM figbloom_owner_policy_probe`,
      );
      expect(asOwner.rows[0]?.n).toBe(2);
    } finally {
      await ownerPool.end();
      await ctx.pool.query(`ALTER ROLE figbloom_owner_rls WITH NOLOGIN PASSWORD NULL`);
    }

    const runtime = await ctx.runtimePool.connect();
    try {
      await runtime.query("BEGIN");
      await runtime.query(`SELECT set_config('app.tenant_id', $1, true)`, [ids.tenantA]);
      const onlyA = await runtime.query<{ label: string }>(
        `SELECT label FROM figbloom_owner_policy_probe ORDER BY label`,
      );
      expect(onlyA.rows.map((r) => r.label)).toEqual(["A"]);
      await runtime.query("ROLLBACK");
    } finally {
      runtime.release();
    }
  });

  it("blocks cross-tenant SELECT/INSERT/UPDATE/DELETE under the runtime login", async () => {
    const client = await ctx.runtimePool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ids.tenantA]);
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.adminA]);

      const selectB = await client.query(
        `SELECT admission_no FROM learners WHERE admission_no = 'OWN-B'`,
      );
      expect(selectB.rowCount).toBe(0);

      // Phase 3 (017): UPDATE is granted for lifecycle; RLS still hides other-tenant rows (0 updated).
      // DELETE remains denied by least-privilege grants.
      await client.query("SAVEPOINT rls_update");
      const crossUpdate = await client.query(
        `UPDATE learners SET full_name = 'hacked' WHERE admission_no = 'OWN-B'`,
      );
      expect(crossUpdate.rowCount).toBe(0);
      await client.query("ROLLBACK TO SAVEPOINT rls_update");

      await client.query("SAVEPOINT deny_delete");
      await expect(client.query(`DELETE FROM learners WHERE admission_no = 'OWN-B'`)).rejects.toThrow(
        /permission denied/i,
      );
      await client.query("ROLLBACK TO SAVEPOINT deny_delete");

      await client.query("SAVEPOINT deny_insert");
      await expect(
        client.query(
          `INSERT INTO learners (tenant_id, admission_no, full_name, gender, created_by)
           VALUES ($1, 'OWN-CROSS', 'Cross', 'male', $2)`,
          [ids.tenantB, ids.adminA],
        ),
      ).rejects.toThrow(/row-level security|policy/i);
      await client.query("ROLLBACK TO SAVEPOINT deny_insert");

      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }

    // With a temporary DELETE grant, RLS still hides the other tenant (0 rows deleted).
    // UPDATE is already granted (Phase 3 lifecycle); RLS still yields 0 on foreign rows.
    const widened = await ctx.pool.connect();
    try {
      await widened.query("BEGIN");
      await widened.query(`GRANT DELETE ON learners TO figbloom_app`);
      await widened.query("SET LOCAL ROLE figbloom_app");
      await widened.query(`SELECT set_config('app.tenant_id', $1, true)`, [ids.tenantA]);
      const updated = await widened.query(
        `UPDATE learners SET full_name = 'hacked' WHERE admission_no = 'OWN-B'`,
      );
      expect(updated.rowCount).toBe(0);
      const deleted = await widened.query(`DELETE FROM learners WHERE admission_no = 'OWN-B'`);
      expect(deleted.rowCount).toBe(0);
      await widened.query("ROLLBACK");
    } finally {
      await widened.query("ROLLBACK").catch(() => undefined);
      widened.release();
    }

    const stillThere = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM learners WHERE admission_no = 'OWN-B' AND full_name = 'Owner B'`,
    );
    expect(stillThere.rows[0]?.n).toBe(1);
  });

  it("asserts the effective TEMPORARY privilege state for figbloom_app", async () => {
    const temp = await ctx.pool.query<{
      app_temp: boolean;
      public_temp: boolean;
    }>(
      `SELECT has_database_privilege('figbloom_app', current_database(), 'TEMPORARY') AS app_temp,
              has_database_privilege('public', current_database(), 'TEMPORARY') AS public_temp`,
    );
    // Migration 009 revokes TEMPORARY when the migrator can. Assert the intended
    // effective state rather than swallowing a failed revoke.
    expect(temp.rows[0]?.app_temp).toBe(false);

    const runtime = await ctx.runtimePool.connect();
    try {
      await expect(runtime.query(`CREATE TEMP TABLE figbloom_temp_probe (id int)`)).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      runtime.release();
    }
  });

  it("NC-5: weakening the membership tenant policy exposes cross-tenant rows, then restore hides them", async () => {
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      // Dropping alone fails closed (no matching policy). Weaken USING to true to prove the test detects exposure.
      await client.query(`DROP POLICY school_memberships_tenant ON school_memberships`);
      await client.query(`
        CREATE POLICY school_memberships_tenant ON school_memberships
        FOR ALL TO figbloom_app
        USING (true)
        WITH CHECK (true)
      `);
      await client.query("SET LOCAL ROLE figbloom_app");
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ids.tenantA]);
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.adminA]);
      const leaked = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM school_memberships WHERE tenant_id = $1`,
        [ids.tenantB],
      );
      expect(leaked.rows[0]?.n).toBeGreaterThan(0);
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }

    const restored = await ctx.runtimePool.connect();
    try {
      await restored.query("BEGIN");
      await restored.query(`SELECT set_config('app.tenant_id', $1, true)`, [ids.tenantA]);
      await restored.query(`SELECT set_config('app.user_id', $1, true)`, [ids.adminA]);
      const hidden = await restored.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM school_memberships WHERE tenant_id = $1`,
        [ids.tenantB],
      );
      expect(hidden.rows[0]?.n).toBe(0);
      await restored.query("ROLLBACK");
    } finally {
      restored.release();
    }
  });
});
