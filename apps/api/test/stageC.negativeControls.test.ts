/**
 * In-suite negative controls that do not require permanent source mutations.
 * NC-1 / NC-3 / NC-7 / NC-8 are exercised here. NC-2 / NC-6 live in
 * architecture.tenant-boundary.test.ts. NC-4 / NC-5 live in runtime RLS /
 * membership tests. Source-edit NC runs are recorded in the evidence package.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { createTestApp, type FixtureIds } from "./support.js";
import { withTenantTransaction } from "../src/db/tenantTransaction.js";
import { applyTransactionLimits, setTenantContext } from "../src/db/tenantContext.js";
import { assertRuntimeRole } from "../src/db/roleAssert.js";
import { forbidden } from "../src/http/errors.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

describe("Stage C negative controls (in-suite)", () => {
  let ctx: Ctx;
  let ids: FixtureIds;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    await ctx.pool.query(
      `INSERT INTO learners (tenant_id, admission_no, full_name, gender)
       VALUES ($1, 'NC-A', 'Neg A', 'female'), ($2, 'NC-B', 'Neg B', 'male')`,
      [ids.tenantA, ids.tenantB],
    );
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("NC-1: omitting the tenant-context setter makes authorised reads fail closed", async () => {
    const client = await ctx.runtimePool.connect();
    try {
      await client.query("BEGIN");
      await applyTransactionLimits(client, {
        statementTimeoutMs: 15_000,
        lockTimeoutMs: 5_000,
        idleInTransactionSessionTimeoutMs: 15_000,
      });
      // Mutation: user context only — tenant setter skipped.
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.adminA]);
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [""]);
      const rows = await client.query(`SELECT admission_no FROM learners WHERE admission_no = 'NC-A'`);
      expect(rows.rowCount).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }

    await withTenantTransaction(
      ctx.runtimePool,
      {
        userId: ids.adminA,
        requestedTenantId: ids.tenantA,
        authorize: async () => undefined,
      },
      async (tx) => {
        const rows = await tx.query(`SELECT admission_no FROM learners WHERE admission_no = 'NC-A'`);
        expect(rows.rowCount).toBe(1);
      },
    );
  });

  it("NC-3: establishing tenant context before authorisation is detectable", async () => {
    // Controlled mutation of ordering inside this test only.
    let seenTenantDuringAuthorize = "";
    const user = ids.adminA;
    const tenant = ids.tenantA;
    const client = await ctx.runtimePool.connect();
    try {
      await client.query("BEGIN");
      await applyTransactionLimits(client, {
        statementTimeoutMs: 15_000,
        lockTimeoutMs: 5_000,
        idleInTransactionSessionTimeoutMs: 15_000,
      });
      // Mutated order: tenant context before authorisation.
      await setTenantContext(client, { userId: user, tenantId: tenant });
      const during = await client.query<{ t: string }>(
        `SELECT current_setting('app.tenant_id', true) AS t`,
      );
      seenTenantDuringAuthorize = during.rows[0]?.t ?? "";
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(seenTenantDuringAuthorize).toBe(tenant);

    // Correct order still holds in the real primitive.
    await expect(
      withTenantTransaction(
        ctx.runtimePool,
        {
          userId: user,
          requestedTenantId: tenant,
          authorize: async (db) => {
            const row = await db.query<{ t: string }>(
              `SELECT current_setting('app.tenant_id', true) AS t`,
            );
            expect(row.rows[0]?.t ?? "").toBe("");
            throw forbidden("stop-after-order-check");
          },
        },
        async () => {
          throw new Error("must not run");
        },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("NC-7: inherited privileged membership is rejected by assertRuntimeRole", async () => {
    const secret = randomBytes(18).toString("base64url");
    const literal = `'${secret.replace(/'/g, "''")}'`;
    await ctx.pool.query(`DROP ROLE IF EXISTS figbloom_nc7_leaf`);
    await ctx.pool.query(`DROP ROLE IF EXISTS figbloom_nc7_mid`);
    await ctx.pool.query(`CREATE ROLE figbloom_nc7_mid NOLOGIN`);
    await ctx.pool.query(`CREATE ROLE figbloom_nc7_leaf NOLOGIN NOINHERIT`);
    await ctx.pool.query(`GRANT pg_read_all_data TO figbloom_nc7_mid`);
    await ctx.pool.query(`GRANT figbloom_nc7_mid TO figbloom_nc7_leaf`);
    await ctx.pool.query(`ALTER ROLE figbloom_nc7_leaf WITH LOGIN PASSWORD ${literal}`);

    const url = new URL(
      process.env.MIGRATION_DATABASE_URL ??
        process.env.DATABASE_URL ??
        "",
    );
    url.username = "figbloom_nc7_leaf";
    url.password = secret;
    const { default: pg } = await import("pg");
    const bad = new pg.Pool({ connectionString: url.toString(), max: 1 });
    try {
      const client = await bad.connect();
      try {
        await expect(assertRuntimeRole(client, { expectedRole: "figbloom_nc7_leaf" })).rejects.toThrow(
          /member of/,
        );
      } finally {
        client.release();
      }
    } finally {
      await bad.end();
      await ctx.pool.query(`ALTER ROLE figbloom_nc7_leaf WITH NOLOGIN PASSWORD NULL`);
      await ctx.pool.query(`DROP ROLE IF EXISTS figbloom_nc7_leaf`);
      await ctx.pool.query(`DROP ROLE IF EXISTS figbloom_nc7_mid`);
    }
  });

  it("NC-8: runtime role cannot escalate or disable RLS", async () => {
    const client = await ctx.runtimePool.connect();
    try {
      await expect(client.query(`SET ROLE postgres`)).rejects.toThrow(/permission denied/i);
      await expect(client.query(`SET SESSION AUTHORIZATION postgres`)).rejects.toThrow(
        /permission denied/i,
      );
      await expect(client.query(`ALTER TABLE learners DISABLE ROW LEVEL SECURITY`)).rejects.toThrow(
        /permission denied|must be owner/i,
      );
      await expect(
        client.query(
          `CREATE POLICY learners_evil ON learners FOR ALL TO PUBLIC USING (true)`,
        ),
      ).rejects.toThrow(/permission denied|must be owner/i);
      await expect(
        client.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [`evil-${randomUUID()}.sql`]),
      ).rejects.toThrow(/permission denied/i);
      await expect(client.query(`TRUNCATE learners`)).rejects.toThrow(/permission denied/i);
    } finally {
      client.release();
    }
  });
});
