/**
 * Test-database target safety (post-remediation incident, 2026-11-20).
 *
 * The suite runs `DROP SCHEMA public CASCADE` on its target. A guard that only checks
 * "loopback + database name figbloom_api" accepts the development stack, which is exactly how an
 * interrupted run wiped the dev `figbloom_api` database. A target is now accepted only if ALL hold:
 *   1. loopback host, database name `figbloom_api`;
 *   2. port is not a known development/default port (FORBIDDEN_PORTS);
 *   3. the process environment EXPLICITLY designates it: FIGBLOOM_TEST_DB_DESIGNATION=<host>:<port>/<db>
 *      (nothing is inferred from apps/api/.env);
 *   4. the database itself carries the disposable marker (COMMENT ON DATABASE), set by an operator with
 *      `node scripts/designate-test-db.mjs` — verified over the live connection before any destructive step.
 * Every check fails closed. Credentials are never logged.
 */
export const DISPOSABLE_MARKER = "figbloom:disposable-test-db:v1";
export const DESIGNATION_ENV = "FIGBLOOM_TEST_DB_DESIGNATION";
/** Dev-stack and common default ports that must never be a destructive test target. */
export const FORBIDDEN_PORTS = new Set([5432, 54322, 58322, 15432, 25432]);

export function describeTarget(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
}

export function assertIsolatedTestDatabase(databaseUrl: string | undefined): void {
  if (!databaseUrl) {
    throw new Error(
      `Refusing to run: no test database URL. Set MIGRATION_DATABASE_URL and ${DESIGNATION_ENV} explicitly (see apps/api/docs/TEST-DATABASE-SAFETY.md).`,
    );
  }
  const url = new URL(databaseUrl);
  const host = url.hostname;
  const dbName = url.pathname.replace(/^\//, "");
  const port = Number(url.port || "5432");
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (!loopback || dbName !== "figbloom_api") {
    throw new Error("Refusing to reset a database that is not the isolated local figbloom_api database.");
  }
  if (FORBIDDEN_PORTS.has(port)) {
    throw new Error(
      `Refusing to reset ${describeTarget(databaseUrl)}: port ${port} is a development/default port, never a test target.`,
    );
  }
  const designated = process.env[DESIGNATION_ENV];
  if (designated !== describeTarget(databaseUrl)) {
    throw new Error(
      `Refusing to reset ${describeTarget(databaseUrl)}: ${DESIGNATION_ENV} must equal the target (explicit designation required; it is never inferred from .env).`,
    );
  }
}

/** Verify the live database carries the disposable marker. Call before any destructive statement. */
export async function assertDisposableMarker(db: {
  query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
}): Promise<void> {
  const res = await db.query(
    `SELECT shobj_description(d.oid, 'pg_database') AS marker, current_database() AS name
       FROM pg_database d WHERE d.datname = current_database()`,
  );
  const row = res.rows[0];
  if (!row || row.marker !== DISPOSABLE_MARKER) {
    throw new Error(
      `Refusing destructive test setup: database "${String(row?.name)}" is not marked disposable. ` +
        "An operator must run `node scripts/designate-test-db.mjs` against a throwaway database first.",
    );
  }
}
