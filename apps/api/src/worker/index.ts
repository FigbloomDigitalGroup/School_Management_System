import { hostname } from "node:os";
import { z } from "zod";
import { loadDotEnvForLocal } from "../config.js";
import { createPool, workerPoolOptions } from "../db/pool.js";
import { assertRuntimeRole } from "../db/roleAssert.js";
import { mpesaProviderFromConfig } from "../modules/finance/mpesaProvider.js";
import { logError, logInfo } from "../log.js";
import { workerHandlers } from "./handlers.js";
import { leasePolicyViolation } from "./leasePolicy.js";
import { MaintenanceError, recordHeartbeat, runCycle, runMaintenance } from "./runtime.js";

/**
 * Worker process (Stage 11). Runs as figbloom_worker with its OWN credential (WORKER_DATABASE_URL), its
 * own pool, and refuses to start unless the role passes the same least-privilege assertion as the API
 * (no superuser, no BYPASSRLS, no ownership, no privileged membership).
 * Scheduling needs no manual process: every job is enqueued by the request that creates the need (the
 * transactional outbox), with its own run_after; the worker only polls for due jobs.
 *
 * M-3: every pooled connection carries session statement/lock/idle-in-tx timeouts and a client-side
 * query_timeout so a stalled network cannot hang the single-threaded poll loop indefinitely. External
 * provider HTTP calls happen between DB transactions and use MPESA_HTTP_TIMEOUT_MS separately.
 */
const WorkerConfig = z
  .object({
    databaseUrl: z.string().min(1),
    workerName: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/),
    pollIntervalMs: z.coerce.number().int().min(100).max(60_000).default(2_000),
    leaseSeconds: z.coerce.number().int().min(5).max(3_600).default(300),
    poolMax: z.coerce.number().int().min(1).max(10).default(2),
    poolAcquireTimeoutMs: z.coerce.number().int().min(200).max(30_000).default(2_000),
    /** Autocommit baseline (jobs_claim). Tenant txs override via DEFAULT_TRANSACTION_LIMITS. */
    statementTimeoutMs: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
    lockTimeoutMs: z.coerce.number().int().min(500).max(30_000).default(5_000),
    idleInTransactionSessionTimeoutMs: z.coerce.number().int().min(1_000).max(60_000).default(15_000),
    /** Client-side backstop; must exceed statementTimeoutMs (validated below). */
    clientQueryTimeoutMs: z.coerce.number().int().min(2_000).max(120_000).default(20_000),
    shutdownHardTimeoutMs: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
    mpesaEnv: z.enum(["sandbox", "production"]).default("sandbox"),
    mpesaConsumerKey: z.string().min(1).optional(),
    mpesaConsumerSecret: z.string().min(1).optional(),
    mpesaShortcode: z.string().regex(/^\d{5,7}$/).optional(),
    mpesaPasskey: z.string().min(1).optional(),
    mpesaCallbackUrl: z.string().url().optional(),
    mpesaCallbackSecret: z.string().min(32).max(256).optional(),
    mpesaHttpTimeoutMs: z.coerce.number().int().positive().max(60_000).default(10_000),
  })
  .superRefine((c, ctx) => {
    const lease = leasePolicyViolation(c);
    if (lease) ctx.addIssue({ code: z.ZodIssueCode.custom, message: lease, path: ["leaseSeconds"] });
    if (c.clientQueryTimeoutMs <= c.statementTimeoutMs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "CLIENT_QUERY_TIMEOUT_MS must exceed STATEMENT_TIMEOUT_MS",
        path: ["clientQueryTimeoutMs"],
      });
    }
  });

