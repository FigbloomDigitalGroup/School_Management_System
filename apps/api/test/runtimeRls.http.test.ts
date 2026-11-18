import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestApp, type FixtureIds } from "./support.js";
import { withIdentityAccess } from "../src/db/identityAccess.js";
import { withTenantTransaction } from "../src/db/tenantTransaction.js";
import { toClientError } from "../src/http/errors.js";

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

function bearer(token: string, tenantId?: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (tenantId) headers["x-tenant-id"] = tenantId;
  return headers;
}

describe("runtime RLS through figbloom_app", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let adminToken: string;
  let superToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    adminToken = await loginEmail(ctx.app, "admin-a@example.com");
    superToken = await loginEmail(ctx.app, "super@example.com");
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("hides the other tenant and ignores a mode GUC", async () => {
    const created = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: bearer(adminToken, ids.tenantA),
      payload: { admission_no: "RLS-A", full_name: "Tenant A", gender: "female" },
    });
    expect(created.statusCode).toBe(201);
    const learnerA = created.json().learner.id as string;

    const asSuper = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantB}/learners`,
      headers: bearer(superToken, ids.tenantB),
      payload: { admission_no: "RLS-B", full_name: "Tenant B", gender: "male" },
    });
    expect(asSuper.statusCode).toBe(201);

    const crossPath = await ctx.app.inject({
      method: "GET",
      url: `/v1/tenants/${ids.tenantB}/learners/${learnerA}`,
      headers: bearer(adminToken, ids.tenantB),
    });
    expect(crossPath.statusCode).toBe(403);

    const client = await ctx.runtimePool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ids.tenantA]);
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.adminA]);
      await client.query(`SELECT set_config('app.authz_mode', 'bypass', true)`);
      const visible = await client.query<{ admission_no: string }>(
        `SELECT admission_no FROM learners ORDER BY admission_no`,
      );
      const admissions = visible.rows.map((r) => r.admission_no);
      expect(admissions).toContain("RLS-A");
      expect(admissions).not.toContain("RLS-B");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("returns zero rows for missing and malformed tenant context", async () => {
    const client = await ctx.runtimePool.connect();
    try {
      await client.query("BEGIN");
      const missing = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM learners`);
      expect(missing.rows[0]?.n).toBe(0);
      await client.query(`SELECT set_config('app.tenant_id', 'not-a-uuid', true)`);
      const bad = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM learners`);
      expect(bad.rows[0]?.n).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("school_memberships: self-read, same-tenant read, no writes, archived hidden", async () => {
    const client = await ctx.runtimePool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.adminA]);
      await client.query(`SELECT set_config('app.tenant_id', '', true)`);
      const own = await client.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM school_memberships WHERE user_id = $1`,
        [ids.adminA],
      );
      expect(own.rows.map((r) => r.tenant_id)).toContain(ids.tenantA);
      const other = await client.query(
        `SELECT 1 FROM school_memberships WHERE user_id = $1`,
        [ids.teacherA],
      );
      expect(other.rowCount).toBe(0);

      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ids.tenantA]);
      const sameTenant = await client.query(
        `SELECT 1 FROM school_memberships WHERE user_id = $1`,
        [ids.teacherA],
      );
      expect(sameTenant.rowCount).toBe(1);
      const otherTenant = await client.query(
        `SELECT 1 FROM school_memberships WHERE tenant_id = $1`,
        [ids.tenantB],
      );
      expect(otherTenant.rowCount).toBe(0);

      await expect(
        client.query(
          `INSERT INTO school_memberships (user_id, tenant_id, role) VALUES ($1, $2, 'staff')`,
          [ids.adminA, ids.tenantA],
        ),
      ).rejects.toThrow(/permission denied/i);
      await client.query("ROLLBACK");
    } finally {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      client.release();
    }

    await ctx.pool.query(
      `UPDATE school_memberships SET archived_at = now() WHERE user_id = $1 AND tenant_id = $2`,
      [ids.parentA, ids.tenantA],
    );
    const archived = await ctx.runtimePool.connect();
    try {
      await archived.query("BEGIN");
      await archived.query(`SELECT set_config('app.user_id', $1, true)`, [ids.parentA]);
      await archived.query(`SELECT set_config('app.tenant_id', '', true)`);
      const rows = await archived.query(`SELECT 1 FROM school_memberships WHERE user_id = $1`, [
        ids.parentA,
      ]);
      expect(rows.rowCount).toBe(0);
      await archived.query("ROLLBACK");
    } finally {
      archived.release();
      await ctx.pool.query(
        `UPDATE school_memberships SET archived_at = NULL WHERE user_id = $1 AND tenant_id = $2`,
        [ids.parentA, ids.tenantA],
      );
    }
  });

  it("identity access cannot read tenant tables", async () => {
    const seen = await withIdentityAccess(ctx.runtimePool, (db) =>
      db.query<{ n: number }>(`SELECT count(*)::int AS n FROM learners`),
    );
    expect(seen.rows[0]?.n).toBe(0);
    await expect(
      withIdentityAccess(ctx.runtimePool, (db) =>
        db.query(
          `INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, 'NOPE', 'No', 'male')`,
          [ids.tenantA],
        ),
      ),
    ).rejects.toThrow();
  });

  it("refuses privilege escalation and keeps a nested write rolled back", async () => {
    const client = await ctx.runtimePool.connect();
    try {
      await expect(client.query(`SET ROLE postgres`)).rejects.toThrow(/permission denied/i);
      await expect(client.query(`SET SESSION AUTHORIZATION postgres`)).rejects.toThrow(/permission denied/i);
      await expect(client.query(`TRUNCATE learners`)).rejects.toThrow(/permission denied/i);
      await expect(
        client.query(`INSERT INTO schema_migrations (id) VALUES ('nope.sql')`),
      ).rejects.toThrow(/permission denied/i);
      await expect(client.query(`ALTER TABLE learners DISABLE ROW LEVEL SECURITY`)).rejects.toThrow(
        /permission denied|must be owner/i,
      );
    } finally {
      client.release();
    }

    const admission = `nested-${randomUUID().slice(0, 8)}`;
    await expect(
      withTenantTransaction(
        ctx.runtimePool,
        {
          userId: ids.adminA,
          requestedTenantId: ids.tenantA,
          authorize: async () => undefined,
        },
        async (tx) => {
          await tx.query(
            `INSERT INTO learners (tenant_id, admission_no, full_name, gender, created_by)
             VALUES ($1, $2, 'Nested', 'male', $3)`,
            [ids.tenantA, admission, ids.adminA],
          );
          await tx.query("BEGIN");
        },
      ),
    ).rejects.toThrow(/Nested/);
    const left = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM learners WHERE admission_no = $1`,
      [admission],
    );
    expect(left.rows[0]?.n).toBe(0);
  });

  it("maps statement timeout to a safe 503 and records one denial audit", async () => {
    let caught: unknown;
    try {
      await withTenantTransaction(
        ctx.runtimePool,
        {
          userId: ids.adminA,
          requestedTenantId: ids.tenantA,
          authorize: async () => undefined,
          limits: {
            statementTimeoutMs: 50,
            lockTimeoutMs: 5_000,
            idleInTransactionSessionTimeoutMs: 15_000,
          },
        },
        async (tx) => {
          await tx.query(`SELECT pg_sleep(2)`);
        },
      );
    } catch (err) {
      caught = err;
    }
    expect((caught as { code?: string }).code).toBe("57014");
    expect(toClientError(caught).statusCode).toBe(503);
    expect(toClientError(caught).body.error.code).toBe("service_unavailable");
    expect(JSON.stringify(toClientError(caught))).not.toMatch(/pg_sleep|57014/);

    const teacher = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/login-id",
      payload: { tenantId: ids.tenantA, loginId: "TC-0001", password: "correct-horse-battery" },
    });
    expect(teacher.statusCode).toBe(200);
    const before = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM security_audit_events
       WHERE event_type = 'rbac.permission.denied' AND actor_user_id = $1`,
      [ids.teacherA],
    );
    const denied = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: bearer(teacher.json().token as string, ids.tenantA),
      payload: { admission_no: "NO-PERM", full_name: "Denied", gender: "male" },
    });
    expect(denied.statusCode).toBe(403);
    const after = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM security_audit_events
       WHERE event_type = 'rbac.permission.denied' AND actor_user_id = $1`,
      [ids.teacherA],
    );
    expect(after.rows[0]?.n).toBe((before.rows[0]?.n ?? 0) + 1);
  });

  it("persists exactly one audit row for a failed login", async () => {
    const before = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM security_audit_events WHERE event_type = 'auth.login.failure'`,
    );
    const res = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email: "admin-a@example.com", password: "not-the-password" },
    });
    expect(res.statusCode).toBe(401);
    const after = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM security_audit_events WHERE event_type = 'auth.login.failure'`,
    );
    expect(after.rows[0]?.n).toBe((before.rows[0]?.n ?? 0) + 1);
  });

  it("negative control: a widened DELETE grant and a name-keyed owner policy leak, then both are restored", async () => {
    // Phase 3 (017): UPDATE is already granted for lifecycle. Prove DELETE is still denied
    // without an explicit widen, and that a temporary DELETE grant is what the NC removes.
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`GRANT DELETE ON learners TO figbloom_app`);
      await client.query("SET LOCAL ROLE figbloom_app");
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ids.tenantA]);
      await client.query(`DELETE FROM learners WHERE admission_no = 'RLS-A-DOES-NOT-EXIST'`);
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    const runtime = await ctx.runtimePool.connect();
    try {
      await expect(
        runtime.query(`DELETE FROM learners WHERE admission_no = 'RLS-A'`),
      ).rejects.toThrow(/permission denied/i);
    } finally {
      runtime.release();
    }

    await ctx.pool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'figbloom_name_probe') THEN
          REVOKE ALL ON TABLE public.learners FROM figbloom_name_probe;
          REVOKE ALL ON SCHEMA public FROM figbloom_name_probe;
          IF EXISTS (
            SELECT 1 FROM pg_auth_members m
            JOIN pg_roles granted ON granted.oid = m.roleid
            JOIN pg_roles member ON member.oid = m.member
            WHERE granted.rolname = 'figbloom_name_probe' AND member.rolname = current_user
          ) THEN
            REVOKE figbloom_name_probe FROM CURRENT_USER;
          END IF;
          DROP ROLE figbloom_name_probe;
        END IF;
      END $$
    `);
    await ctx.pool.query(`CREATE ROLE figbloom_name_probe NOLOGIN`);
    await ctx.pool.query(`GRANT figbloom_name_probe TO CURRENT_USER`);
    await ctx.pool.query(`GRANT USAGE ON SCHEMA public TO figbloom_name_probe`);
    await ctx.pool.query(`GRANT SELECT ON learners TO figbloom_name_probe`);
    const probe = await ctx.pool.connect();
    try {
      await probe.query("BEGIN");
      await probe.query(
        `CREATE POLICY learners_name_keyed_probe ON learners FOR SELECT TO PUBLIC
         USING (current_user <> 'figbloom_app')`,
      );
      await probe.query("SET LOCAL ROLE figbloom_name_probe");
      const leaked = await probe.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM learners WHERE tenant_id = $1`,
        [ids.tenantB],
      );
      expect(leaked.rows[0]?.n).toBeGreaterThan(0);
      await probe.query("ROLLBACK");
    } finally {
      await probe.query("ROLLBACK").catch(() => undefined);
      probe.release();
      await ctx.pool.query(`REVOKE ALL ON TABLE public.learners FROM figbloom_name_probe`);
      await ctx.pool.query(`REVOKE ALL ON SCHEMA public FROM figbloom_name_probe`);
      await ctx.pool.query(`REVOKE figbloom_name_probe FROM CURRENT_USER`);
      await ctx.pool.query(`DROP ROLE figbloom_name_probe`);
    }
  });

  it("negative control: without FORCE RLS the other tenant becomes visible, then the protection is restored", async () => {
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE learners DISABLE ROW LEVEL SECURITY`);
      await client.query("SET LOCAL ROLE figbloom_app");
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ids.tenantA]);
      const leaked = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM learners WHERE tenant_id = $1`,
        [ids.tenantB],
      );
      expect(leaked.rows[0]?.n).toBeGreaterThan(0);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const restored = await ctx.runtimePool.connect();
    try {
      await restored.query("BEGIN");
      await restored.query(`SELECT set_config('app.tenant_id', $1, true)`, [ids.tenantA]);
      const hidden = await restored.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM learners WHERE tenant_id = $1`,
        [ids.tenantB],
      );
      expect(hidden.rows[0]?.n).toBe(0);
      await restored.query("ROLLBACK");
    } finally {
      restored.release();
    }
  });
});
