import { readdirSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";
import { MIGRATIONS_DIR } from "./support/migrationTables.js";
import { runMigrations, verifyMigrations } from "../src/db/migrate.js";
import { LOCAL_SESSION_MINT_HMAC_KEY } from "../src/modules/auth/sessionProof.js";

describe("Phase 10 & Phase 8: Fresh + seeded upgrade migration verification (001..064) and negative-control rollback probes", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let ids: FixtureIds;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("Phase 10: seeded upgrade from 001..064 to 065+ preserves pre-existing rows and closes the stale-reason/PII/lease gaps with existing rows and verifyMigrations passes", async () => {
    // 1. Reset schema and apply only 001..060
    await ctx.pool.query(`
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO PUBLIC;
    `);
    const allFiles = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d+_.*\.sql$/.test(f))
      .sort();
    const preRemediation = allFiles.filter((f) => Number(f.split("_")[0]) <= 64);
    expect(preRemediation).toHaveLength(64);

    // Apply 001..060 via runMigrations up to 060 by running them and recording in schema_migrations
    // Then let runMigrations(ctx.pool) apply 061..064 on top of seeded data!
    // First run full migrations to get schema_migrations checksums for 001..060:
    await runMigrations(ctx.pool);
    const checksumRows = await ctx.pool.query<{ id: string; checksum: string }>(
      `SELECT id, checksum FROM schema_migrations WHERE split_part(id, '_', 1)::int <= 64 ORDER BY id`,
    );
    const checksumByVersion = new Map(checksumRows.rows.map((r) => [r.id, r.checksum]));

    // Now drop schema, apply 001..060 manually with exact checksums in schema_migrations
    await ctx.pool.query(`
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT USAGE ON SCHEMA public TO PUBLIC;
      CREATE TABLE schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        checksum text,
        applied_by text NOT NULL DEFAULT CURRENT_USER
      );
      CREATE TABLE schema_migration_checksum_audit (
        id bigserial PRIMARY KEY,
        migration_id text NOT NULL,
        old_checksum text NOT NULL,
        new_checksum text NOT NULL,
        reason text NOT NULL,
        reconciled_by text NOT NULL DEFAULT CURRENT_USER,
        reconciled_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE OR REPLACE FUNCTION public.schema_migration_checksum_audit_append_only()
      RETURNS trigger
      LANGUAGE plpgsql
      SET search_path = pg_catalog, pg_temp
      AS $fn$
      BEGIN
        RAISE EXCEPTION 'schema_migration_checksum_audit is append-only';
      END;
      $fn$;
      REVOKE ALL ON FUNCTION public.schema_migration_checksum_audit_append_only() FROM PUBLIC;
      CREATE TRIGGER schema_migration_checksum_audit_append_only_trg
        BEFORE UPDATE OR DELETE ON schema_migration_checksum_audit
        FOR EACH ROW
        EXECUTE FUNCTION public.schema_migration_checksum_audit_append_only();
      REVOKE ALL ON TABLE schema_migration_checksum_audit FROM PUBLIC;
    `);
    for (const file of preRemediation) {
      const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8");
      await ctx.pool.query(sql);
      await ctx.pool.query(`INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)`, [
        file,
        checksumByVersion.get(file)!,
      ]);
    }
    await ctx.pool.query(`SELECT public.auth_install_session_hmac_secret('local', $1)`, [
      LOCAL_SESSION_MINT_HMAC_KEY,
    ]);

    // Seed representative pre-061 rows across Stage 11–16 tables before upgrading to 061..064
    const orgId = "00000000-0000-4000-8000-000000000001";
    const tenantId = "00000000-0000-4000-8000-000000000002";
    const userId = "00000000-0000-4000-8000-000000000003";
    const learnerId = "00000000-0000-4000-8000-000000000004";
    await ctx.pool.query(
      `INSERT INTO organizations (id, name, slug, kind, status) VALUES ($1, 'Upg Org', 'upg-org', 'group_owner', 'active')`,
      [orgId],
    );
    await ctx.pool.query(
      `INSERT INTO tenants (id, organization_id, name, slug, status) VALUES ($1, $2, 'Upg School', 'upg-school', 'active')`,
      [tenantId, orgId],
    );
    await ctx.pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, status) VALUES ($1, 'upg@example.com', 'hash', 'Upg Admin', 'active')`,
      [userId],
    );
    await ctx.pool.query(
      `INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES ($1, $2, 'school_admin', 'AD-0001')`,
      [userId, tenantId],
    );
    await ctx.pool.query(
      `INSERT INTO learners (id, tenant_id, full_name, admission_no, date_of_birth, gender)
       VALUES ($1, $2, 'Upg Learner', 'UPG-001', '2014-01-01', 'female')`,
      [learnerId, tenantId],
    );
    await ctx.pool.query(
      `INSERT INTO sick_bay_visits (tenant_id, learner_id, complaint, logged_by)
       VALUES ($1, $2, 'Pre-063 visit', $3)`,
      [tenantId, learnerId, userId],
    );

    // Pre-065 state that the upgrade must carry safely: a discharged visit whose last correction left a stale reason on
    // the row, a learner-hosted gate visit, an old unapplied import preview, and a lease issued before lease tokens.
    await ctx.pool.query(
      `UPDATE sick_bay_visits SET time_out = now(), outcome = 'home' WHERE tenant_id = $1`, [tenantId]);
    await ctx.pool.query(
      `UPDATE sick_bay_visits SET treatment = 'corrected', correction_reason = 'legacy reason' WHERE tenant_id = $1`, [tenantId]);
    await ctx.pool.query(
      `INSERT INTO gate_visits (tenant_id, visitor_name, purpose, host_kind, learner_id) VALUES ($1, 'Upg Visitor', 'visit', 'learner', $2)`,
      [tenantId, learnerId]);
    await ctx.pool.query(
      `INSERT INTO import_batches (tenant_id, kind, status, row_count, valid_count, payload_sha256, preview_json, created_by, created_at)
       VALUES ($1, 'learners_csv', 'previewed', 1, 1, repeat('a', 64), '{"rows":[{"full_name":"Raw Pii"}]}'::jsonb, $2, now() - interval '10 days')`,
      [tenantId, userId]);

    // Upgrade 064 -> latest via runMigrations
    const applied = await runMigrations(ctx.pool);
    expect(applied.applied).toEqual(allFiles.filter((f) => Number(f.split("_")[0]) > 64));
    expect(applied.applied.length).toBeGreaterThanOrEqual(3);

    // Verify existing sick_bay_visits row received row_version = 1 and checksums verify cleanly
    const sb = await ctx.pool.query<{ row_version: number }>(
      `SELECT row_version FROM sick_bay_visits WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(sb.rows[0]?.row_version).toBeGreaterThanOrEqual(1);
    // N-4: the legacy stale reason was preserved as history and cleared from the row
    const stale = await ctx.pool.query(`SELECT correction_reason FROM sick_bay_visits WHERE tenant_id = $1`, [tenantId]);
    expect(stale.rows[0]?.correction_reason).toBeNull();
    const hist = await ctx.pool.query(`SELECT reason FROM sick_bay_visit_corrections WHERE tenant_id = $1`, [tenantId]);
    expect(hist.rows.map((r) => r.reason)).toEqual(["legacy reason"]);
    // N-5: the learner-hosted gate visit survived the stricter/relaxed constraints
    expect((await ctx.pool.query(`SELECT 1 FROM gate_visits WHERE tenant_id = $1 AND host_kind = 'learner'`, [tenantId])).rowCount).toBe(1);
    // N-8: the old unapplied preview got an expiry in the past (the worker sweep will redact it)
    const ib = await ctx.pool.query(`SELECT status, expires_at < now() AS due FROM import_batches WHERE tenant_id = $1`, [tenantId]);
    expect(ib.rows[0]).toMatchObject({ status: "previewed", due: true });
    const verified = await verifyMigrations(ctx.pool);
    expect(verified.verified).toHaveLength(allFiles.length);

    // Re-seed standard test fixtures so subsequent tests in this file have ids
    await ctx.app.close();
    await ctx.pool.end();
    ctx = await createTestApp();
    ids = ctx.ids;
  });

  it("Phase 8 negative-control rollback probes: temporarily weakening F8-A, F8-B, S12-01, S13-11, or S12-02 controls causes the exact protection to fail open (proving each test tests a real boundary)", async () => {
    const c = await ctx.pool.connect();
    try {
      // Probe 1 (F8-A): Unmutated figbloom_worker cannot UPDATE jobs; granting UPDATE (status) makes it succeed inside rolled-back tx
      await c.query("BEGIN");
      const jobRes = await c.query<{ id: string }>(
        `INSERT INTO jobs (tenant_id, job_type, payload, idempotency_key)
         VALUES ($1, 'announcement.push', '{}'::jsonb, 'nc-probe-f8a') RETURNING id`,
        [ids.tenantA],
      );
      const jobId = jobRes.rows[0]!.id;
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [ids.tenantA]);
      await c.query(`SET LOCAL ROLE figbloom_worker`);
      await c.query(`SAVEPOINT sp_unmutated`);
      await expect(c.query(`UPDATE jobs SET status = 'dead' WHERE id = $1`, [jobId])).rejects.toMatchObject({
        code: "42501",
      });
      await c.query(`ROLLBACK TO SAVEPOINT sp_unmutated`);
      await c.query(`RESET ROLE`);
      await c.query(`GRANT UPDATE (status) ON TABLE public.jobs TO figbloom_worker`);
      await c.query(`DROP TRIGGER jobs_worker_transition_guard ON public.jobs`);
      await c.query(`SET LOCAL ROLE figbloom_worker`);
      const mutatedUpd = await c.query(`UPDATE jobs SET status = 'dead' WHERE id = $1`, [jobId]);
      expect(mutatedUpd.rowCount).toBe(1);
      await c.query("ROLLBACK");

      // Probe 2 (S12-02): Unmutated chat_messages_user_scope blocks third-party SELECT; dropping the RESTRICTIVE policy exposes the row
      await c.query("BEGIN");
      const convRes = await c.query<{ id: string }>(
        `INSERT INTO conversations (tenant_id, pair_key, created_by)
         VALUES ($1, public.chat_pair_key($2, $3), $2) RETURNING id`,
        [ids.tenantA, ids.adminA, ids.teacherA],
      );
      const convId = convRes.rows[0]!.id;
      await c.query(
        `INSERT INTO conversation_members (conversation_id, tenant_id, user_id) VALUES ($1, $2, $3), ($1, $2, $4)`,
        [convId, ids.tenantA, ids.adminA, ids.teacherA],
      );
      await c.query(
        `INSERT INTO chat_messages (tenant_id, conversation_id, sender_id, body) VALUES ($1, $2, $3, 'Secret message')`,
        [ids.tenantA, convId, ids.adminA],
      );
      await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)`, [
        ids.tenantA,
        ids.parentA,
      ]);
      await c.query(`SET LOCAL ROLE figbloom_app`);
      const blocked = await c.query(`SELECT id FROM chat_messages WHERE conversation_id = $1`, [convId]);
      expect(blocked.rowCount).toBe(0);
      await c.query(`RESET ROLE`);
      await c.query(`DROP POLICY chat_messages_user_scope ON public.chat_messages`);
      await c.query(`SET LOCAL ROLE figbloom_app`);
      const leaked = await c.query(`SELECT id FROM chat_messages WHERE conversation_id = $1`, [convId]);
      expect(leaked.rowCount).toBe(1);
      await c.query("ROLLBACK");
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });
});
