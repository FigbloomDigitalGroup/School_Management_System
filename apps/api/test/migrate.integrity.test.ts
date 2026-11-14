import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import {
  canonicalizeSql,
  checksumSql,
  hashCanonicalSql,
  legacyCrlfChecksumFromCanonical,
  LEGACY_CRLF_RECONCILE_REASON,
  MIGRATION_LOCK_KEY,
  MigrationLockTimeoutError,
  NULL_CHECKSUM_BACKFILL_REASON,
  resolveMigrationsDir,
  runMigrations,
  verifyMigrations,
} from "../src/db/migrate.js";
import { loadConfig, MIGRATIONS_DIR } from "../src/config.js";
import { assertIsolatedTestDatabase } from "./support.js";

const { Pool } = pg;

describe("FIG-1610 migration integrity", () => {
  let pool: pg.Pool;
  let scratchDir: string;

  beforeAll(async () => {
    process.env.DATABASE_URL ??= "postgresql://postgres:postgres@127.0.0.1:58322/figbloom_api";
    const config = loadConfig();
    assertIsolatedTestDatabase(config.databaseUrl);
    pool = new Pool({ connectionString: config.databaseUrl });
    await pool.query(`
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO postgres;
      GRANT ALL ON SCHEMA public TO public;
    `);
    scratchDir = mkdtempSync(join(tmpdir(), "figbloom-migrate-"));
  });

  afterAll(async () => {
    rmSync(scratchDir, { recursive: true, force: true });
    await pool.end();
  });

  async function resetPublic(): Promise<void> {
    await pool.query(`
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
      GRANT ALL ON SCHEMA public TO postgres;
      GRANT ALL ON SCHEMA public TO public;
    `);
  }

  it("canonicalizes CRLF to LF only and leaves lone CR distinct", () => {
    const lf = "SELECT 1;\nSELECT 2;\n";
    const crlf = "SELECT 1;\r\nSELECT 2;\r\n";
    const loneCr = "SELECT 1;\rSELECT 2;\n";
    const multiCr = "SELECT 1;\r\r\rSELECT 2;\n";
    expect(canonicalizeSql(crlf)).toBe(lf);
    expect(canonicalizeSql(loneCr)).toBe(loneCr);
    expect(canonicalizeSql(multiCr)).toBe(multiCr);
    expect(checksumSql(lf)).toBe(checksumSql(crlf));
    expect(checksumSql(loneCr)).not.toBe(checksumSql(lf));
    expect(checksumSql(multiCr)).not.toBe(checksumSql(lf));
    expect(checksumSql("a")).toBe(createHash("sha256").update("a", "utf8").digest("hex"));
    expect(hashCanonicalSql(canonicalizeSql(lf))).toBe(checksumSql(lf));
  });

  it("M-1: stray CR immediately before a line ending is not collapsed by hashing", () => {
    const lf = "CREATE TABLE t_h1 (v text);\nINSERT INTO t_h1 VALUES ('a\nb');\n";
    // CR placed immediately before what becomes a line ending after one CRLF pass.
    const strayBeforeEol = "CREATE TABLE t_h1 (v text);\nINSERT INTO t_h1 VALUES ('a\r\r\nb');\n";
    const once = canonicalizeSql(strayBeforeEol);
    const twice = canonicalizeSql(once);
    expect(once).not.toBe(lf);
    expect(once.includes("\r")).toBe(true);
    // Second pass would hide the defect — hashing must use the first-pass bytes only.
    expect(twice).toBe(lf);
    expect(checksumSql(strayBeforeEol)).not.toBe(checksumSql(lf));
    expect(hashCanonicalSql(once)).not.toBe(hashCanonicalSql(lf));
    // Double-hashing of already-canonicalized text must not re-normalize.
    expect(hashCanonicalSql(once)).not.toBe(checksumSql(once));
  });

  it("same logical content with CRLF and LF yields the same recorded checksum on apply", async () => {
    await resetPublic();
    const dir = join(scratchDir, "crlf-lf");
    mkdirSync(dir, { recursive: true });
    const body = "CREATE TABLE t_crlf_lf (id int);\n";
    writeFileSync(join(dir, "001_a.sql"), body.replace(/\n/g, "\r\n"), "utf8");

    const first = await runMigrations(pool, { migrationsDir: dir });
    expect(first.applied).toEqual(["001_a.sql"]);
    const row = await pool.query<{ checksum: string }>(
      `SELECT checksum FROM schema_migrations WHERE id = '001_a.sql'`,
    );
    expect(row.rows[0]?.checksum).toBe(checksumSql(body));

    // Re-write as LF and re-run: skip, no reconcile.
    writeFileSync(join(dir, "001_a.sql"), body, "utf8");
    const second = await runMigrations(pool, { migrationsDir: dir });
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(["001_a.sql"]);
    expect(second.reconciled).toEqual([]);
  });

  it("fresh DB applies real migrations and second run is a no-op", async () => {
    await resetPublic();
    const first = await runMigrations(pool);
    expect(first.applied.length).toBeGreaterThanOrEqual(8);
    const second = await runMigrations(pool);
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBe(first.applied.length);
    const verify = await verifyMigrations(pool);
    expect(verify.reconcileCandidates).toEqual([]);
    expect(verify.verified.length).toBe(first.applied.length);
  });

  it("reconciles legacy CRLF-recorded checksums with an append-only audit row", async () => {
    await resetPublic();
    await runMigrations(pool);
    const file = "002_audit_hardening.sql";
    const canonical = canonicalizeSql(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    const canonicalSum = checksumSql(canonical);
    const legacySum = legacyCrlfChecksumFromCanonical(canonical);
    expect(legacySum).not.toBe(canonicalSum);

    await pool.query(`UPDATE schema_migrations SET checksum = $2 WHERE id = $1`, [
      file,
      legacySum,
    ]);

    const verifyOnly = await verifyMigrations(pool, { reconcile: false });
    expect(verifyOnly.reconcileCandidates).toContain(file);
    expect(verifyOnly.reconciled).toEqual([]);
    const stillLegacy = await pool.query<{ checksum: string }>(
      `SELECT checksum FROM schema_migrations WHERE id = $1`,
      [file],
    );
    expect(stillLegacy.rows[0]?.checksum).toBe(legacySum);

    const applied = await runMigrations(pool);
    expect(applied.reconciled).toContain(file);
    const after = await pool.query<{ checksum: string }>(
      `SELECT checksum FROM schema_migrations WHERE id = $1`,
      [file],
    );
    expect(after.rows[0]?.checksum).toBe(canonicalSum);

    const audit = await pool.query<{
      old_checksum: string;
      new_checksum: string;
      reason: string;
    }>(
      `SELECT old_checksum, new_checksum, reason FROM schema_migration_checksum_audit
       WHERE migration_id = $1 ORDER BY id DESC LIMIT 1`,
      [file],
    );
    expect(audit.rows[0]).toMatchObject({
      old_checksum: legacySum,
      new_checksum: canonicalSum,
      reason: LEGACY_CRLF_RECONCILE_REASON,
    });

    await expect(
      pool.query(`UPDATE schema_migration_checksum_audit SET reason = 'x' WHERE migration_id = $1`, [
        file,
      ]),
    ).rejects.toThrow(/append-only/i);

    const noop = await runMigrations(pool);
    expect(noop.reconciled).toEqual([]);
  });

  it("fails hard on a one-character content change and on non-matching old hash", async () => {
    await resetPublic();
    await runMigrations(pool);
    const file = "001_identity_tenancy_rbac.sql";
    await pool.query(`UPDATE schema_migrations SET checksum = $2 WHERE id = $1`, [
      file,
      "0".repeat(64),
    ]);
    await expect(runMigrations(pool)).rejects.toThrow(/already applied with checksum/i);

    // Restore to a plausible but non-legacy hash (canonical with one char flipped in the digest space).
    const canonical = checksumSql(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    const bogus = canonical.replace(/[0-9a-f]/, (c) => (c === "0" ? "1" : "0"));
    await pool.query(`UPDATE schema_migrations SET checksum = $2 WHERE id = $1`, [file, bogus]);
    await expect(runMigrations(pool)).rejects.toThrow(/already applied with checksum/i);
  });

  it("fails hard for a lone-CR variant (not legacy CRLF)", async () => {
    await resetPublic();
    const dir = join(scratchDir, "lone-cr");
    mkdirSync(dir, { recursive: true });
    const lf = "CREATE TABLE t_lone (id int);\n";
    writeFileSync(join(dir, "001_lone.sql"), lf, "utf8");
    await runMigrations(pool, { migrationsDir: dir });

    const loneCr = "CREATE TABLE t_lone (id int);\r";
    // Stored checksum stays canonical LF; file becomes lone-CR-only ending → different hash, not legacy CRLF.
    writeFileSync(join(dir, "001_lone.sql"), loneCr, "utf8");
    await expect(runMigrations(pool, { migrationsDir: dir })).rejects.toThrow(
      /already applied with checksum/i,
    );
  });

  it("does not reconcile when the old hash is not the exact CRLF re-encoding", async () => {
    await resetPublic();
    await runMigrations(pool);
    const file = "003_r2_remediation.sql";
    const canonical = canonicalizeSql(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    // Hash of CRLF content with an extra trailing byte — not the exact re-encoding.
    const almost = createHash("sha256")
      .update(canonical.replace(/\n/g, "\r\n") + "x", "utf8")
      .digest("hex");
    await pool.query(`UPDATE schema_migrations SET checksum = $2 WHERE id = $1`, [file, almost]);
    await expect(runMigrations(pool)).rejects.toThrow(/already applied with checksum/i);
  });

  it("rolls back a failed migration and leaves no schema_migrations row", async () => {
    await resetPublic();
    const dir = join(scratchDir, "rollback");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "001_ok.sql"), "CREATE TABLE t_ok (id int);\n", "utf8");
    writeFileSync(join(dir, "002_bad.sql"), "THIS IS NOT VALID SQL;\n", "utf8");
    await expect(runMigrations(pool, { migrationsDir: dir })).rejects.toThrow(
      /002_bad\.sql failed and was rolled back/i,
    );
    const rows = await pool.query(`SELECT id FROM schema_migrations ORDER BY id`);
    expect(rows.rows.map((r) => r.id)).toEqual(["001_ok.sql"]);
    const badTable = await pool.query(
      `SELECT to_regclass('public.t_ok') AS ok, to_regclass('public.t_bad') AS bad`,
    );
    expect(badTable.rows[0]?.ok).toBeTruthy();
  });

  it("serializes two concurrent migrators via the advisory lock", async () => {
    await resetPublic();
    const dir = join(scratchDir, "concurrent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "001_slow.sql"),
      "CREATE TABLE IF NOT EXISTS t_concurrent (id int);\n",
      "utf8",
    );

    const a = runMigrations(pool, { migrationsDir: dir });
    const b = runMigrations(pool, { migrationsDir: dir });
    const results = await Promise.all([a, b]);
    const appliedTotal = results.reduce((n, r) => n + r.applied.length, 0);
    expect(appliedTotal).toBe(1);
    const count = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM schema_migrations WHERE id = '001_slow.sql'`,
    );
    expect(count.rows[0]?.n).toBe("1");
    expect(MIGRATION_LOCK_KEY).toBe(157301);
  });

  it("migrate:verify fails when an applied migration file is missing from disk", async () => {
    await resetPublic();
    const dir = join(scratchDir, "missing");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "001_x.sql"), "CREATE TABLE t_missing (id int);\n", "utf8");
    await runMigrations(pool, { migrationsDir: dir });
    rmSync(join(dir, "001_x.sql"));
    await expect(verifyMigrations(pool, { migrationsDir: dir })).rejects.toThrow(/missing from disk/i);
  });

  it("resolves migrations dir from src layout and exposes config MIGRATIONS_DIR", () => {
    const resolved = resolveMigrationsDir();
    expect(resolved).toBe(MIGRATIONS_DIR);
    expect(resolved.replace(/\\/g, "/")).toMatch(/apps\/api\/migrations$/);
    // Simulate a dist/db/migrate.js URL by resolving from a nested path under apps/api.
    const fakeDist = resolve(MIGRATIONS_DIR, "..", "dist", "db", "migrate.js");
    const fromDist = resolveMigrationsDir(
      // fileURL needs a file:// URL
      new URL(`file:///${fakeDist.replace(/\\/g, "/")}`).href,
    );
    expect(fromDist).toBe(MIGRATIONS_DIR);
  });

  it(".gitattributes enforces LF for apps/api/migrations/*.sql", () => {
    const root = resolve(MIGRATIONS_DIR, "..", "..", "..");
    const attrs = readFileSync(join(root, ".gitattributes"), "utf8");
    expect(attrs).toMatch(/apps\/api\/migrations\/\*\.sql\s+text\s+eol=lf/);
  });

  it("negative control: overly lenient normalization would hide lone-CR drift", () => {
    const lf = "SELECT 1;\n";
    const loneCr = "SELECT 1;\r";
    const strict = (s: string) => s.replace(/\r\n/g, "\n");
    const tooLenient = (s: string) => s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const hash = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

    expect(hash(strict(lf))).not.toBe(hash(strict(loneCr)));
    // If we had normalized lone CR away, the drift test would incorrectly pass:
    expect(hash(tooLenient(lf))).toBe(hash(tooLenient(loneCr)));
  });

  it("M-1: runMigrations refuses a stray-CR-before-EOL edit of an applied migration", async () => {
    await resetPublic();
    const dir = join(scratchDir, "h1-stray");
    mkdirSync(dir, { recursive: true });
    const lf = "CREATE TABLE t_h1b (v text);\nINSERT INTO t_h1b VALUES ('a\nb');\n";
    const edited = "CREATE TABLE t_h1b (v text);\nINSERT INTO t_h1b VALUES ('a\r\r\nb');\n";
    writeFileSync(join(dir, "001_h1.sql"), lf, "utf8");
    await runMigrations(pool, { migrationsDir: dir });
    writeFileSync(join(dir, "001_h1.sql"), edited, "utf8");
    await expect(runMigrations(pool, { migrationsDir: dir })).rejects.toThrow(
      /already applied with checksum/i,
    );
    await expect(verifyMigrations(pool, { migrationsDir: dir })).rejects.toThrow(
      /already applied with checksum/i,
    );
  });

  it("H-1: successful reconciliation writes checksum and audit atomically", async () => {
    await resetPublic();
    const dir = join(scratchDir, "m1-ok");
    mkdirSync(dir, { recursive: true });
    const body = "CREATE TABLE t_m1_ok (id int);\n";
    writeFileSync(join(dir, "001_m1.sql"), body, "utf8");
    await runMigrations(pool, { migrationsDir: dir });
    const canonical = canonicalizeSql(body);
    const canonicalSum = hashCanonicalSql(canonical);
    const legacy = legacyCrlfChecksumFromCanonical(canonical);
    await pool.query(`UPDATE schema_migrations SET checksum = $1 WHERE id = '001_m1.sql'`, [
      legacy,
    ]);

    const result = await runMigrations(pool, { migrationsDir: dir });
    expect(result.reconciled).toEqual(["001_m1.sql"]);
    const row = await pool.query<{ checksum: string }>(
      `SELECT checksum FROM schema_migrations WHERE id = '001_m1.sql'`,
    );
    expect(row.rows[0]?.checksum).toBe(canonicalSum);
    const audit = await pool.query(
      `SELECT old_checksum, new_checksum, reason FROM schema_migration_checksum_audit
       WHERE migration_id = '001_m1.sql'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      old_checksum: legacy,
      new_checksum: canonicalSum,
      reason: LEGACY_CRLF_RECONCILE_REASON,
    });
  });

  it("H-1: audit insert failure rolls back checksum (no silent reconcile)", async () => {
    await resetPublic();
    const dir = join(scratchDir, "m1-audit-fail");
    mkdirSync(dir, { recursive: true });
    const body = "CREATE TABLE t_m1_af (id int);\n";
    writeFileSync(join(dir, "001_af.sql"), body, "utf8");
    await runMigrations(pool, { migrationsDir: dir });
    const canonical = canonicalizeSql(body);
    const legacy = legacyCrlfChecksumFromCanonical(canonical);
    await pool.query(`UPDATE schema_migrations SET checksum = $1 WHERE id = '001_af.sql'`, [
      legacy,
    ]);

    await pool.query(`
      CREATE OR REPLACE FUNCTION public.figbloom_test_fail_audit_ins()
      RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        RAISE EXCEPTION 'simulated audit insert failure';
      END;
      $fn$
    `);
    await pool.query(`
      CREATE TRIGGER figbloom_test_fail_audit_ins
        BEFORE INSERT ON schema_migration_checksum_audit
        FOR EACH ROW EXECUTE FUNCTION public.figbloom_test_fail_audit_ins()
    `);

    await expect(runMigrations(pool, { migrationsDir: dir })).rejects.toThrow(
      /reconciliation.*rolled back|simulated audit insert failure/i,
    );

    const after = await pool.query<{ checksum: string }>(
      `SELECT checksum FROM schema_migrations WHERE id = '001_af.sql'`,
    );
    expect(after.rows[0]?.checksum).toBe(legacy);
    const auditCount = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM schema_migration_checksum_audit`,
    );
    expect(auditCount.rows[0]?.n).toBe("0");

    await pool.query(`DROP TRIGGER figbloom_test_fail_audit_ins ON schema_migration_checksum_audit`);
    await pool.query(`DROP FUNCTION public.figbloom_test_fail_audit_ins()`);

    const retry = await runMigrations(pool, { migrationsDir: dir });
    expect(retry.reconciled).toEqual(["001_af.sql"]);
    const fixed = await pool.query<{ checksum: string }>(
      `SELECT checksum FROM schema_migrations WHERE id = '001_af.sql'`,
    );
    expect(fixed.rows[0]?.checksum).toBe(hashCanonicalSql(canonical));
    const auditAfter = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM schema_migration_checksum_audit WHERE migration_id = '001_af.sql'`,
    );
    expect(auditAfter.rows[0]?.n).toBe("1");
  });

  it("H-1: checksum update failure leaves legacy checksum and no audit row", async () => {
    await resetPublic();
    const dir = join(scratchDir, "m1-upd-fail");
    mkdirSync(dir, { recursive: true });
    const body = "CREATE TABLE t_m1_uf (id int);\n";
    writeFileSync(join(dir, "001_uf.sql"), body, "utf8");
    await runMigrations(pool, { migrationsDir: dir });
    const canonical = canonicalizeSql(body);
    const legacy = legacyCrlfChecksumFromCanonical(canonical);
    await pool.query(`UPDATE schema_migrations SET checksum = $1 WHERE id = '001_uf.sql'`, [
      legacy,
    ]);

    await pool.query(`
      CREATE OR REPLACE FUNCTION public.figbloom_test_fail_checksum_upd()
      RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF TG_OP = 'UPDATE' AND NEW.checksum IS DISTINCT FROM OLD.checksum THEN
          RAISE EXCEPTION 'simulated checksum update failure';
        END IF;
        RETURN NEW;
      END;
      $fn$
    `);
    await pool.query(`
      CREATE TRIGGER figbloom_test_fail_checksum_upd
        BEFORE UPDATE ON schema_migrations
        FOR EACH ROW EXECUTE FUNCTION public.figbloom_test_fail_checksum_upd()
    `);

    await expect(runMigrations(pool, { migrationsDir: dir })).rejects.toThrow(
      /reconciliation.*rolled back|simulated checksum update failure/i,
    );

    const after = await pool.query<{ checksum: string }>(
      `SELECT checksum FROM schema_migrations WHERE id = '001_uf.sql'`,
    );
    expect(after.rows[0]?.checksum).toBe(legacy);
    const auditCount = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM schema_migration_checksum_audit`,
    );
    expect(auditCount.rows[0]?.n).toBe("0");

    await pool.query(`DROP TRIGGER figbloom_test_fail_checksum_upd ON schema_migrations`);
    await pool.query(`DROP FUNCTION public.figbloom_test_fail_checksum_upd()`);
  });

  it("H-1: concurrent reconciliations leave one canonical checksum and one audit row", async () => {
    await resetPublic();
    const dir = join(scratchDir, "m1-concurrent");
    mkdirSync(dir, { recursive: true });
    const body = "CREATE TABLE t_m1_c (id int);\n";
    writeFileSync(join(dir, "001_c.sql"), body, "utf8");
    await runMigrations(pool, { migrationsDir: dir });
    const canonical = canonicalizeSql(body);
    const canonicalSum = hashCanonicalSql(canonical);
    const legacy = legacyCrlfChecksumFromCanonical(canonical);
    await pool.query(`UPDATE schema_migrations SET checksum = $1 WHERE id = '001_c.sql'`, [
      legacy,
    ]);

    const results = await Promise.all([
      runMigrations(pool, { migrationsDir: dir }),
      runMigrations(pool, { migrationsDir: dir }),
    ]);
    const reconciledTotal = results.reduce((n, r) => n + r.reconciled.length, 0);
    expect(reconciledTotal).toBeGreaterThanOrEqual(1);
    expect(reconciledTotal).toBeLessThanOrEqual(2);

    const row = await pool.query<{ checksum: string }>(
      `SELECT checksum FROM schema_migrations WHERE id = '001_c.sql'`,
    );
    expect(row.rows[0]?.checksum).toBe(canonicalSum);
    const audit = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM schema_migration_checksum_audit WHERE migration_id = '001_c.sql'`,
    );
    // Serialized lock: exactly one successful reconciliation writes one audit row.
    // If the second run sees canonical already, it adds none.
    expect(Number(audit.rows[0]?.n)).toBe(1);
  });

  it("NULL checksum backfill writes an audit row and is not silent", async () => {
    await resetPublic();
    const dir = join(scratchDir, "null-checksum");
    mkdirSync(dir, { recursive: true });
    const body = "CREATE TABLE t_null_checksum (id int);\n";
    writeFileSync(join(dir, "001_null.sql"), body, "utf8");
    await runMigrations(pool, { migrationsDir: dir });
    await pool.query(`UPDATE schema_migrations SET checksum = NULL WHERE id = '001_null.sql'`);

    await expect(verifyMigrations(pool, { migrationsDir: dir, reconcile: false })).rejects.toThrow(
      /NULL checksum/,
    );
    const stillNull = await pool.query<{ checksum: string | null }>(
      `SELECT checksum FROM schema_migrations WHERE id = '001_null.sql'`,
    );
    expect(stillNull.rows[0]?.checksum).toBeNull();

    const applied = await runMigrations(pool, { migrationsDir: dir });
    expect(applied.backfilled).toEqual(["001_null.sql"]);
    const sum = checksumSql(body);
    const after = await pool.query<{ checksum: string }>(
      `SELECT checksum FROM schema_migrations WHERE id = '001_null.sql'`,
    );
    expect(after.rows[0]?.checksum).toBe(sum);
    const audit = await pool.query<{ reason: string; old_checksum: string; new_checksum: string }>(
      `SELECT reason, old_checksum, new_checksum
       FROM schema_migration_checksum_audit WHERE migration_id = '001_null.sql'`,
    );
    expect(audit.rows[0]).toMatchObject({
      reason: NULL_CHECKSUM_BACKFILL_REASON,
      old_checksum: "(null)",
      new_checksum: sum,
    });
    expect(NULL_CHECKSUM_BACKFILL_REASON).not.toBe(LEGACY_CRLF_RECONCILE_REASON);
  });

  it("migration lock acquisition times out instead of blocking forever", async () => {
    const holder = await pool.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_LOCK_KEY]);
      await expect(runMigrations(pool, { lockTimeoutMs: 300 })).rejects.toBeInstanceOf(
        MigrationLockTimeoutError,
      );
    } finally {
      await holder.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK_KEY]).catch(() => undefined);
      holder.release();
    }
  });
});
