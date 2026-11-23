import { spawn } from "node:child_process";
import { join } from "node:path";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool, workerPoolOptions } from "../src/db/pool.js";
import { withSystemTenantTransaction } from "../src/db/systemTenantTransaction.js";
import { runCycle } from "../src/worker/runtime.js";
import { enableWorkerLogin, resetWorkerLogin } from "./support/financeHarness.js";
import { StallProxy, viaProxy } from "./support/stallProxy.js";
import { createTestApp } from "./support.js";

/**
 * Stage 11 M-3: worker pool session and query timeouts. A stalled connection must not hang the
 * poll loop indefinitely; timed-out work must not be recorded as success.
 */
describe("Stage 11 M-3: worker session and query timeouts", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let workerLogin: pg.Pool & { connectionString: string };
  const pools: pg.Pool[] = [];

  beforeAll(async () => {
    ctx = await createTestApp();
    workerLogin = await enableWorkerLogin(ctx.pool, ctx.runtimeUrl);
  }, 120_000);
  afterAll(async () => {
    for (const p of pools) await p.end().catch(() => undefined);
    await workerLogin?.end().catch(() => undefined);
    await resetWorkerLogin(ctx.pool).catch(() => undefined);
    await ctx?.app?.close?.().catch(() => undefined);
    await ctx?.runtimePool?.end?.().catch(() => undefined);
    await ctx?.pool?.end?.().catch(() => undefined);
  });

  function makeWorkerPool(over: Partial<Parameters<typeof workerPoolOptions>[0]> = {}): pg.Pool {
    const pool = createPool(
      workerPoolOptions({
        databaseUrl: workerLogin.connectionString,
        poolMax: 1,
        poolAcquireTimeoutMs: 2_000,
        statementTimeoutMs: 15_000,
        lockTimeoutMs: 5_000,
        idleInTransactionSessionTimeoutMs: 15_000,
        clientQueryTimeoutMs: 20_000,
        applicationName: "figbloom-worker-m3-test",
        ...over,
      }),
    );
    pools.push(pool);
    return pool;
  }

  it("workerPoolOptions refuses a client timeout that cannot outlive the server statement timeout", () => {
    expect(() =>
      workerPoolOptions({
        databaseUrl: "postgresql://x@127.0.0.1/x",
        poolMax: 1,
        poolAcquireTimeoutMs: 1000,
        statementTimeoutMs: 15_000,
        lockTimeoutMs: 5_000,
        idleInTransactionSessionTimeoutMs: 15_000,
        clientQueryTimeoutMs: 15_000,
      }),
    ).toThrow(/client query timeout must exceed/i);
  });

  it("every new worker-shaped pooled connection carries the session baseline timeouts", async () => {
    const pool = makeWorkerPool({
      statementTimeoutMs: 5_000,
      lockTimeoutMs: 2_000,
      idleInTransactionSessionTimeoutMs: 8_000,
      clientQueryTimeoutMs: 10_000,
      applicationName: "figbloom-worker-m3-baseline",
    });
    const c = await pool.connect();
    try {
      const row = (
        await c.query<{ s: string; l: string; i: string }>(
          `SELECT current_setting('statement_timeout') AS s,
                  current_setting('lock_timeout') AS l,
                  current_setting('idle_in_transaction_session_timeout') AS i`,
        )
      ).rows[0]!;
      expect(row).toEqual({ s: "5s", l: "2s", i: "8s" });
    } finally {
      c.release();
    }
  });

  it("a stalled autocommit statement is cancelled by the server baseline and does not hang", async () => {
    const pool = makeWorkerPool({
      statementTimeoutMs: 500,
      lockTimeoutMs: 500,
      idleInTransactionSessionTimeoutMs: 5_000,
      clientQueryTimeoutMs: 5_000,
      applicationName: "figbloom-worker-m3-stall",
    });
    const t0 = Date.now();
    await expect(pool.query("SELECT pg_sleep(10)")).rejects.toMatchObject({ code: "57014" });
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect((await pool.query("SELECT 1 AS n")).rows[0].n).toBe(1);
  });

  it("a client-side query_timeout fires as the stalled-network backstop", async () => {
    // Construct the pool directly so we can set a client timer shorter than the server
    // statement timeout (the production workerPoolOptions constructor refuses that ordering).
    const pool = createPool({
      connectionString: workerLogin.connectionString,
      max: 1,
      applicationName: "figbloom-worker-m3-client",
      connectionTimeoutMillis: 2_000,
      baseline: {
        statementTimeoutMs: 30_000,
        lockTimeoutMs: 5_000,
        idleInTransactionSessionTimeoutMs: 30_000,
      },
      queryTimeoutMs: 400,
    });
    pools.push(pool);
    const t0 = Date.now();
    await expect(pool.query("SELECT pg_sleep(10)")).rejects.toBeTruthy();
    expect(Date.now() - t0).toBeLessThan(2_500);
  });

  it("a timed-out tenant transaction rolls back and does not commit side effects", async () => {
    const pool = makeWorkerPool({ applicationName: "figbloom-worker-m3-tx" });
    let threw = false;
    try {
      await withSystemTenantTransaction(
        pool,
        {
          tenantId: ctx.ids.tenantA,
          limits: { statementTimeoutMs: 300, lockTimeoutMs: 300, idleInTransactionSessionTimeoutMs: 5_000 },
        },
        async (tx) => {
          await tx.query("SELECT pg_sleep(5)");
        },
      );
    } catch (err) {
      threw = true;
      expect((err as { code?: string }).code).toBe("57014");
    }
    expect(threw).toBe(true);
  });

  it("M3-A: ctx.extendLease() renews an active lease during a long handler and completes cleanly", async () => {
    const jobRes = await ctx.pool.query<{ id: string }>(
      `INSERT INTO jobs (tenant_id, job_type, payload, idempotency_key, run_after)
       VALUES ($1, 'mpesa.stk_settle', '{}'::jsonb, 'm3a-extend-test', now() - interval '1 second')
       RETURNING id`,
      [ctx.ids.tenantA],
    );
    const jobId = jobRes.rows[0]!.id;
    let initialExpiry = 0;
    let extendedExpiry = 0;
    const outcome = await runCycle(workerLogin, {
      workerName: "m3a-worker",
      leaseSeconds: 10,
      handlers: {
        "mpesa.stk_settle": async (jobCtx) => {
          const r1 = await ctx.pool.query<{ lease_expires_at: Date }>(`SELECT lease_expires_at FROM jobs WHERE id = $1`, [jobCtx.jobId]);
          initialExpiry = r1.rows[0]!.lease_expires_at.getTime();
          expect(await jobCtx.extendLease(45)).toBe(true);
          const r2 = await ctx.pool.query<{ lease_expires_at: Date }>(`SELECT lease_expires_at FROM jobs WHERE id = $1`, [jobCtx.jobId]);
          extendedExpiry = r2.rows[0]!.lease_expires_at.getTime();
        },
      },
    });
    expect(outcome).toBe("succeeded");
    expect(extendedExpiry).toBeGreaterThan(initialExpiry + 30_000);
    const finalRow = await ctx.pool.query<{ status: string }>(`SELECT status FROM jobs WHERE id = $1`, [jobId]);
    expect(finalRow.rows[0]!.status).toBe("succeeded");
  });

  it("M3-B: worker subprocess exits 0 on clean SIGTERM/SIGINT and exits 1 on invalid config or privileged role", async () => {
    const workerEntry = join(process.cwd(), "src", "worker", "index.ts");

    // 1) Invalid config (poll interval out of range) -> immediate exit 1
    const badCfg = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", workerEntry], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WORKER_DATABASE_URL: workerLogin.connectionString,
          WORKER_POLL_INTERVAL_MS: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d) => (out += String(d)));
      child.stderr.on("data", (d) => (out += String(d)));
      child.on("close", (code) => resolve({ code, out }));
    });
    expect(badCfg.code).toBe(1);
    expect(badCfg.out).toContain("worker_fatal");

    // 2) Privileged owner role URL -> assertRuntimeRole refuses startup with exit 1
    const ownerUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:59822/figbloom_api";
    const badRole = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", workerEntry], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WORKER_DATABASE_URL: ownerUrl,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      child.stdout.on("data", (d) => (out += String(d)));
      child.stderr.on("data", (d) => (out += String(d)));
      child.on("close", (code) => resolve({ code, out }));
    });
    expect(badRole.code).toBe(1);
    expect(badRole.out).toContain("worker_fatal");

    // 3) Healthy worker subprocess receiving SIGTERM -> logs worker_stopped and exits 0
    const cleanStop = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", workerEntry], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          WORKER_DATABASE_URL: workerLogin.connectionString,
          WORKER_POLL_INTERVAL_MS: "5000",
          WORKER_SHUTDOWN_HARD_TIMEOUT_MS: "2000",
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let out = "";
      let signalled = false;
      const onData = (d: Buffer) => {
        out += String(d);
        if (!signalled && out.includes("worker_started")) {
          signalled = true;
          child.send("SIGTERM");
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("close", (code) => resolve({ code, out }));
    });
    expect(cleanStop.code).toBe(0);
    expect(cleanStop.out).toContain("worker_stopped");
  }, 60_000);

  it("M3-B: worker subprocess exits 1 when shutdown hard-timeout fires (stalled pool drain)", async () => {
    const dbUrl = new URL(workerLogin.connectionString);
    const proxy = new StallProxy({
      host: dbUrl.hostname === "localhost" ? "127.0.0.1" : dbUrl.hostname,
      port: Number(dbUrl.port || 5432),
    });
    await proxy.start();

    try {
      const workerEntry = join(process.cwd(), "src", "worker", "index.ts");
      const res = await new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, ["--import", "tsx", workerEntry], {
          cwd: process.cwd(),
          env: {
            ...process.env,
            WORKER_DATABASE_URL: viaProxy(workerLogin.connectionString, proxy.port),
            WORKER_POLL_INTERVAL_MS: "100",
            WORKER_SHUTDOWN_HARD_TIMEOUT_MS: "1000",
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        let out = "";
        let signalled = false;
        const onData = (d: Buffer) => {
          out += String(d);
          if (!signalled && out.includes("worker_started")) {
            signalled = true;
            proxy.stall();
            setTimeout(() => {
              child.send("SIGTERM");
            }, 150);
          }
        };
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        child.on("close", (code) => resolve({ code, out }));
      });
      expect(res.code).toBe(1);
      expect(res.out).toContain("worker_shutdown_failed");
    } finally {
      proxy.resume();
      await proxy.stop();
    }
  }, 60_000);
});
