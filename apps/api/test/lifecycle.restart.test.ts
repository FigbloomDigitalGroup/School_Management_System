import http from "node:http";
import net from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";
import { createPool, runtimePoolOptions } from "../src/db/pool.js";
import { withIdentityAccess } from "../src/db/identityAccess.js";
import { withTenantTransaction } from "../src/db/tenantTransaction.js";
import { startServer } from "../src/server.js";
import type { AppConfig } from "../src/config.js";
import { StallProxy, viaProxy } from "./support/stallProxy.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

/**
 * WP-A1 review R-05 / FIG-1617: what "no 5xx in a controlled restart" means, precisely, and the tests for it.
 *
 * Acceptance behaviour (documented in docs/OPERATIONS.md):
 *  1. A request admitted before shutdown completes with its normal response, and its database
 *     effect is durable, if it finishes within SHUTDOWN_GRACE_MS.
 *  2. While the drain delay runs, the listener is still open and every request is served
 *     normally. The only 503 anywhere is /readyz saying "draining" (deliberate, with Retry-After).
 *  3. After the listener closes, new connections are refused at the TCP level. That is not an
 *     HTTP status; a load balancer that has stopped routing never sees it.
 *  4. A request that outlives the grace period is cut (connection closed, no response). Its
 *     transaction is rolled back (no partial effect) and the process exits non-zero.
 *  5. A request arriving over an already-open keep-alive connection while the listener is
 *     closing is either dropped at the socket or answered 503 + Connection: close by the HTTP
 *     framework before any handler runs: never a 500, never a partial effect.
 *  6. If the database stalls during shutdown, the pool still ends (stalled connections are
 *     destroyed by the client-side read timeout) and, at the latest, the hard timeout forces exit(1).
 * An unplanned failure is a different case: a database outage is 503 service_unavailable
 * (identityBounds.test.ts), and an unexpected defect is the opaque 500 `internal_error`.
 */

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

interface Res {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function request(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown; agent?: http.Agent | false } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        agent: opts.agent ?? false,
        headers: {
          ...(payload ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("controlled restart: shutdown with traffic and database work in flight (FIG-1617, R-05)", () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  async function restartCount(): Promise<number> {
    const r = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM security_audit_events WHERE detail->>'restart_test' = 'true'`,
    );
    return r.rows[0]!.n;
  }

  async function boot(opts: {
    poolUrl?: string;
    config?: Partial<AppConfig>;
    drainDelayMs?: number;
    gracePeriodMs?: number;
    hardTimeoutMs?: number;
    exits?: number[];
    appName?: string;
  }) {
    const port = await freePort();
    const config: AppConfig = { ...ctx.config, port, host: "127.0.0.1", ...opts.config };
    const pool = createPool({
      ...runtimePoolOptions(config, { connectionString: opts.poolUrl ?? ctx.runtimeUrl, applicationName: opts.appName ?? "figbloom-restart-test" }),
      max: 4,
    });
    const routes = (app: FastifyInstance): void => {
      // A DB-bound request that is still running when shutdown starts.
      app.get("/__test/slow-db", async (request) => {
        const ms = Number((request.query as { ms?: string }).ms ?? "800");
        await withIdentityAccess(pool, (db) => db.query("SELECT pg_sleep($1::double precision)", [ms / 1000]));
        return { done: true };
      });
      // A DB-bound request with a write inside a tenant transaction.
      app.post("/__test/write-then-sleep", async (request) => {
        const ms = Number((request.query as { ms?: string }).ms ?? "800");
        await withTenantTransaction(
          pool,
          { userId: ctx.ids.adminA, requestedTenantId: ctx.ids.tenantA, authorize: async () => undefined, signal: request.abortSignal },
          async (tx) => {
            await tx.query(
              `INSERT INTO security_audit_events (event_type, detail) VALUES ('auth.logout', '{"restart_test": true}'::jsonb)`,
            );
            await tx.query("SELECT pg_sleep($1::double precision)", [ms / 1000]);
          },
        );
        return { done: true };
      });
    };
    const server = await startServer(config, pool, {
      drainDelayMs: opts.drainDelayMs ?? 0,
      gracePeriodMs: opts.gracePeriodMs ?? 3000,
      hardTimeoutMs: opts.hardTimeoutMs ?? 8000,
      forceExit: (code) => opts.exits?.push(code),
      log: () => undefined,
      beforeListen: routes,
    });
    return { server, port, pool };
  }

  it("requests admitted before and during the drain are served normally; the only 503 is /readyz draining; in-flight DB work completes and is durable", async () => {
    const before = await restartCount();
    const { server, port, pool } = await boot({ drainDelayMs: 700, gracePeriodMs: 4000, hardTimeoutMs: 10000 });
    const login = await request(port, "POST", "/v1/auth/login/email", {
      body: { email: "admin-a@example.com", password: "correct-horse-battery" },
    });
    expect(login.status).toBe(200);
    const token = JSON.parse(login.body).token as string;
    const auth = { authorization: `Bearer ${token}` };

    const statuses: Array<{ path: string; status: number }> = [];
    const track = async (path: string, init?: Parameters<typeof request>[3]) => {
      const r = await request(port, path.startsWith("POST ") ? "POST" : "GET", path.replace(/^POST /, ""), init);
      statuses.push({ path, status: r.status });
      return r;
    };

    // In flight when shutdown starts: a slow read and a slow write transaction.
    const slowRead = track("/__test/slow-db?ms=1200");
    const slowWrite = track("POST /__test/write-then-sleep?ms=1200", { headers: auth });
    await sleep(200);
    const done = server.shutdown("SIGTERM");
    await sleep(50);

    // During the drain delay the listener is open: normal traffic keeps working.
    for (let i = 0; i < 6; i++) {
      expect((await track("/v1/auth/me", { headers: auth })).status).toBe(200);
    }
    const ready = await track("/readyz");
    expect(ready.status).toBe(503);
    expect(JSON.parse(ready.body)).toEqual({ status: "draining" });
    expect(ready.headers["retry-after"]).toBe("5");
    expect((await track("/livez")).status).toBe(200);

    expect((await slowRead).status).toBe(200);
    expect((await slowWrite).status).toBe(200);
    expect(await done).toBe(0);

    // Every response in the run: no 5xx except the deliberate readiness answer.
    const fiveXX = statuses.filter((s) => s.status >= 500);
    expect(fiveXX).toEqual([{ path: "/readyz", status: 503 }]);
    // The in-flight write committed exactly once and is durable.
    expect(await restartCount()).toBe(before + 1);
    // The pool ended, and after the listener closed, connections are refused at the TCP level (no HTTP status).
    expect((pool as unknown as { ended: boolean }).ended).toBe(true);
    await expect(request(port, "GET", "/livez")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("a request that outlives the grace period is cut, its transaction is rolled back (no partial write), the exit code is 1, and no backend is left running", async () => {
    const before = await restartCount();
    const exits: number[] = [];
    const { server, port, pool } = await boot({ gracePeriodMs: 400, hardTimeoutMs: 6000, exits, appName: "figbloom-restart-cut" });
    const inflight = request(port, "POST", "/__test/write-then-sleep?ms=4000").then(
      (r) => ({ ok: true as const, status: r.status }),
      (e: NodeJS.ErrnoException) => ({ ok: false as const, code: e.code ?? e.message }),
    );
    await sleep(300);
    const code = await server.shutdown("SIGTERM");
    expect(code).toBe(1);
    expect(exits).toEqual([]); // finished before the hard timeout
    const outcome = await inflight;
    // Cut at the socket: never an HTTP 5xx, never a 200.
    expect(outcome.ok).toBe(false);
    expect(await restartCount()).toBe(before); // rolled back
    expect((pool as unknown as { ended: boolean }).ended).toBe(true);
    for (let i = 0; i < 30; i++) {
      const r = await ctx.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'figbloom-restart-cut' AND state <> 'idle'`,
      );
      if (r.rows[0]!.n === 0) return;
      await sleep(100);
    }
    throw new Error("a backend of the shut-down process is still running");
  });

