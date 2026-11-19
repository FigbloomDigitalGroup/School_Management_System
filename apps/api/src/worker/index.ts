import { hostname } from "node:os";
import { z } from "zod";
import { loadDotEnvForLocal } from "../config.js";
import { createPool } from "../db/pool.js";
import { assertRuntimeRole } from "../db/roleAssert.js";
import { mpesaProviderFromConfig } from "../modules/finance/mpesaProvider.js";
import { logError, logInfo } from "../log.js";
import { workerHandlers } from "./handlers.js";
import { runCycle } from "./runtime.js";

/**
 * Worker process (Stage 11). Runs as figbloom_worker with its OWN credential (WORKER_DATABASE_URL), its
 * own pool, and refuses to start unless the role passes the same least-privilege assertion as the API
 * (no superuser, no BYPASSRLS, no ownership, no privileged membership).
 * Scheduling needs no manual process: every job is enqueued by the request that creates the need (the
 * transactional outbox), with its own run_after; the worker only polls for due jobs.
 */
const WorkerConfig = z.object({
  databaseUrl: z.string().min(1),
  workerName: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/),
  pollIntervalMs: z.coerce.number().int().min(100).max(60_000).default(2_000),
  leaseSeconds: z.coerce.number().int().min(5).max(3_600).default(120),
  poolMax: z.coerce.number().int().min(1).max(10).default(2),
  mpesaEnv: z.enum(["sandbox", "production"]).default("sandbox"),
  mpesaConsumerKey: z.string().min(1).optional(),
  mpesaConsumerSecret: z.string().min(1).optional(),
  mpesaShortcode: z.string().regex(/^\d{5,7}$/).optional(),
  mpesaPasskey: z.string().min(1).optional(),
  mpesaCallbackUrl: z.string().url().optional(),
  mpesaCallbackSecret: z.string().min(32).max(256).optional(),
  mpesaHttpTimeoutMs: z.coerce.number().int().positive().max(60_000).default(10_000),
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
  const pool = createPool({ connectionString: config.databaseUrl, max: config.poolMax, applicationName: "figbloom-worker" });
  const probe = await pool.connect();
  try {
    await assertRuntimeRole(probe, { expectedRole: "figbloom_worker" });
  } finally {
    probe.release();
  }
  const handlers = workerHandlers(mpesaProviderFromConfig(config));
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  logInfo("worker_started", { outcome: "started" });
  while (!stopping) {
    try {
      const outcome = await runCycle(pool, { workerName: config.workerName, leaseSeconds: config.leaseSeconds, handlers });
      if (outcome === "idle") await new Promise((r) => setTimeout(r, config.pollIntervalMs));
    } catch (err) {
      logError("worker_cycle_failed", { error_class: err instanceof Error ? err.name : typeof err });
      await new Promise((r) => setTimeout(r, config.pollIntervalMs));
    }
  }
  await pool.end();
  logInfo("worker_stopped", { outcome: "stopped" });
}

main().catch((err) => {
  logError("worker_fatal", { error_class: err instanceof Error ? err.name : typeof err });
  process.exit(1);
});
