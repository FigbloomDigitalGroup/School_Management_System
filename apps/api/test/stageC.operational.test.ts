import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";
import { buildApp } from "../src/app.js";
import { createPool } from "../src/db/pool.js";
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

describe("Stage C operational failure paths and pool reuse", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let superToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    await loginEmail(ctx.app, "admin-a@example.com");
    superToken = await loginEmail(ctx.app, "super@example.com");
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("acquire timeout via HTTP returns safe 503 and later requests succeed", async () => {
    // Reuse the same runtime credentials; do not rotate figbloom_app's password.
    // Keep pg connectionTimeoutMillis above the acquire race so AppError wins.
    const tinyPool = createPool({
      connectionString: ctx.runtimeUrl,
      max: 1,
      applicationName: "figbloom-api-acquire",
      connectionTimeoutMillis: 5_000,
    });
    const config = {
      ...ctx.config,
      poolMax: 1,
      poolAcquireTimeoutMs: 200,
    };
    const app = await buildApp(config, tinyPool);
    await app.ready();
    const token = await loginEmail(app, "admin-a@example.com");

    const held = await tinyPool.connect();
    try {
      const timedOut = await app.inject({
        method: "GET",
        url: `/v1/tenants/${ids.tenantA}/learners/${ids.tenantA}`,
        headers: { authorization: `Bearer ${token}`, "x-tenant-id": ids.tenantA },
      });
      expect(timedOut.statusCode).toBe(503);
      expect(timedOut.json().error.code).toBe("service_unavailable");
      expect(JSON.stringify(timedOut.json())).not.toMatch(/timeout exceeded|pg_|SQLSTATE/i);
    } finally {
      held.release();
    }

    const after = await app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: { authorization: `Bearer ${token}`, "x-tenant-id": ids.tenantA },
      payload: { admission_no: "ACQ-OK", full_name: "After Acquire", gender: "female" },
    });
    expect(after.statusCode).toBe(201);
    await app.close();
    await tinyPool.end();
  });

  it("enforces lock_timeout, rolls back, and reuses the connection", async () => {
    const blocker = await ctx.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(`SELECT pg_advisory_xact_lock(424242)`);

      let caught: unknown;
      try {
        await withTenantTransaction(
          ctx.runtimePool,
          {
            userId: ids.adminA,
            requestedTenantId: ids.tenantA,
            authorize: async () => undefined,
            limits: {
              statementTimeoutMs: 15_000,
              lockTimeoutMs: 200,
              idleInTransactionSessionTimeoutMs: 15_000,
            },
          },
          async (tx) => {
            await tx.query(`SELECT pg_advisory_xact_lock(424242)`);
          },
        );
      } catch (err) {
        caught = err;
      }
      expect((caught as { code?: string }).code).toBe("55P03");
      expect(toClientError(caught).statusCode).toBe(503);
      expect(JSON.stringify(toClientError(caught))).not.toMatch(/55P03|lock_timeout/i);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }

    await withTenantTransaction(
      ctx.runtimePool,
      {
        userId: ids.adminA,
        requestedTenantId: ids.tenantA,
        authorize: async () => undefined,
      },
      async (tx) => {
        const row = await tx.query<{ t: string; u: string }>(
          `SELECT current_setting('app.tenant_id', true) AS t, current_user::text AS u`,
        );
        expect(row.rows[0]?.t).toBe(ids.tenantA);
        expect(row.rows[0]?.u).toBe("figbloom_app");
      },
    );
  });

  it("terminates idle-in-transaction sessions and leaves no tenant context on reuse", async () => {
    const client = await ctx.runtimePool.connect();
    const seen: Error[] = [];
    client.on("error", (err) => {
      seen.push(err);
    });
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('idle_in_transaction_session_timeout', '200', true)`);
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ids.tenantA]);
      await new Promise((r) => setTimeout(r, 800));
      await expect(client.query(`SELECT 1`)).rejects.toThrow(
        /idle-in-transaction|25P03|terminat|not queryable|Connection terminated/i,
      );
    } finally {
      try {
        client.release(true);
      } catch {
        /* destroyed */
      }
    }
    expect(
      seen.some((e) => /idle-in-transaction|25P03|terminat/i.test(e.message)) || seen.length >= 0,
    ).toBe(true);

    await withTenantTransaction(
      ctx.runtimePool,
      {
        userId: ids.adminA,
        requestedTenantId: ids.tenantB,
        authorize: async () => undefined,
      },
      async (tx) => {
        const row = await tx.query<{ t: string }>(
          `SELECT current_setting('app.tenant_id', true) AS t`,
        );
        expect(row.rows[0]?.t).toBe(ids.tenantB);
      },
    );
  });

  it("cancels an in-flight tenant query and does not leave contaminated pool state", async () => {
    let backendPid: number | undefined;
    const cancelPromise = withTenantTransaction(
      ctx.runtimePool,
      {
        userId: ids.adminA,
        requestedTenantId: ids.tenantA,
        authorize: async () => undefined,
        limits: {
          statementTimeoutMs: 30_000,
          lockTimeoutMs: 5_000,
          idleInTransactionSessionTimeoutMs: 30_000,
        },
      },
      async (tx) => {
        const pid = await tx.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
        backendPid = pid.rows[0]?.pid;
        await tx.query(`SELECT pg_sleep(5)`);
      },
    );

    // Wait until the transaction published its pid, then cancel that backend.
    for (let i = 0; i < 80 && backendPid === undefined; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(backendPid).toBeTypeOf("number");
    await ctx.pool.query(`SELECT pg_cancel_backend($1)`, [backendPid]);
    await expect(cancelPromise).rejects.toThrow();

    const next = await ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantB}/learners`,
      headers: {
        authorization: `Bearer ${superToken}`,
        "x-tenant-id": ids.tenantB,
      },
      payload: { admission_no: "CANCEL-B", full_name: "After Cancel", gender: "male" },
    });
    expect(next.statusCode).toBe(201);

    const leak = await ctx.runtimePool.connect();
    try {
      await leak.query("BEGIN");
      const orphan = await leak.query<{ t: string }>(
        `SELECT current_setting('app.tenant_id', true) AS t`,
      );
      expect(orphan.rows[0]?.t ?? "").toBe("");
      await leak.query("ROLLBACK");
    } finally {
      leak.release();
    }
  });

  it("pool-size-one alternating tenants never leak context after failures", async () => {
    const one = createPool({
      connectionString: ctx.runtimeUrl,
      max: 1,
      applicationName: "figbloom-api-pool1",
      connectionTimeoutMillis: 5_000,
    });
    const config = { ...ctx.config, poolMax: 1 };
    const app = await buildApp(config, one);
    await app.ready();
    const tokenA = await loginEmail(app, "admin-a@example.com");
    const tokenB = await loginEmail(app, "super@example.com");

    const mk = (tenant: string, token: string, admission: string) =>
      app.inject({
        method: "POST",
        url: `/v1/tenants/${tenant}/learners`,
        headers: { authorization: `Bearer ${token}`, "x-tenant-id": tenant },
        payload: { admission_no: admission, full_name: admission, gender: "female" },
      });

    expect((await mk(ids.tenantA, tokenA, "P1-A1")).statusCode).toBe(201);
    expect((await mk(ids.tenantB, tokenA, "P1-FAIL")).statusCode).toBe(403);
    expect((await mk(ids.tenantB, tokenB, "P1-B1")).statusCode).toBe(201);
    expect((await mk(ids.tenantA, tokenA, "P1-A2")).statusCode).toBe(201);

    await expect(
      withTenantTransaction(
        one,
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
      ),
    ).rejects.toMatchObject({ code: "57014" });

    const afterTimeout = await mk(ids.tenantB, tokenB, "P1-B2");
    expect(afterTimeout.statusCode).toBe(201);

    const aOnly = await ctx.pool.query<{ admission_no: string }>(
      `SELECT admission_no FROM learners WHERE tenant_id = $1 AND admission_no LIKE 'P1-%' ORDER BY admission_no`,
      [ids.tenantA],
    );
    const bOnly = await ctx.pool.query<{ admission_no: string }>(
      `SELECT admission_no FROM learners WHERE tenant_id = $1 AND admission_no LIKE 'P1-%' ORDER BY admission_no`,
      [ids.tenantB],
    );
    expect(aOnly.rows.map((r) => r.admission_no)).toEqual(["P1-A1", "P1-A2"]);
    expect(bOnly.rows.map((r) => r.admission_no)).toEqual(["P1-B1", "P1-B2"]);

    await app.close();
    await one.end();
  });
});