  it("a request on an already-open keep-alive connection while the listener closes is dropped at the socket or answered 503 + Connection: close, with no handler side effect", async () => {
    const before = await restartCount();
    const { server, port } = await boot({ gracePeriodMs: 3000 });
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      // Hold the process open with a slow request so shutdown has something to wait for.
      const slow = request(port, "GET", "/__test/slow-db?ms=1000");
      await sleep(100);
      expect((await request(port, "GET", "/livez", { agent })).status).toBe(200); // keep-alive socket now exists
      const done = server.shutdown("SIGTERM");
      await sleep(30);
      const outcome = await request(port, "POST", "/__test/write-then-sleep?ms=10", { agent }).then(
        (r) => ({ status: r.status, connection: r.headers.connection, body: r.body }),
        (e: NodeJS.ErrnoException) => ({ socketError: e.code ?? e.message }),
      );
      if ("socketError" in outcome) {
        expect(outcome.socketError).toMatch(/ECONNRESET|ECONNREFUSED|socket hang up|EPIPE/);
      } else {
        expect(outcome.status).toBe(503);
        expect(outcome.connection).toBe("close");
        expect(outcome.body).not.toMatch(/stack|postgres|ECONN/i);
      }
      await slow;
      await done;
      expect(await restartCount()).toBe(before); // the write handler never ran (or was refused) in either case
    } finally {
      agent.destroy();
    }
  });

  it("a database stall during shutdown: the pool still ends (stalled connections are destroyed), the exit code is 1, and the hard timeout is not needed", async () => {
    const proxy = new StallProxy({ host: new URL(ctx.runtimeUrl).hostname.replace("localhost", "127.0.0.1"), port: Number(new URL(ctx.runtimeUrl).port || 5432) });
    await proxy.start();
    const exits: number[] = [];
    try {
      const { server, port, pool } = await boot({
        poolUrl: viaProxy(ctx.runtimeUrl, proxy.port),
        config: { clientQueryTimeoutMs: 800, identityStatementTimeoutMs: 500, poolAcquireTimeoutMs: 800 },
        gracePeriodMs: 300,
        hardTimeoutMs: 6000,
        exits,
        appName: "figbloom-restart-stall",
      });
      const inflight = request(port, "GET", "/__test/slow-db?ms=5000").then(
        (r) => ({ status: r.status }),
        (e: NodeJS.ErrnoException) => ({ socketError: e.code ?? e.message }),
      );
      await sleep(250);
      proxy.stall(); // the database stops answering while the request is in flight
      const t0 = Date.now();
      const code = await server.shutdown("SIGTERM");
      expect(code).toBe(1);
      expect(exits).toEqual([]); // not the hard timeout: the pool ended on its own
      expect(Date.now() - t0).toBeLessThan(4000);
      expect((pool as unknown as { ended: boolean }).ended).toBe(true);
      const outcome = await inflight;
      expect("status" in outcome ? outcome.status : 0).not.toBe(500);
      proxy.resume();
      await sleep(200);
      expect(proxy.open).toBe(0); // no connection of the dead process remains
    } finally {
      proxy.resume();
      await proxy.stop();
    }
  });
});
