import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig } from "../config.js";
import { closePool, createPool } from "./pool.js";

/** Advisory lock key namespace for figbloom API migrations (stable int). */
export const MIGRATION_LOCK_KEY = 157301;

export const LEGACY_CRLF_RECONCILE_REASON = "legacy-crlf-reconciliation";

/**
 * Exit codes for the migrate CLI (FIG-1610).
 * 0 — success (apply and/or verify clean; reconcile completed when requested)
 * 1 — hard failure (checksum drift, missing file, SQL error, verify refusal)
 * 2 — usage / configuration / lock acquisition unexpected error
 * 3 — verify-only found legacy-CRLF candidates (no write performed)
 */
export const MIGRATE_EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  reconcileNeeded: 3,
} as const;

/**
 * Canonical form: replace CRLF (`\r\n`) with LF once.
 * Lone / stray `\r` (including CR immediately before a later CRLF collapse) are preserved.
 * Callers must hash the result with {@link hashCanonicalSql} — do not re-canonicalize
 * before hashing (double-canonicalization would hide `\r\r\n` → `\n`).
 */
export function canonicalizeSql(sql: string): string {
  return sql.replace(/\r\n/g, "\n");
}

/** SHA-256 of an already-canonical string (no further newline rewriting). */
export function hashCanonicalSql(canonicalSql: string): string {
  return createHash("sha256").update(canonicalSql, "utf8").digest("hex");
}

/** SHA-256 of the single-pass canonical LF form of raw file text. */
export function checksumSql(sql: string): string {
  return hashCanonicalSql(canonicalizeSql(sql));
}

/** Hash of the same logical content re-encoded with CRLF (legacy Windows checkout). */
export function legacyCrlfChecksumFromCanonical(canonicalSql: string): string {
  // Expect a once-canonicalized string; do not collapse residual CR via a second pass.
  const crlf = canonicalSql.replace(/\n/g, "\r\n");
  return createHash("sha256").update(crlf, "utf8").digest("hex");
}

/**
 * Resolve `apps/api/migrations` whether this module runs from `src/` or `dist/`.
 * Walks parents until `@figbloom/api` package.json + migrations/*.sql are found.
 */
export function resolveMigrationsDir(fromFileUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(fromFileUrl));
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "migrations");
    const pkgPath = join(dir, "package.json");
    if (existsSync(candidate) && existsSync(pkgPath)) {
      try {
        const name = JSON.parse(readFileSync(pkgPath, "utf8")).name as string | undefined;
        if (name === "@figbloom/api") {
          const sql = readdirSync(candidate).filter((f) => f.endsWith(".sql"));
          if (sql.length > 0) return candidate;
        }
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not resolve apps/api/migrations from compiled or source layout " +
      `(started near ${fileURLToPath(fromFileUrl)}).`,
  );
}

export type MigrationRunMode = "apply" | "verify";

export interface MigrationRunOptions {
  mode?: MigrationRunMode;
  /** When mode is verify, also write legacy-CRLF reconciliations + audit rows. */
  reconcile?: boolean;
  /** Override migrations directory (tests). */
  migrationsDir?: string;
}

export interface MigrationRunResult {
  applied: string[];
  skipped: string[];
  reconciled: string[];
  reconcileCandidates: string[];
  verified: string[];
}

async function ensureBootstrap(client: import("pg").PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now(),
      checksum text,
      applied_by text NOT NULL DEFAULT CURRENT_USER
    )
  `);
  await client.query(`
    ALTER TABLE schema_migrations
      ADD COLUMN IF NOT EXISTS checksum text,
      ADD COLUMN IF NOT EXISTS applied_by text NOT NULL DEFAULT CURRENT_USER
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migration_checksum_audit (
      id bigserial PRIMARY KEY,
      migration_id text NOT NULL,
      old_checksum text NOT NULL,
      new_checksum text NOT NULL,
      reason text NOT NULL,
      reconciled_by text NOT NULL DEFAULT CURRENT_USER,
      reconciled_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await client.query(`
    CREATE OR REPLACE FUNCTION public.schema_migration_checksum_audit_append_only()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      RAISE EXCEPTION 'schema_migration_checksum_audit is append-only';
    END;
    $fn$
  `);

  await client.query(`
    DROP TRIGGER IF EXISTS schema_migration_checksum_audit_append_only_trg
      ON schema_migration_checksum_audit
  `);
  await client.query(`
    CREATE TRIGGER schema_migration_checksum_audit_append_only_trg
      BEFORE UPDATE OR DELETE ON schema_migration_checksum_audit
      FOR EACH ROW
      EXECUTE FUNCTION public.schema_migration_checksum_audit_append_only()
  `);

  await client.query(`REVOKE ALL ON TABLE schema_migration_checksum_audit FROM PUBLIC`);
  await client.query(`
    DO $revoke$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'figbloom_app') THEN
        EXECUTE 'REVOKE ALL ON TABLE schema_migration_checksum_audit FROM figbloom_app';
      END IF;
    END
    $revoke$
  `);
}

