import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type FixtureIds } from "./support.js";
import { withTenantRequest } from "../src/http/tenantRequest.js";
import { withTenantTransaction } from "../src/db/tenantTransaction.js";
import { loadConfig } from "../src/config.js";

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

describe("runtime identity proof (HTTP path vs harness)", () => {
  let ctx: Ctx;
  let ids: FixtureIds;
  let adminToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    ids = ctx.ids;
    adminToken = await loginEmail(ctx.app, "admin-a@example.com");
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("distinguishes owner/fixture identity from the runtime pool identity", async () => {
    const owner = await ctx.pool.query<{
      current_user: string;
      session_user: string;
      rolbypassrls: boolean;
      application_name: string;
    }>(
      `SELECT current_user::text AS current_user,
              session_user::text AS session_user,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS rolbypassrls,
              current_setting('application_name') AS application_name`,
    );
    expect(owner.rows[0]?.current_user).not.toBe("figbloom_app");
    expect(owner.rows[0]?.application_name).toBe("figbloom-test-owner");

    const runtime = await ctx.runtimePool.query<{
      current_user: string;
      session_user: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      application_name: string;
    }>(
      `SELECT current_user::text AS current_user,
              session_user::text AS session_user,
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS rolsuper,
              (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS rolbypassrls,
              current_setting('application_name') AS application_name`,
    );
    expect(runtime.rows[0]?.current_user).toBe("figbloom_app");
    expect(runtime.rows[0]?.session_user).toBe("figbloom_app");
    expect(runtime.rows[0]?.rolsuper).toBe(false);
    expect(runtime.rows[0]?.rolbypassrls).toBe(false);
    expect(runtime.rows[0]?.application_name).toBe("figbloom-api-test");
  });

  it("observes figbloom_app inside an authorised HTTP tenant request transaction", async () => {
    // withTenantRequest is the sole HTTP tenant primitive (same path as routes).
    // App is already listening, so drive the primitive with a request-shaped object
    // rather than registering a late route.
    const request = {
      method: "GET",
      url: "/__test/db-identity",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": ids.tenantA,
      },
      body: null,
      ip: "127.0.0.1",
      socket: { remoteAddress: "127.0.0.1" },
      server: { appConfig: ctx.config },
      routeOptions: { url: "/__test/db-identity" },
    } as unknown as import("fastify").FastifyRequest;

    const body = await withTenantRequest(ctx.runtimePool, ctx.config, request, async ({ tx }) => {
      const row = await tx.query<{
        current_user: string;
        session_user: string;
        tenant_id: string;
        user_id: string;
      }>(
        `SELECT current_user::text AS current_user,
                session_user::text AS session_user,
                current_setting('app.tenant_id', true) AS tenant_id,
                current_setting('app.user_id', true) AS user_id`,
      );
      return row.rows[0]!;
    });
    expect(body.current_user).toBe("figbloom_app");
    expect(body.session_user).toBe("figbloom_app");
    expect(body.tenant_id).toBe(ids.tenantA);
    expect(body.user_id).toBe(ids.adminA);
  });

  it("observes figbloom_app on the live backend during an HTTP write (pg_stat_activity)", async () => {
    const admission = `id-probe-${Date.now()}`;
    const createPromise = ctx.app.inject({
      method: "POST",
      url: `/v1/tenants/${ids.tenantA}/learners`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "x-tenant-id": ids.tenantA,
      },
      payload: { admission_no: admission, full_name: "Identity Probe", gender: "female" },
    });

    // Concurrently inspect backends; the write is short so also assert via held tx.
    const held = withTenantTransaction(
      ctx.runtimePool,
      {
        userId: ids.adminA,
        requestedTenantId: ids.tenantA,
        authorize: async () => undefined,
        limits: {
          statementTimeoutMs: 15_000,
          lockTimeoutMs: 5_000,
          idleInTransactionSessionTimeoutMs: 15_000,
        },
      },
      async (tx) => {
        const me = await tx.query<{ u: string }>(`SELECT current_user::text AS u`);
        expect(me.rows[0]?.u).toBe("figbloom_app");
        const activity = await ctx.pool.query<{ usename: string; application_name: string }>(
          `SELECT usename::text AS usename, application_name
           FROM pg_stat_activity
           WHERE datname = current_database()
             AND application_name = 'figbloom-api-test'
             AND usename = 'figbloom_app'`,
        );
        expect(activity.rowCount).toBeGreaterThan(0);
        await tx.query(`SELECT pg_sleep(0.2)`);
      },
    );

    const [created] = await Promise.all([createPromise, held]);
    expect(created.statusCode).toBe(201);
  });

  it("fails closed when DATABASE_URL is pointed at the migrator user", () => {
    expect(() =>
      loadConfig({
        DATABASE_URL: process.env.MIGRATION_DATABASE_URL ??
          "",
        API_TRUST_PROXY_HOPS: "0",
      }),
    ).toThrow(/DATABASE_URL user .* must equal RUNTIME_ROLE/);
  });
});
