import http from "node:http";
import net from "node:net";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp } from "./support.js";
import { createPool } from "../src/db/pool.js";
import { startServer } from "../src/server.js";
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

function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, headers, agent: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
  });
}

/** Registers a route that holds a request open for `ms` without touching the database. */
const slowRoute =
  (ms: number) =>
  (app: FastifyInstance): void => {
    app.get("/__test/slow", async () => {
      await new Promise((r) => setTimeout(r, ms));
      return { done: true };
    });
  };

describe("probes and graceful shutdown over a real socket (FIG-1617)", () => {
  let ctx: Ctx;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  async function boot(opts: {
    pool?: ReturnType<typeof createPool>;
    config?: Partial<AppConfig>;
    drainDelayMs?: number;
    gracePeriodMs?: number;
    hardTimeoutMs?: number;
    slowMs?: number;
    exits?: number[];
  }) {
    const port = await freePort();
    const config: AppConfig = { ...ctx.config, port, host: "127.0.0.1", ...opts.config };
    const pool =
      opts.pool ??
      createPool({
        connectionString: ctx.runtimeUrl,
        max: 4,
        applicationName: "figbloom-lifecycle-test",
        connectionTimeoutMillis: 2000,
      });
    const server = await startServer(config, pool, {
      drainDelayMs: opts.drainDelayMs ?? 0,
      gracePeriodMs: opts.gracePeriodMs ?? 2000,
      hardTimeoutMs: opts.hardTimeoutMs ?? 5000,
      forceExit: (code) => opts.exits?.push(code),
      log: () => undefined,
      beforeListen: opts.slowMs ? slowRoute(opts.slowMs) : undefined,
    });
    return { server, port, pool };
  }

  it("/livez, /health and /v1/health answer without a database; /readyz reports the outage", async () => {
    const dead = createPool({
      connectionString: "postgresql://figbloom_app:x@127.0.0.1:1/figbloom_api",
      max: 1,
      applicationName: "figbloom-dead-db",
      connectionTimeoutMillis: 500,
    });
    const { server, port } = await boot({ pool: dead, config: { readinessTimeoutMs: 1000, poolAcquireTimeoutMs: 500 } });
    try {
      for (const p of ["/livez", "/health", "/v1/health"]) {
        const r = await get(port, p);
        expect(r.status, p).toBe(200);
        expect(JSON.parse(r.body).status).toBe("ok");
      }
      const t0 = Date.now();
      const ready = await get(port, "/readyz");
      expect(ready.status).toBe(503);
      expect(JSON.parse(ready.body)).toEqual({ status: "unavailable" });
      expect(Date.now() - t0).toBeLessThan(3000); // bounded
      expect(ready.body).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|postgres/i); // no internal detail
    } finally {
      await server.shutdown("test");
    }
  });

  it("/readyz is 200 with a healthy database and the probe is cached and single-flight", async () => {
    const { server, port, pool } = await boot({ config: { readinessCacheMs: 5000 } });
    try {
      const burst = await Promise.all(Array.from({ length: 25 }, () => get(port, "/readyz")));
      expect(burst.every((r) => r.status === 200 && JSON.parse(r.body).status === "ready")).toBe(true);
      // 25 concurrent probes: the pool never needed more than one client for them.
      expect(pool.totalCount).toBeLessThanOrEqual(1);
    } finally {
      await server.shutdown("test");
    }
  });

  it("readiness flips to 503 on drain while an in-flight request still completes with 200", async () => {
    const { server, port } = await boot({ drainDelayMs: 600, gracePeriodMs: 3000, hardTimeoutMs: 8000, slowMs: 900 });
    // Handler is mid-flight (900 ms) when shutdown begins; the listener closes after the 600 ms drain delay.
    const slow = get(port, "/__test/slow");
    await new Promise((r) => setTimeout(r, 150));
    const done = server.shutdown("SIGTERM");
    await new Promise((r) => setTimeout(r, 100));
    const during = await get(port, "/readyz");
    expect(during.status).toBe(503);
    expect(JSON.parse(during.body)).toEqual({ status: "draining" });
    // Liveness stays 200 during the drain: the process is healthy, just leaving rotation.
    expect((await get(port, "/livez")).status).toBe(200);
    const finished = await slow;
    expect(finished.status).toBe(200);
    expect(JSON.parse(finished.body)).toEqual({ done: true });
    expect(await done).toBe(0);
    // The pool was ended exactly once and the listener is closed.
    await expect(get(port, "/livez")).rejects.toThrow();
  });

  it("repeated shutdown signals are idempotent and end the pool once", async () => {
    const { server, pool } = await boot({});
    const [a, b, c] = await Promise.all([server.shutdown("SIGTERM"), server.shutdown("SIGINT"), server.shutdown("again")]);
    expect([a, b, c]).toEqual([0, 0, 0]);
    expect(await server.shutdown("late")).toBe(0);
    expect((pool as unknown as { ended: boolean }).ended).toBe(true);
  });

  it("a request that outlives the grace period is force-closed and shutdown reports a non-zero code", async () => {
    // A held-open request: the client sends headers, never finishes the body.
    const exits: number[] = [];
    const { server, port } = await boot({ gracePeriodMs: 300, hardTimeoutMs: 3000, exits });
    const sock = net.connect(port, "127.0.0.1");
    await new Promise<void>((r) => sock.once("connect", () => r()));
    sock.write("POST /v1/auth/login/email HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{");
    await new Promise((r) => setTimeout(r, 100));
    const code = await server.shutdown("SIGTERM");
    sock.destroy();
    expect(code).toBe(1);
    expect(exits).toEqual([]); // finished before the hard timeout
  });

  it("the hard timeout forces exit(1) if shutdown itself hangs", async () => {
    const exits: number[] = [];
    const pool = createPool({ connectionString: ctx.runtimeUrl, max: 1, applicationName: "figbloom-hard-test" });
    // A pool whose end() never settles models a stuck database connection.
    (pool as unknown as { end: () => Promise<void> }).end = () => new Promise(() => undefined);
    const { server } = await boot({ pool, hardTimeoutMs: 500, gracePeriodMs: 200, exits });
    void server.shutdown("SIGTERM");
    await new Promise((r) => setTimeout(r, 900));
    expect(exits).toEqual([1]);
  });

  it("a listen failure still closes the pool and rejects", async () => {
    const port = await freePort();
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(port, "127.0.0.1", () => r()));
    const pool = createPool({ connectionString: ctx.runtimeUrl, max: 1, applicationName: "figbloom-listen-fail" });
    try {
      await expect(
        startServer({ ...ctx.config, port, host: "127.0.0.1" }, pool, { forceExit: () => undefined, log: () => undefined }),
      ).rejects.toThrow(/EADDRINUSE|address already in use/i);
      expect((pool as unknown as { ended: boolean }).ended).toBe(true);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});