async function withMigrationLock<T>(
  client: import("pg").PoolClient,
  fn: () => Promise<T>,
): Promise<T> {
  const locked = await client.query<{ locked: boolean }>(
    `SELECT pg_try_advisory_lock($1) AS locked`,
    [MIGRATION_LOCK_KEY],
  );
  if (!locked.rows[0]?.locked) {
    await client.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_LOCK_KEY]);
  }
  try {
    return await fn();
  } finally {
    try {
      await client.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK_KEY]);
    } catch {
      /* ignore unlock errors on failed connection */
    }
  }
}

function listMigrationFiles(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function readRawMigrationSql(migrationsDir: string, file: string): string {
  return readFileSync(join(migrationsDir, file), "utf8");
}

/**
 * Atomically upgrade a legacy CRLF checksum and append the audit row.
 * AD-14: reconciliation is never silent — UPDATE + INSERT commit together or not at all.
 */
async function reconcileLegacyChecksum(
  client: import("pg").PoolClient,
  file: string,
  prior: string,
  canonicalSum: string,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`UPDATE schema_migrations SET checksum = $2 WHERE id = $1`, [
      file,
      canonicalSum,
    ]);
    await client.query(
      `INSERT INTO schema_migration_checksum_audit
        (migration_id, old_checksum, new_checksum, reason, reconciled_by)
       VALUES ($1, $2, $3, $4, CURRENT_USER)`,
      [file, prior, canonicalSum, LEGACY_CRLF_RECONCILE_REASON],
    );
    await client.query("COMMIT");
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore rollback errors; surface the original failure */
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Legacy CRLF reconciliation for ${file} failed and was rolled back: ${message}`,
    );
  }
  console.warn(
    `[migrate] reconciled legacy CRLF checksum for ${file}: ${prior} -> ${canonicalSum} ` +
      `(reason=${LEGACY_CRLF_RECONCILE_REASON})`,
  );
}

function mismatchError(file: string, prior: string, sum: string): Error {
  return new Error(
    `Migration ${file} was already applied with checksum ${prior}, but file now hashes to ${sum}. ` +
      `Edited historical migrations are refused; add a new forward migration instead.`,
  );
}

export async function runMigrations(
  pool: import("pg").Pool,
  options: MigrationRunOptions = {},
): Promise<MigrationRunResult> {
  const mode: MigrationRunMode = options.mode ?? "apply";
  const reconcile = options.reconcile === true || mode === "apply";
  const migrationsDir = options.migrationsDir ?? resolveMigrationsDir();

  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  const reconciled: string[] = [];
  const reconcileCandidates: string[] = [];
  const verified: string[] = [];

  try {
    await withMigrationLock(client, async () => {
      await ensureBootstrap(client);

      const existing = await client.query<{ id: string; checksum: string | null }>(
        `SELECT id, checksum FROM schema_migrations`,
      );
      const byId = new Map(existing.rows.map((r) => [r.id, r.checksum]));
      const files = listMigrationFiles(migrationsDir);
      const onDisk = new Set(files);

      for (const id of byId.keys()) {
        if (!onDisk.has(id)) {
          throw new Error(
            `Applied migration ${id} is missing from disk under ${migrationsDir}. ` +
              `History drift is refused.`,
          );
        }
      }

      for (const file of files) {
        // Single CRLF→LF pass only, then hash those exact bytes (H-1 / AD-14).
        const canonicalSql = canonicalizeSql(readRawMigrationSql(migrationsDir, file));
        const sum = hashCanonicalSql(canonicalSql);
        const prior = byId.get(file);

        if (prior === undefined) {
          if (mode === "verify") {
            // Pending files are outside verify scope; only applied rows are checked.
            continue;
          }
          try {
            await client.query("BEGIN");
            await client.query(canonicalSql);
            await client.query(
              `INSERT INTO schema_migrations (id, checksum, applied_by) VALUES ($1, $2, CURRENT_USER)`,
              [file, sum],
            );
            await client.query("COMMIT");
            applied.push(file);
            console.log(`applied ${file}`);
          } catch (err) {
            await client.query("ROLLBACK");
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`Migration ${file} failed and was rolled back: ${message}`);
          }
          continue;
        }

        if (prior == null) {
          if (mode === "verify" && !reconcile) {
            throw new Error(
              `Migration ${file} has a NULL checksum; re-run migrate (apply) to backfill the canonical hash.`,
            );
          }
          await client.query(
            `UPDATE schema_migrations SET checksum = $2 WHERE id = $1 AND checksum IS NULL`,
            [file, sum],
          );
          skipped.push(file);
          verified.push(file);
          continue;
        }

        if (prior === sum) {
          skipped.push(file);
          verified.push(file);
          continue;
        }

        const legacy = legacyCrlfChecksumFromCanonical(canonicalSql);
        if (prior === legacy) {
          reconcileCandidates.push(file);
          if (!reconcile) {
            console.warn(
              `[migrate] legacy CRLF checksum candidate for ${file}: stored=${prior} canonical=${sum}`,
            );
            skipped.push(file);
            continue;
          }
          await reconcileLegacyChecksum(client, file, prior, sum);
          reconciled.push(file);
          skipped.push(file);
          verified.push(file);
          continue;
        }

        throw mismatchError(file, prior, sum);
      }

      // Role may be created mid-run (004); re-assert audit table is not usable by figbloom_app.
      await client.query(`REVOKE ALL ON TABLE schema_migration_checksum_audit FROM PUBLIC`);
      await client.query(`
        DO $revoke$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'figbloom_app') THEN
            EXECUTE 'REVOKE ALL ON TABLE schema_migration_checksum_audit FROM figbloom_app';
          END IF;
        END
        $revoke$
      `);
    });
  } finally {
    client.release();
  }

  return { applied, skipped, reconciled, reconcileCandidates, verified };
}

/** @deprecated Prefer runMigrations; kept for call-site clarity in verify CLI. */
export async function verifyMigrations(
  pool: import("pg").Pool,
  options: Omit<MigrationRunOptions, "mode"> = {},
): Promise<MigrationRunResult> {
  return runMigrations(pool, { ...options, mode: "verify" });
}

function parseCliArgs(argv: string[]): { mode: MigrationRunMode; reconcile: boolean } {
  const args = argv.slice(2);
  let mode: MigrationRunMode = "apply";
  let reconcile = false;
  for (const a of args) {
    if (a === "--verify" || a === "verify") mode = "verify";
    else if (a === "--reconcile") reconcile = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: migrate [--verify] [--reconcile]\n" +
          "  (default)     apply pending migrations; reconcile legacy CRLF checksums\n" +
          "  --verify      check applied checksums; no SQL applies; no writes unless --reconcile\n" +
          "  --reconcile   with --verify, write legacy-CRLF reconciliations + audit rows\n" +
          `Exit: ${MIGRATE_EXIT.ok}=ok ${MIGRATE_EXIT.failure}=failure ` +
          `${MIGRATE_EXIT.usage}=usage ${MIGRATE_EXIT.reconcileNeeded}=reconcile-needed`,
      );
      process.exit(MIGRATE_EXIT.ok);
    } else {
      console.error(`Unknown migrate argument: ${a}`);
      process.exit(MIGRATE_EXIT.usage);
    }
  }
  return { mode, reconcile };
}

async function main(): Promise<void> {
  const { mode, reconcile } = parseCliArgs(process.argv);
  const config = loadConfig();
  const pool = createPool(config);
  try {
    const result = await runMigrations(pool, { mode, reconcile });
    if (mode === "verify") {
      if (result.reconcileCandidates.length > 0 && !reconcile) {
        console.error(
          `migrate:verify found ${result.reconcileCandidates.length} legacy-CRLF candidate(s): ` +
            result.reconcileCandidates.join(", ") +
            `. Re-run with --reconcile to upgrade stored checksums, or run migrate (apply).`,
        );
        process.exitCode = MIGRATE_EXIT.reconcileNeeded;
        return;
      }
      console.log(
        `verified ${result.verified.length} migration(s)` +
          (result.reconciled.length ? `; reconciled ${result.reconciled.length}` : ""),
      );
      return;
    }
    if (result.applied.length === 0) {
      console.log(`up to date (${result.skipped.length} migrations present)`);
    }
    if (result.reconciled.length > 0) {
      console.log(`reconciled ${result.reconciled.length} legacy CRLF checksum(s)`);
    }
  } finally {
    await closePool();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = MIGRATE_EXIT.failure;
  });
}

// Re-export resolve helper path for config consumers that need the same root.
export function resolveApiPackageRoot(fromFileUrl: string = import.meta.url): string {
  return resolve(resolveMigrationsDir(fromFileUrl), "..");
}
