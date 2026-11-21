import http from "node:http";
import net from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";
import { createPool } from "../src/db/pool.js";
import { startServer, type RunningServer } from "../src/server.js";
import { withTenantRequest } from "../src/http/tenantRequest.js";
import type { AppConfig } from "../src/config.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * F-C3: request abort over a REAL socket (not Fastify inject, which cannot disconnect).
 * A disconnect while a statement runs must cancel that statement in PostgreSQL, roll the
 * transaction back, release the pooled connection and leave no tenant context behind.
 */
describe("request abort cancels the in-flight PostgreSQL work (F-C3)", () => {
  let ctx: Ctx;
  let server: RunningServer;
  let port: number;
  let token: string;
  let pool: ReturnType<typeof createPool>;

  beforeAll(async () => {
    ctx = await createTestApp();
    const login = await ctx.app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email: "admin-a@example.com", password: "correct-horse-battery" },
    });
    token = login.json().token as string;
    port = await freePort();
    // Pool size 1: any leaked connection, transaction or context would break the next request.
    pool = createPool({ connectionString: ctx.runtimeUrl, max: 1, applicationName: "figbloom-cancel-test", connectionTimeoutMillis: 3000 });
    const config: AppConfig = { ...ctx.config, port, host: "127.0.0.1", poolAcquireTimeoutMs: 3000 };
    server = await startServer(config, pool, {
      gracePeriodMs: 1000,
      hardTimeoutMs: 5000,
      forceExit: () => undefined,
      log: () => undefined,
      beforeListen: (app: FastifyInstance) => {
        // Long statement: pg_sleep(30) would run for 30 s (statement_timeout is 15 s) unless cancelled.
        app.get("/__test/pg-sleep", (request) =>
          withTenantRequest(pool, config, request, async ({ tx }) => {
            await tx.query("SELECT pg_sleep(30)");
            return { done: true };
          }),
        );
        // A write followed by slow JavaScript work: abandoned before COMMIT, so no effect.
        app.post("/__test/write-then-wait", (request) =>
          withTenantRequest(pool, config, request, async ({ tx }) => {
            await tx.query(
              `INSERT INTO learners (tenant_id, admission_no, full_name, gender) VALUES ($1, 'CANCEL-WAIT', 'Cancel Wait', 'male')`,
              [ctx.ids.tenantA],
            );
            await sleep(700);
            return { done: true };
          }),
        );
        app.get("/__test/quick", (request) =>
          withTenantRequest(pool, config, request, async ({ tx }) => {
            const r = await tx.query<{ n: number }>("SELECT 1 AS n");
            const t = await tx.query<{ t: string }>(`SELECT current_setting('app.tenant_id', true) AS t`);
            return { n: r.rows[0]!.n, tenant: t.rows[0]!.t };
          }),
        );
      },
    });
  }, 120_000);

  afterAll(async () => {
    await server.shutdown("test");
    await ctx.app.close();
    await ctx.pool.end();
  });

  const headers = () => ({ authorization: `Bearer ${token}`, "x-tenant-id": ctx.ids.tenantA });

  /** Starts a request, returns a function that destroys its socket. */
  function open(method: "GET" | "POST", path: string) {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: headers(), agent: false });
    req.on("error", () => undefined);
    req.on("response", (res) => res.resume());
    req.end();
    return () => req.destroy();
  }

  async function activeSleepers(): Promise<number> {
    const r = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'active' AND query ILIKE '%pg_sleep(30)%'
          AND pid <> pg_backend_pid()`,
    );
    return r.rows[0]!.n;
  }

  async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return true;
      await sleep(50);
    }
    return check();
  }

  it("a disconnect mid-query cancels the PostgreSQL statement and frees the connection", async () => {
    const destroy = open("GET", "/__test/pg-sleep");
    expect(await waitFor(async () => (await activeSleepers()) === 1, 3000)).toBe(true);
    const started = Date.now();
    destroy();
    // Without cancellation the statement runs until statement_timeout (15 s).
    expect(await waitFor(async () => (await activeSleepers()) === 0, 4000)).toBe(true);
    expect(Date.now() - started).toBeLessThan(4500);

    // Nothing left open: no idle-in-transaction backend for the test pool, and the single
    // pooled connection is reusable at once.
    const idle = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'idle in transaction'
          AND application_name LIKE 'figbloom-cancel-test%'`,
    );
    expect(idle.rows[0]!.n).toBe(0);
    const next = await fetch(`http://127.0.0.1:${port}/__test/quick`, { headers: headers() });
    expect(next.status).toBe(200);
    const body = (await next.json()) as { n: number; tenant: string };
    expect(body.n).toBe(1);
    // Its own transaction's context, never the aborted request's leftover (same tenant here, so also
    // check the raw connection below).
    expect(body.tenant).toBe(ctx.ids.tenantA);
    const c = await pool.connect();
    try {
      const leak = await c.query<{ t: string | null; u: string | null }>(
        `SELECT current_setting('app.tenant_id', true) AS t, current_setting('app.user_id', true) AS u`,
      );
      expect([null, ""]).toContain(leak.rows[0]!.t);
      expect([null, ""]).toContain(leak.rows[0]!.u);
    } finally {
      c.release();
    }
  });

  it("a request abandoned before COMMIT has no effect (rolled back)", async () => {
    const destroy = open("POST", "/__test/write-then-wait");
    await sleep(250); // INSERT done, handler still waiting
    destroy();
    await sleep(900); // handler finishes; abandoned signal => rollback instead of COMMIT
    const rows = await ctx.pool.query(`SELECT 1 FROM learners WHERE admission_no = 'CANCEL-WAIT'`);
    expect(rows.rowCount).toBe(0);
  });

  it("a request that is NOT abandoned commits normally (the same route, patient client)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/__test/write-then-wait`, { method: "POST", headers: headers() });
    expect(res.status).toBe(200);
    const rows = await ctx.pool.query(`SELECT 1 FROM learners WHERE admission_no = 'CANCEL-WAIT'`);
    expect(rows.rowCount).toBe(1);
    await ctx.pool.query(`DELETE FROM learners WHERE admission_no = 'CANCEL-WAIT'`);
  });

  it("an abort that arrives after the transaction ended never cancels a later request on the same backend", async () => {
    // Quick request completes and its connection is reused by the next one (pool size 1).
    const a = await fetch(`http://127.0.0.1:${port}/__test/quick`, { headers: headers() });
    expect(a.status).toBe(200);
    const destroy = open("GET", "/__test/pg-sleep");
    expect(await waitFor(async () => (await activeSleepers()) === 1, 3000)).toBe(true);
    // The first (finished) request's signal can no longer address this backend: its token is gone.
    // Cancel only this request.
    destroy();
    expect(await waitFor(async () => (await activeSleepers()) === 0, 4000)).toBe(true);
    const b = await fetch(`http://127.0.0.1:${port}/__test/quick`, { headers: headers() });
    expect(b.status).toBe(200);
  });
});