async function main(): Promise<void> {
  loadDotEnvForLocal();
  const env = process.env;
  const parsed = WorkerConfig.safeParse({
    databaseUrl: env.WORKER_DATABASE_URL,
    workerName: env.WORKER_NAME || `worker-${hostname()}-${process.pid}`.slice(0, 80),
    pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    leaseSeconds: env.WORKER_LEASE_SECONDS,
    poolMax: env.WORKER_POOL_MAX,
    poolAcquireTimeoutMs: env.WORKER_POOL_ACQUIRE_TIMEOUT_MS,
    statementTimeoutMs: env.WORKER_STATEMENT_TIMEOUT_MS,
    lockTimeoutMs: env.WORKER_LOCK_TIMEOUT_MS,
    idleInTransactionSessionTimeoutMs: env.WORKER_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS,
    clientQueryTimeoutMs: env.WORKER_CLIENT_QUERY_TIMEOUT_MS,
    shutdownHardTimeoutMs: env.WORKER_SHUTDOWN_HARD_TIMEOUT_MS,
    mpesaEnv: env.MPESA_ENV || undefined,
    mpesaConsumerKey: env.MPESA_CONSUMER_KEY || undefined,
    mpesaConsumerSecret: env.MPESA_CONSUMER_SECRET || undefined,
    mpesaShortcode: env.MPESA_SHORTCODE || undefined,
    mpesaPasskey: env.MPESA_PASSKEY || undefined,
    mpesaCallbackUrl: env.MPESA_CALLBACK_URL || undefined,
    mpesaCallbackSecret: env.MPESA_CALLBACK_SECRET || undefined,
    mpesaHttpTimeoutMs: env.MPESA_HTTP_TIMEOUT_MS,
  });
  if (!parsed.success) {
    throw new Error(`Invalid worker config: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
  }
  const config = parsed.data;
  const pool = createPool(
    workerPoolOptions({
      databaseUrl: config.databaseUrl,
      poolMax: config.poolMax,
      poolAcquireTimeoutMs: config.poolAcquireTimeoutMs,
      statementTimeoutMs: config.statementTimeoutMs,
      lockTimeoutMs: config.lockTimeoutMs,
      idleInTransactionSessionTimeoutMs: config.idleInTransactionSessionTimeoutMs,
      clientQueryTimeoutMs: config.clientQueryTimeoutMs,
      applicationName: "figbloom-worker",
    }),
  );
  const probe = await pool.connect();
  try {
    await assertRuntimeRole(probe, { expectedRole: "figbloom_worker" });
  } finally {
    probe.release();
  }
  const handlers = workerHandlers(mpesaProviderFromConfig(config));
  let stopping = false;
  let wakePoll: (() => void) | null = null;
  let onStopSignal: (() => void) | null = null;
  const stopPromise = new Promise<void>((resolve) => {
    onStopSignal = resolve;
  });
  const stop = () => {
    stopping = true;
    wakePoll?.();
    onStopSignal?.();
  };
  const sleepPoll = (ms: number) =>
    new Promise<void>((resolve) => {
      if (stopping) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        wakePoll = null;
        resolve();
      }, ms);
      wakePoll = () => {
        clearTimeout(timer);
        wakePoll = null;
        resolve();
      };
    });
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("message", (msg) => {
    if (msg === "SIGTERM" || msg === "SIGINT") {
      process.disconnect?.();
      stop();
    }
  });
  logInfo("worker_started", { outcome: "started" });
  let activeCycle: Promise<unknown> | null = null;
  let lastMaintenance = 0;
  let lastHeartbeat = 0;
  while (!stopping) {
    try {
      if (Date.now() - lastHeartbeat > 30_000) {
        lastHeartbeat = Date.now();
        await recordHeartbeat(pool, config.workerName, "alive").catch((err) => logError("worker_heartbeat_failed", { error_class: err instanceof Error ? err.name : typeof err }));
      }
      if (Date.now() - lastMaintenance > 5 * 60_000) {
        lastMaintenance = Date.now();
        try {
          const m = await runMaintenance(pool, config.workerName);
          if (m.previewsRedacted > 0) logInfo("import_previews_expired", { outcome: String(m.previewsRedacted) });
          if (m.casesRaised > 0) logInfo("finance_cases_raised", { outcome: String(m.casesRaised) });
        } catch (err) {
          logError("worker_maintenance_failed", { error_class: err instanceof Error ? err.name : typeof err, ...(err instanceof MaintenanceError ? { outcome: err.failed.join(",") } : {}) });
        }
      }
      const cyclePromise = runCycle(pool, { workerName: config.workerName, leaseSeconds: config.leaseSeconds, handlers });
      activeCycle = cyclePromise;
      const raced = await Promise.race([
        cyclePromise.then((outcome) => ({ completed: true as const, outcome })),
        stopPromise.then(() => ({ completed: false as const })),
      ]);
      if (!raced.completed) {
        break;
      }
      activeCycle = null;
      if (raced.outcome === "idle") await sleepPoll(config.pollIntervalMs);
    } catch (err) {
      activeCycle = null;
      // Timeouts and transient DB errors must not mark a job successful; runCycle only records success
      // after the handler returns. Log the class only — never connection strings or SQL.
      logError("worker_cycle_failed", { error_class: err instanceof Error ? err.name : typeof err });
      await sleepPoll(config.pollIntervalMs);
    }
  }
  // Bounded shutdown: do not wait forever for in-flight cycle or idle clients (M-3 / M3-B).
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  let shutdownFailed = false;
  await Promise.race([
    (async () => {
      if (activeCycle) {
        await activeCycle.catch((err) => {
          logError("worker_cycle_failed", { error_class: err instanceof Error ? err.name : typeof err });
        });
      }
      await pool.end();
    })(),
    new Promise<void>((_, reject) => {
      shutdownTimer = setTimeout(() => reject(new Error("worker_shutdown_timeout")), config.shutdownHardTimeoutMs);
      shutdownTimer.unref?.();
    }),
  ])
    .catch((err) => {
      shutdownFailed = true;
      logError("worker_shutdown_failed", { error_class: err instanceof Error ? err.name : typeof err });
    })
    .finally(() => {
      if (shutdownTimer) clearTimeout(shutdownTimer);
    });
  if (shutdownFailed) {
    process.exit(1);
  }
  logInfo("worker_stopped", { outcome: "stopped" });
  process.exit(0);
}

main().catch((err) => {
  logError("worker_fatal", { error_class: err instanceof Error ? err.name : typeof err });
  process.exit(1);
});
