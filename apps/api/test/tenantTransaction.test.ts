import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { AppError } from "../src/http/errors.js";
import { attachDenialAudit } from "../src/db/errors.js";
import { forbidden } from "../src/http/errors.js";
import {
  acquireClient,
  guardedRollback,
  withTenantTransaction,
} from "../src/db/tenantTransaction.js";
import { assertIsolatedTestDatabase } from "./support.js";

const { Pool } = pg;
const ownerUrl =
  process.env.MIGRATION_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@127.0.0.1:58322/figbloom_api";

describe("tenant transaction primitive", () => {
  const pool = new Pool({
    connectionString: ownerUrl,
    max: 1,
    application_name: "figbloom-tx-test",
  });

  afterAll(async () => {
    await pool.end();
  });

  it("keeps context transaction-local across alternating tenants on one connection", async () => {
    assertIsolatedTestDatabase(ownerUrl);
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const user = randomUUID();
    await withTenantTransaction(
      pool,
      { userId: user, requestedTenantId: tenantA, authorize: async () => undefined },
      async (tx) => {
        const row = await tx.query<{ t: string }>(
          `SELECT current_setting('app.tenant_id', true) AS t`,
        );
        expect(row.rows[0]?.t).toBe(tenantA);
      },
    );
    await withTenantTransaction(
      pool,
      { userId: user, requestedTenantId: tenantB, authorize: async () => undefined },
      async (tx) => {
        const row = await tx.query<{ t: string; u: string }>(
          `SELECT current_setting('app.tenant_id', true) AS t, current_setting('app.user_id', true) AS u`,
        );
        expect(row.rows[0]?.t).toBe(tenantB);
        expect(row.rows[0]?.u).toBe(user);
      },
    );
    const outside = await pool.query<{ t: string }>(
      `SELECT current_setting('app.tenant_id', true) AS t`,
    );
    expect(outside.rows[0]?.t ?? "").toBe("");
  });

  it("rolls back and leaves no context for the next request", async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const user = randomUUID();
    await expect(
      withTenantTransaction(
        pool,
        { userId: user, requestedTenantId: tenantA, authorize: async () => undefined },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
    await withTenantTransaction(
      pool,
      { userId: user, requestedTenantId: tenantB, authorize: async () => undefined },
      async (tx) => {
        const row = await tx.query<{ t: string }>(
          `SELECT current_setting('app.tenant_id', true) AS t`,
        );
        expect(row.rows[0]?.t).toBe(tenantB);
      },
    );
  });

  it("refuses a second tenant assignment and a nested transaction", async () => {
    const user = randomUUID();
    const tenant = randomUUID();
    await expect(
      withTenantTransaction(
        pool,
        { userId: user, requestedTenantId: tenant, authorize: async () => undefined },
        async (tx) => {
          await tx.query(`SELECT set_config('app.tenant_id', $1, true)`, [randomUUID()]);
        },
      ),
    ).rejects.toThrow(/re-scope|Nested/);
    await expect(
      withTenantTransaction(
        pool,
        { userId: user, requestedTenantId: tenant, authorize: async () => undefined },
        async (tx) => {
          await tx.query("BEGIN");
        },
      ),
    ).rejects.toThrow(/Nested/);
  });

  it("does not set the tenant when authorisation fails", async () => {
    const user = randomUUID();
    await expect(
      withTenantTransaction(
        pool,
        {
          userId: user,
          requestedTenantId: randomUUID(),
          authorize: async (db) => {
            const row = await db.query<{ t: string }>(
              `SELECT current_setting('app.tenant_id', true) AS t`,
            );
            expect(row.rows[0]?.t ?? "").toBe("");
            throw forbidden("No membership for this school");
          },
        },
        async () => {
          throw new Error("business must not run");
        },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("preserves the original error when rollback also fails", async () => {
    const client = {
      query: async (sql: string) => {
        if (String(sql).includes("ROLLBACK")) throw new Error("rollback-down");
      },
    } as unknown as pg.PoolClient;
    await expect(guardedRollback(client, new Error("original-failure"))).rejects.toThrow(
      /original-failure/,
    );
    await expect(guardedRollback(client, new Error("original-failure"))).rejects.toThrow(
      /rollback-down/,
    );
  });

  it("acquire timeout returns service_unavailable", async () => {
    const held = await pool.connect();
    try {
      await expect(acquireClient(pool, 200)).rejects.toBeInstanceOf(AppError);
      await expect(acquireClient(pool, 200)).rejects.toMatchObject({
        statusCode: 503,
        code: "service_unavailable",
      });
    } finally {
      held.release();
    }
  });

  it("writes a denial audit after rollback and still returns 403", async () => {
    assertIsolatedTestDatabase(ownerUrl);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS security_audit_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        occurred_at timestamptz NOT NULL DEFAULT now(),
        actor_user_id uuid,
        tenant_id uuid,
        event_type text NOT NULL,
        detail jsonb NOT NULL DEFAULT '{}'::jsonb,
        ip inet
      )
    `);
    const user = randomUUID();
    const tenant = randomUUID();
    const users = await pool.query<{ t: string | null }>(`SELECT to_regclass('public.users')::text AS t`);
    if (users.rows[0]?.t) {
      await pool.query(
        `INSERT INTO users (id, password_hash, full_name) VALUES ($1, 'x', 'Denial probe') ON CONFLICT (id) DO NOTHING`,
        [user],
      );
    }
    const before = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM security_audit_events WHERE event_type = 'rbac.permission.denied' AND actor_user_id = $1`,
      [user],
    );
    const err = forbidden("Missing permission");
    attachDenialAudit(err, {
      eventType: "rbac.permission.denied",
      actorUserId: user,
      tenantId: null,
      detail: { permission: "resource.learner.read" },
    });
    await expect(
      withTenantTransaction(
        pool,
        { userId: user, requestedTenantId: tenant, authorize: async () => undefined },
        async () => {
          throw err;
        },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    const after = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM security_audit_events WHERE event_type = 'rbac.permission.denied' AND actor_user_id = $1`,
      [user],
    );
    expect(Number(after.rows[0]?.n)).toBe(Number(before.rows[0]?.n) + 1);
  });
});
