import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";
import { createPool, runtimePoolOptions } from "../src/db/pool.js";
import { withIdentityAccess } from "../src/db/identityAccess.js";
import { withTenantTransaction } from "../src/db/tenantTransaction.js";
import { buildApp } from "../src/app.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { pendingQueries } from "../src/db/clientHealth.js";
import { StallProxy, viaProxy } from "./support/stallProxy.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

/**
 * WP-A1 review R-01: the identity path (login, session lookup on every authenticated request,
 * rate limiting, readiness) used to run with no statement or lock timeout. These tests run as
 * figbloom_app and prove the operations are actually bounded, that timed-out connections are
 * destroyed instead of reused, and that the pool recovers.
 */

async function settle(ms = 50): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("R-01: identity-path database operations are bounded", () => {
  let ctx: Ctx;
  const pools: pg.Pool[] = [];
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 120_000);

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c().catch(() => undefined);
  });

  afterAll(async () => {
    for (const p of pools) await p.end().catch(() => undefined);
    await ctx.app.close();
    await ctx.pool.end();
  });

  function fastConfig(over: Partial<AppConfig> = {}): AppConfig {
    return {
      ...ctx.config,
      identityStatementTimeoutMs: 400,
      identityLockTimeoutMs: 400,
      clientQueryTimeoutMs: 900,
      poolAcquireTimeoutMs: 600,
      readinessTimeoutMs: 600,
      readinessCacheMs: 0,
      ...over,
    };
  }

  function makePool(config: AppConfig, url = ctx.runtimeUrl, max = 4): pg.Pool {
    const pool = createPool({ ...runtimePoolOptions(config, { connectionString: url, applicationName: "figbloom-r01" }), max });
    pools.push(pool);
    return pool;
  }

  it("every new pooled connection carries the identity baseline; tenant transactions override and revert to it", async () => {
    const show = async (db: { query: (q: string) => Promise<pg.QueryResult> }) =>
      (
        await db.query(
          `SELECT current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l,
                  current_setting('idle_in_transaction_session_timeout') AS i`,
        )
      ).rows[0];
    const baseline = await withIdentityAccess(ctx.runtimePool, (db) => show(db));
    expect(baseline).toEqual({ s: "5s", l: "2s", i: "15s" });

    let inside: unknown;
    await withTenantTransaction(
      ctx.runtimePool,
      { userId: ctx.ids.adminA, requestedTenantId: ctx.ids.tenantA, authorize: async () => undefined },
      async (tx) => {
        inside = (await tx.query(
          `SELECT current_setting('statement_timeout') AS s, current_setting('lock_timeout') AS l,
                  current_setting('idle_in_transaction_session_timeout') AS i`,
        )).rows[0];
      },
    );
    expect(inside).toEqual({ s: "15s", l: "5s", i: "15s" }); // the tenant limits, not the identity ones
    // After COMMIT the connection is back on the baseline (SET LOCAL ended), not unbounded.
    expect(await withIdentityAccess(ctx.runtimePool, (db) => show(db))).toEqual(baseline);
  });

  it("a stalled statement on the identity path is cancelled by the server, and the pool recovers", async () => {
    const pool = makePool(fastConfig());
    const t0 = Date.now();
    await expect(
      withIdentityAccess(pool, (db) => db.query("SELECT pg_sleep(10)")),
    ).rejects.toMatchObject({ code: "57014" });
    expect(Date.now() - t0).toBeLessThan(2500);
    // A server-side cancel leaves the connection clean: it is reused, not leaked or destroyed.
    expect(pool.waitingCount).toBe(0);
    expect(pool.idleCount).toBe(pool.totalCount);
    const ok = await withIdentityAccess(pool, (db) => db.query("SELECT 1 AS one"));
    expect(ok.rows[0]?.one).toBe(1);
  });

  it("a lock wait on the identity path ends at the lock timeout (55P03), releases the connection, and recovers", async () => {
    // lock timeout below the statement timeout, so the lock timer is the one that fires.
    const pool = makePool(fastConfig({ identityStatementTimeoutMs: 1500, identityLockTimeoutMs: 300, clientQueryTimeoutMs: 2500 }));
    const holder = await ctx.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE auth_rate_buckets IN ACCESS EXCLUSIVE MODE");
      const t0 = Date.now();
      await expect(
        withIdentityAccess(pool, (db) =>
          db.query("SELECT public.consume_rate_token('r01:lock', 5, 5, 1, 1000)"),
        ),
      ).rejects.toMatchObject({ code: "55P03" });
      const waited = Date.now() - t0;
      expect(waited).toBeGreaterThanOrEqual(300);
      expect(waited).toBeLessThan(2500);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    expect(pool.waitingCount).toBe(0);
    expect(pool.idleCount).toBe(pool.totalCount);
    await expect(
      withIdentityAccess(pool, (db) => db.query("SELECT public.consume_rate_token('r01:lock', 5, 5, 1, 1000)")),
    ).resolves.toBeDefined();
  });

  it("over HTTP: login while the rate-limit table is locked is a 503 with Retry-After within the bound, then works", async () => {
    const config = fastConfig({ identityStatementTimeoutMs: 1500, identityLockTimeoutMs: 500, clientQueryTimeoutMs: 2500 });
    const pool = makePool(config);
    const app = await buildApp(config, pool);
    await app.ready();
    cleanups.push(() => app.close());
    const holder = await ctx.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE auth_rate_buckets IN ACCESS EXCLUSIVE MODE");
      const t0 = Date.now();
      const res = await app.inject({
        method: "POST",
        url: "/v1/auth/login/email",
        payload: { email: "admin-a@example.com", password: "correct-horse-battery" },
      });
      expect(res.statusCode).toBe(503);
      expect(res.headers["retry-after"]).toBe("1");
      expect(res.json().error.code).toBe("service_unavailable");
      expect(JSON.stringify(res.json())).not.toMatch(/lock|timeout|auth_rate_buckets|postgres/i);
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    const ok = await app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email: "admin-a@example.com", password: "correct-horse-battery" },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("over HTTP: session validation (every authenticated request) is bounded when the session row is locked", async () => {
    const config = fastConfig({ identityStatementTimeoutMs: 1500, identityLockTimeoutMs: 500, clientQueryTimeoutMs: 2500, sessionLastSeenIntervalSeconds: 1 });
    const pool = makePool(config);
    const app = await buildApp(config, pool);
    await app.ready();
    cleanups.push(() => app.close());
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login/email",
      payload: { email: "admin-a@example.com", password: "correct-horse-battery" },
    });
    const token = login.json().token as string;
    // Make last_seen_at stale so the lookup tries to write, then hold the row lock.
    await ctx.pool.query(`UPDATE sessions SET last_seen_at = now() - interval '5 minutes' WHERE user_id = $1`, [ctx.ids.adminA]);
    const holder = await ctx.pool.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM sessions WHERE user_id = $1 FOR UPDATE", [ctx.ids.adminA]);
      const t0 = Date.now();
      const res = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(503);
      expect(res.headers["retry-after"]).toBe("1");
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    const ok = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(ok.statusCode).toBe(200);
    expect(pool.waitingCount).toBe(0);
  });

  it("a query that times out on the CLIENT is abandoned and its connection destroyed, not returned to the pool", async () => {
    const config = fastConfig({ clientQueryTimeoutMs: 800, identityStatementTimeoutMs: 600 });
    const pool = makePool(config);
    await withIdentityAccess(pool, (db) => db.query("SELECT 1")); // one pooled connection exists
    expect(pool.totalCount).toBe(1);
    await expect(
      withIdentityAccess(pool, (db) =>
        db.query({ text: "SELECT pg_sleep(5)", query_timeout: 200 } as pg.QueryConfig),
      ),
    ).rejects.toThrow("Query read timeout");
    await settle(100);
    expect(pool.totalCount).toBe(0); // destroyed
    // The server side of that connection is gone too (or about to be): nothing keeps sleeping for this pool.
    for (let i = 0; i < 20; i++) {
      const r = await ctx.pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'figbloom-r01' AND query LIKE '%pg_sleep(5)%' AND state = 'active'`,
      );
      if (r.rows[0].n === 0) break;
      await settle(100);
    }
    await expect(withIdentityAccess(pool, (db) => db.query("SELECT 1 AS one"))).resolves.toBeDefined();
  });

  it("a query left in flight when its owner finishes (an abandoned race) destroys the connection", async () => {
    const pool = makePool(fastConfig());
    await withIdentityAccess(pool, (db) => db.query("SELECT 1"));
    let seenPending = 0;
    await withIdentityAccess(pool, async (db) => {
      // Not awaited, like a Promise.race that gave up on it.
      void db.query("SELECT pg_sleep(0.5)").catch(() => undefined);
      seenPending = 1;
    });
    expect(seenPending).toBe(1);
    expect(pool.totalCount).toBe(0);
    // A normal, fully awaited access afterwards keeps its connection.
    await withIdentityAccess(pool, (db) => db.query("SELECT 1"));
    expect(pool.totalCount).toBe(1);
    expect(pool.idleCount).toBe(1);
  });

  it("tracking: a completed query leaves nothing pending on the client", async () => {
    const pool = makePool(fastConfig());
    const client = await pool.connect();
    expect(pendingQueries(client)).toBe(0);
    client.release();
  });

  describe("a stalled network (no server-side timer can fire)", () => {
    let proxy: StallProxy;
    let url: string;

    beforeAll(async () => {
      const dbUrl = new URL(ctx.runtimeUrl); // the isolated test database, as created by createTestApp
      proxy = new StallProxy({ host: dbUrl.hostname === "localhost" ? "127.0.0.1" : dbUrl.hostname, port: Number(dbUrl.port || 5432) });
      await proxy.start();
      url = viaProxy(ctx.runtimeUrl, proxy.port);
    });

    afterAll(async () => {
      proxy.resume();
      await proxy.stop();
    });

    afterEach(() => proxy.resume());

    it("/readyz during a stall is 503 within its budget, never leaks pool clients, and recovers; liveness stays 200", async () => {
      const config = fastConfig({ readinessTimeoutMs: 500, poolAcquireTimeoutMs: 500, clientQueryTimeoutMs: 900 });
      const pool = makePool(config, url, 3);
      const app = await buildApp(config, pool);
      await app.ready();
      cleanups.push(() => app.close());

      expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
      proxy.stall();
      // Far more probes than POOL_MAX: if each timed-out probe left its client checked out, the pool would be exhausted.
      for (let i = 0; i < 8; i++) {
        const t0 = Date.now();
        const res = await app.inject({ method: "GET", url: "/readyz" });
        expect(res.statusCode, `probe ${i}`).toBe(503);
        expect(res.json()).toEqual({ status: "unavailable" });
        expect(Date.now() - t0, `probe ${i} duration`).toBeLessThan(2500);
        expect(pool.totalCount).toBeLessThanOrEqual(3);
      }
      for (const p of ["/livez", "/health", "/v1/health"]) {
        expect((await app.inject({ method: "GET", url: p })).statusCode, p).toBe(200);
      }
      proxy.resume();
      await settle(200);
      // Recovery: ready again, nothing stuck checked out, no waiters, bounded size.
      expect((await app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
      expect(pool.waitingCount).toBe(0);
      expect(pool.totalCount).toBeLessThanOrEqual(3);
      expect(pool.idleCount).toBe(pool.totalCount);
    });

    it("login and an authenticated request during a stall return 503 with Retry-After (never 500), within the bound, and recover", async () => {
      const config = fastConfig({ poolAcquireTimeoutMs: 500, clientQueryTimeoutMs: 900 });
      const pool = makePool(config, url, 3);
      const app = await buildApp(config, pool);
      await app.ready();
      cleanups.push(() => app.close());
      const login = await app.inject({
        method: "POST",
        url: "/v1/auth/login/email",
        payload: { email: "admin-a@example.com", password: "correct-horse-battery" },
      });
      expect(login.statusCode).toBe(200);
      const token = login.json().token as string;

      proxy.stall();
      const t0 = Date.now();
      const me = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${token}` } });
      const again = await app.inject({
        method: "POST",
        url: "/v1/auth/login/email",
        payload: { email: "admin-a@example.com", password: "correct-horse-battery" },
      });
      for (const r of [me, again]) {
        expect(r.statusCode).toBe(503);
        expect(r.headers["retry-after"]).toBe("1");
        expect(r.json().error.code).toBe("service_unavailable");
        expect(JSON.stringify(r.json())).not.toMatch(/Query read timeout|ECONN|postgres|127\.0\.0\.1/i);
      }
      expect(Date.now() - t0).toBeLessThan(6000);

      proxy.resume();
      await settle(200);
      const ok = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { authorization: `Bearer ${token}` } });
      expect(ok.statusCode).toBe(200);
      expect(pool.waitingCount).toBe(0);
    });

    it("a tenant transaction whose connection stalls mid-flight fails fast without a queued ROLLBACK, destroys the connection, and the pool recovers", async () => {
      const config = fastConfig({ clientQueryTimeoutMs: 700 });
      const pool = makePool(config, url, 2);
      await withIdentityAccess(pool, (db) => db.query("SELECT 1"));
      const t0 = Date.now();
      await expect(
        withTenantTransaction(
          pool,
          { userId: ctx.ids.adminA, requestedTenantId: ctx.ids.tenantA, authorize: async () => undefined, limits: { statementTimeoutMs: 400, lockTimeoutMs: 400, idleInTransactionSessionTimeoutMs: 2000 } },
          async (tx) => {
            proxy.stall();
            await tx.query("SELECT 1");
          },
        ),
      ).rejects.toThrow("Query read timeout");
      // One client-side timeout, not two (the ROLLBACK is not queued behind the stuck statement).
      expect(Date.now() - t0).toBeLessThan(1500);
      await settle(100);
      expect(pool.totalCount).toBe(0);
      proxy.resume();
      await settle(100);
      await expect(withIdentityAccess(pool, (db) => db.query("SELECT 1 AS one"))).resolves.toBeDefined();
      expect(pool.totalCount).toBe(1);
    });

    it("connection acquisition during a stall times out at the acquire budget without leaving a stuck pool", async () => {
      const config = fastConfig({ poolAcquireTimeoutMs: 400 });
      const pool = makePool(config, url, 2);
      proxy.stall();
      const attempts = await Promise.allSettled(
        Array.from({ length: 6 }, () => withIdentityAccess(pool, (db) => db.query("SELECT 1"), { acquireTimeoutMs: 400 })),
      );
      expect(attempts.every((a) => a.status === "rejected")).toBe(true);
      proxy.resume();
      await settle(1200);
      await expect(withIdentityAccess(pool, (db) => db.query("SELECT 1 AS one"))).resolves.toBeDefined();
      expect(pool.waitingCount).toBe(0);
      expect(pool.totalCount).toBeLessThanOrEqual(2);
    });
  });

  it("configuration: the client backstop must exceed every server-side statement timeout", () => {
    const base = {
      DATABASE_URL: "postgresql://figbloom_app:x@127.0.0.1:5432/figbloom_api",
    } as NodeJS.ProcessEnv;
    expect(() => loadConfig({ ...base })).not.toThrow();
    expect(() => loadConfig({ ...base, STATEMENT_TIMEOUT_MS: "30000" })).toThrow(/CLIENT_QUERY_TIMEOUT_MS must exceed/);
    expect(() => loadConfig({ ...base, IDENTITY_STATEMENT_TIMEOUT_MS: "25000" })).toThrow(/CLIENT_QUERY_TIMEOUT_MS must exceed/);
    expect(() => loadConfig({ ...base, STATEMENT_TIMEOUT_MS: "30000", CLIENT_QUERY_TIMEOUT_MS: "40000" })).not.toThrow();
    expect(() => loadConfig({ ...base, IDENTITY_LOCK_TIMEOUT_MS: "0" })).toThrow(/Invalid API config/);
  });
});
