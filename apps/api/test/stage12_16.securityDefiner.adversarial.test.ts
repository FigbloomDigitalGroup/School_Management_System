import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";
import { enableWorkerLogin, resetWorkerLogin } from "./support/financeHarness.js";
import { createPool, workerPoolOptions } from "../src/db/pool.js";

describe("Stage 12–16 SECURITY DEFINER & helper adversarial verification (S12-01, S12-10, S12-12, S13-11, S13-02)", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;
  let workerLogin: Awaited<ReturnType<typeof enableWorkerLogin>> | undefined;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    workerLogin = await enableWorkerLogin(ctx.pool, ctx.runtimeUrl);
  }, 120_000);

  afterAll(async () => {
    if (workerLogin) await workerLogin.end().catch(() => undefined);
    await resetWorkerLogin(ctx.pool).catch(() => undefined);
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("S12-01: communications_audience_reaches refuses cross-tenant and third-party user oracle probes as figbloom_app", async () => {
    const c = await ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [
        ids.tenantA,
        ids.adminA,
      ]);

      // Legitimate self evaluation succeeds
      const selfOk = await c.query<{ ok: boolean }>(
        `SELECT public.communications_audience_reaches($1, '{"kind":"whole_school"}'::jsonb, $2) AS ok`,
        [ids.tenantA, ids.adminA],
      );
      expect(selfOk.rows[0]?.ok).toBe(true);

      // Cross-tenant probe (tenantB while session GUC is tenantA) -> 42501
      await c.query("SAVEPOINT sp1");
      await expect(
        c.query(
          `SELECT public.communications_audience_reaches($1, '{"kind":"whole_school"}'::jsonb, $2)`,
          [ids.tenantB, ids.adminA],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query("ROLLBACK TO SAVEPOINT sp1");

      // Third-party user probe in same tenant (probing teacherA while session user is adminA) -> 42501
      await c.query("SAVEPOINT sp2");
      await expect(
        c.query(
          `SELECT public.communications_audience_reaches($1, '{"kind":"role","role":"teacher"}'::jsonb, $2)`,
          [ids.tenantA, ids.teacherA],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query("ROLLBACK TO SAVEPOINT sp2");

      // Temp-table shadowing probe: figbloom_app is denied TEMP table creation (42501) and role check uses public.school_memberships
      await c.query("SAVEPOINT sp3");
      await expect(
        c.query(`CREATE TEMP TABLE school_memberships (tenant_id uuid, user_id uuid, role text, archived_at timestamptz)`),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query("ROLLBACK TO SAVEPOINT sp3");
      const roleCheck = await c.query<{ ok: boolean }>(
        `SELECT public.communications_audience_reaches($1, '{"kind":"role","role":"teacher"}'::jsonb, $2) AS ok`,
        [ids.tenantA, ids.adminA],
      );
      expect(roleCheck.rows[0]?.ok).toBe(false);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });

  it("S12-01: may_talk refuses cross-tenant and third-party user pair enumeration as figbloom_app", async () => {
    const c = await ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [
        ids.tenantA,
        ids.adminA,
      ]);

      // Legitimate self-included pair check succeeds
      const ownPair = await c.query<{ ok: boolean }>(`SELECT public.may_talk($1, $2, $3) AS ok`, [
        ids.tenantA,
        ids.adminA,
        ids.teacherA,
      ]);
      expect(ownPair.rows[0]?.ok).toBe(true);

      // Cross-tenant probe -> 42501
      await c.query("SAVEPOINT sp1");
      await expect(
        c.query(`SELECT public.may_talk($1, $2, $3)`, [ids.tenantB, ids.adminA, ids.teacherB]),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query("ROLLBACK TO SAVEPOINT sp1");

      // Third-party pair probe in same tenant (adminA probing whether teacherA and parentA may talk) -> 42501
      await c.query("SAVEPOINT sp2");
      await expect(
        c.query(`SELECT public.may_talk($1, $2, $3)`, [ids.tenantA, ids.teacherA, ids.parentA]),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query("ROLLBACK TO SAVEPOINT sp2");
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });

  it("S13-11 & S13-02: inventory_out_count is SECURITY INVOKER, enforces RLS tenant isolation, and counts out + lost + damaged", async () => {
    // Seed an item and issues in tenantA as owner
    const itemRes = await ctx.pool.query<{ id: string }>(
      `INSERT INTO inventory_items (tenant_id, name, category, tracking, quantity)
       VALUES ($1, 'Oracle Probe Textbooks', 'textbooks', 'stock', 10)
       RETURNING id`,
      [ids.tenantA],
    );
    const itemId = itemRes.rows[0]!.id;

    // Issue 2 (out), 1 (lost), 1 (damaged), 3 (returned)
    await ctx.pool.query(
      `INSERT INTO inventory_issues (tenant_id, item_id, holder_user_id, quantity)
       VALUES ($1, $2, $3, 2)`,
      [ids.tenantA, itemId, ids.teacherA],
    );
    const lostIssue = await ctx.pool.query<{ id: string }>(
      `INSERT INTO inventory_issues (tenant_id, item_id, holder_user_id, quantity)
       VALUES ($1, $2, $3, 1) RETURNING id`,
      [ids.tenantA, itemId, ids.teacherA],
    );
    await ctx.pool.query(`UPDATE inventory_issues SET status = 'lost' WHERE id = $1`, [lostIssue.rows[0]!.id]);

    const damagedIssue = await ctx.pool.query<{ id: string }>(
      `INSERT INTO inventory_issues (tenant_id, item_id, holder_user_id, quantity)
       VALUES ($1, $2, $3, 1) RETURNING id`,
      [ids.tenantA, itemId, ids.teacherA],
    );
    await ctx.pool.query(`UPDATE inventory_issues SET status = 'damaged' WHERE id = $1`, [damagedIssue.rows[0]!.id]);

    const returnedIssue = await ctx.pool.query<{ id: string }>(
      `INSERT INTO inventory_issues (tenant_id, item_id, holder_user_id, quantity)
       VALUES ($1, $2, $3, 3) RETURNING id`,
      [ids.tenantA, itemId, ids.teacherA],
    );
    await ctx.pool.query(`UPDATE inventory_issues SET status = 'returned' WHERE id = $1`, [returnedIssue.rows[0]!.id]);

    const c = await ctx.runtimePool.connect();
    try {
      // 1. Under tenantB session, probing tenantA's itemId returns 0 (RLS hides tenantA rows!)
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [
        ids.tenantB,
        ids.teacherB,
      ]);
      const foreignProbe = await c.query<{ n: number }>(`SELECT public.inventory_out_count($1) AS n`, [itemId]);
      expect(foreignProbe.rows[0]?.n).toBe(0);
      await c.query("COMMIT");

      // 2. Under tenantA session, returns 2 (out) + 1 (lost) + 1 (damaged) = 4 (returned 3 excluded)
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [
        ids.tenantA,
        ids.adminA,
      ]);
      const ownCount = await c.query<{ n: number }>(`SELECT public.inventory_out_count($1) AS n`, [itemId]);
      expect(ownCount.rows[0]?.n).toBe(4);
      await c.query("COMMIT");
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });

  it("S12-10: device_tokens_register enforces app_current_user_id() and audits cross-user token reclamation", async () => {
    const token = "fcm-shared-device-token-0123456789abcdef";
    const c = await ctx.runtimePool.connect();
    try {
      // Spoofed user id rejected with 42501
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.user_id', $1, true)", [ids.adminA]);
      await expect(
        c.query(`SELECT public.device_tokens_register($1, $2, 'android')`, [ids.teacherA, token]),
      ).rejects.toMatchObject({ code: "42501" });
      await c.query("ROLLBACK");

      // Admin A registers token
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.user_id', $1, true)", [ids.adminA]);
      await c.query(`SELECT public.device_tokens_register($1, $2, 'android')`, [ids.adminA, token]);
      await c.query("COMMIT");

      // Teacher A reclaims the same token
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.user_id', $1, true)", [ids.teacherA]);
      const reclaimed = await c.query<{ id: string }>(
        `SELECT public.device_tokens_register($1, $2, 'android') AS id`,
        [ids.teacherA, token],
      );
      await c.query("COMMIT");

      const audit = await ctx.pool.query<{ actor_user_id: string; detail: Record<string, unknown> }>(
        `SELECT actor_user_id, detail FROM security_audit_events
          WHERE event_type = 'communications.device_token.reclaimed'
            AND detail->>'deviceTokenId' = $1`,
        [reclaimed.rows[0]!.id],
      );
      expect(audit.rows.length).toBe(1);
      expect(audit.rows[0]?.actor_user_id).toBe(ids.teacherA);
      expect(audit.rows[0]?.detail.previousUserId).toBe(ids.adminA);
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });

  it("S12-01 & S12-12: figbloom_worker cannot execute app-only DEFINERs and figbloom_app cannot execute worker-only push helper", async () => {
    const appClient = await ctx.runtimePool.connect();
    try {
      await expect(
        appClient.query(`SELECT public.communications_announcement_push_eligible_count(gen_random_uuid())`),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      appClient.release();
    }

    const wPool = createPool(
      workerPoolOptions({
        databaseUrl: workerLogin!.connectionString,
        poolMax: 1,
        poolAcquireTimeoutMs: 2_000,
        statementTimeoutMs: 5_000,
        lockTimeoutMs: 2_000,
        idleInTransactionSessionTimeoutMs: 5_000,
        clientQueryTimeoutMs: 8_000,
        applicationName: "figbloom-secdef-worker-probe",
      }),
    );
    try {
      await expect(
        wPool.query(`SELECT public.communications_audience_reaches($1, '{"kind":"whole_school"}'::jsonb, $2)`, [
          ids.tenantA,
          ids.adminA,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        wPool.query(`SELECT public.may_talk($1, $2, $3)`, [ids.tenantA, ids.adminA, ids.teacherA]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        wPool.query(`SELECT public.device_tokens_register($1, 'token-0123456789abcdef', 'android')`, [ids.adminA]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await wPool.end().catch(() => undefined);
    }
  });
});
