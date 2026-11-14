import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { loadConfig } from "../src/config.js";
import { hashPassword } from "../src/modules/identity/password.js";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { createPool } from "../src/db/pool.js";
import { runMigrations } from "../src/db/migrate.js";
import { assertRuntimeRole } from "../src/db/roleAssert.js";

const { Pool } = pg;

/**
 * resetDatabase() runs DROP SCHEMA public CASCADE. Refuse anything that is not
 * the isolated local figbloom_api database (FIG-1573 audit AUD-12).
 */
export function assertIsolatedTestDatabase(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  const host = url.hostname;
  const dbName = url.pathname.replace(/^\//, "");
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  if (!loopback || dbName !== "figbloom_api") {
    throw new Error(
      "Refusing to reset a database that is not the isolated local figbloom_api database.",
    );
  }
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Build a figbloom_app URL from the owner URL without logging either string. */
export function runtimeUrlFromOwner(ownerUrl: string, password: string): string {
  const url = new URL(ownerUrl);
  url.username = "figbloom_app";
  url.password = password;
  return url.toString();
}

export async function resetDatabase(pool: pg.Pool): Promise<void> {
  await pool.query(`
    DROP SCHEMA public CASCADE;
    CREATE SCHEMA public;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT USAGE ON SCHEMA public TO PUBLIC;
  `);
  // Use the real migration runner (advisory lock + checksums) — R2-09 / R3.
  await runMigrations(pool);
}

export interface FixtureIds {
  orgA: string;
  orgB: string;
  tenantA: string;
  tenantB: string;
  adminA: string;
  teacherA: string;
  teacherB: string;
  parentA: string;
  superAdmin: string;
  orgAdmin: string;
}

export async function seedFixtures(pool: pg.Pool): Promise<FixtureIds> {
  const ids: FixtureIds = {
    orgA: randomUUID(),
    orgB: randomUUID(),
    tenantA: randomUUID(),
    tenantB: randomUUID(),
    adminA: randomUUID(),
    teacherA: randomUUID(),
    teacherB: randomUUID(),
    parentA: randomUUID(),
    superAdmin: randomUUID(),
    orgAdmin: randomUUID(),
  };

  const passwordHash = await hashPassword("correct-horse-battery");

  await pool.query(
    `INSERT INTO organizations (id, name, slug, kind, status) VALUES
      ($1, 'Org A', 'org-a', 'group_owner', 'active'),
      ($2, 'Org B', 'org-b', 'group_owner', 'active')`,
    [ids.orgA, ids.orgB],
  );
  await pool.query(
    `INSERT INTO tenants (id, organization_id, name, slug, status) VALUES
      ($1, $3, 'School A', 'school-a', 'active'),
      ($2, $4, 'School B', 'school-b', 'active')`,
    [ids.tenantA, ids.tenantB, ids.orgA, ids.orgB],
  );

  const users: Array<[string, string | null, string]> = [
    [ids.adminA, "admin-a@example.com", "Admin A"],
    [ids.teacherA, null, "Teacher A"],
    [ids.teacherB, null, "Teacher B"],
    [ids.parentA, null, "Parent A"],
    [ids.superAdmin, "super@example.com", "Super Admin"],
    [ids.orgAdmin, "orgadmin@example.com", "Org Admin"],
  ];
  for (const [id, email, name] of users) {
    await pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [id, email, passwordHash, name],
    );
  }

  await pool.query(
    `INSERT INTO school_memberships (user_id, tenant_id, role, login_id) VALUES
      ($1, $5, 'school_admin', 'AD-0001'),
      ($2, $5, 'teacher', 'TC-0001'),
      ($3, $6, 'teacher', 'TC-0001'),
      ($4, $5, 'parent', 'PT-0001')`,
    [ids.adminA, ids.teacherA, ids.teacherB, ids.parentA, ids.tenantA, ids.tenantB],
  );

  await pool.query(`INSERT INTO platform_roles (user_id, role) VALUES ($1, 'super_admin')`, [
    ids.superAdmin,
  ]);
  await pool.query(
    `INSERT INTO organization_memberships (user_id, organization_id, role) VALUES ($1, $2, 'org_admin')`,
    [ids.orgAdmin, ids.orgA],
  );

  return ids;
}

export async function createTestApp(): Promise<{
  config: AppConfig;
  /** Owner/migrator pool: fixtures, resets, catalogue assertions. */
  pool: pg.Pool;
  /** Application pool. The app under test uses only this login (figbloom_app). */
  runtimePool: pg.Pool;
  app: Awaited<ReturnType<typeof buildApp>>;
  ids: FixtureIds;
}> {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const ownerUrl =
    process.env.MIGRATION_DATABASE_URL ??
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@127.0.0.1:58322/figbloom_api";
  // Override .env defaults so the suite is not starved by the login token bucket.
  process.env.AUTH_RATE_CAPACITY = "1000";
  process.env.AUTH_RATE_REFILL = "1000";
  // Default: proxy trust off for the shared suite (R2 tests enable it explicitly).
  process.env.API_TRUST_PROXY_HOPS = "0";
  delete process.env.API_TRUST_PROXY_CIDRS;
  assertIsolatedTestDatabase(ownerUrl);
  const pool = new Pool({
    connectionString: ownerUrl,
    max: 10,
    application_name: "figbloom-test-owner",
  });
  await resetDatabase(pool);
  const ids = await seedFixtures(pool);

  // Cluster-wide role: LOGIN is test-only and cleared when the owner pool ends.
  const password = randomBytes(24).toString("base64url");
  await pool.query(`ALTER ROLE figbloom_app WITH LOGIN PASSWORD ${quoteLiteral(password)}`);
  const runtimeUrl = runtimeUrlFromOwner(ownerUrl, password);
  process.env.DATABASE_URL = runtimeUrl;
  let config: AppConfig;
  try {
    config = loadConfig();
  } finally {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  }
  const runtimePool = createPool({
    connectionString: runtimeUrl,
    max: config.poolMax,
    applicationName: "figbloom-api-test",
    connectionTimeoutMillis: config.poolAcquireTimeoutMs,
  });
  const probe = await runtimePool.connect();
  try {
    await assertRuntimeRole(probe, { expectedRole: config.runtimeRole });
  } finally {
    probe.release();
  }
  const app = await buildApp(config, runtimePool);
  await app.ready();

  const originalEnd = pool.end.bind(pool);
  pool.end = async () => {
    await runtimePool.end().catch(() => undefined);
    try {
      await pool.query(`ALTER ROLE figbloom_app WITH NOLOGIN PASSWORD NULL`);
    } catch {
      /* best-effort; the role is cluster-wide */
    }
    return originalEnd();
  };

  return { config, pool, runtimePool, app, ids };
}
