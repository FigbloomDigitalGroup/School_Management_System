import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, MIGRATIONS_DIR } from "../config.js";
import { closePool, createPool } from "./pool.js";

/** Advisory lock key namespace for figbloom API migrations (stable int). */
export const MIGRATION_LOCK_KEY = 157301;

export function checksumSql(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export async function runMigrations(pool: import("pg").Pool): Promise<{
  applied: string[];
  skipped: string[];
}> {
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    // Serialize concurrent migrators (R2-09).
    const locked = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock($1) AS locked`,
      [MIGRATION_LOCK_KEY],
    );
    if (!locked.rows[0]?.locked) {
      // Wait for the other migrator.
      await client.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_LOCK_KEY]);
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        checksum text,
        applied_by text NOT NULL DEFAULT CURRENT_USER
      )
    `);
    // Forward-compatible if 001 created the table without new columns.
    await client.query(`
      ALTER TABLE schema_migrations
        ADD COLUMN IF NOT EXISTS checksum text,
        ADD COLUMN IF NOT EXISTS applied_by text NOT NULL DEFAULT CURRENT_USER
    `);

    const existing = await client.query<{ id: string; checksum: string | null }>(
      `SELECT id, checksum FROM schema_migrations`,
    );
    const byId = new Map(existing.rows.map((r) => [r.id, r.checksum]));

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      const sum = checksumSql(sql);
      const prior = byId.get(file);

      if (prior !== undefined) {
        if (prior != null && prior !== sum) {
          throw new Error(
            `Migration ${file} was already applied with checksum ${prior}, but file now hashes to ${sum}. ` +
              `Edited historical migrations are refused; add a new forward migration instead.`,
          );
        }
        if (prior == null) {
          // Backfill checksum for rows applied before 004.
          await client.query(`UPDATE schema_migrations SET checksum = $2 WHERE id = $1 AND checksum IS NULL`, [
            file,
            sum,
          ]);
        }
        skipped.push(file);
        continue;
      }

      try {
        await client.query("BEGIN");
        await client.query(sql);
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
    }
  } finally {
    try {
      await client.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK_KEY]);
    } catch {
      /* ignore unlock errors on failed connection */
    }
    client.release();
  }
  return { applied, skipped };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  const result = await runMigrations(pool);
  if (result.applied.length === 0) {
    console.log(`up to date (${result.skipped.length} migrations present)`);
  }
  await closePool();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
