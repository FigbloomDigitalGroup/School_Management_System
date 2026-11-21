import type { FastifyInstance } from "fastify";
import type { AppConfig } from "./config.js";
import type { AppPool } from "./db/pool.js";
import { buildApp } from "./app.js";
import { logError, logInfo, logWarn } from "./log.js";

export interface RunningServer {
  app: FastifyInstance;
  /** Resolves to the process exit code: 0 clean, 1 when the grace period was exceeded. Idempotent. */
  shutdown: (reason: string) => Promise<number>;
}

export interface ServerOptions {
  /** Pause between flipping readiness and closing the listener, so a load balancer can stop routing. */
  drainDelayMs?: number;
  /** Time in-flight requests get to finish after the listener closes. */
  gracePeriodMs?: number;
  /** Absolute upper bound for the whole shutdown; then the process is forced down. */
  hardTimeoutMs?: number;
  /** Called with the exit code when the hard timeout fires. Defaults to process.exit. */
  forceExit?: (code: number) => void;
  log?: (message: string) => void;
  /** Runs after the app is built and before it listens (routes can still be added). Test seam. */
  beforeListen?: (app: FastifyInstance) => void | Promise<void>;
}

/**
 * Listen, and own the shutdown sequence (FIG-1617):
 *   1. readiness flips (/readyz 503); optional drain delay
 *   2. stop accepting; in-flight requests finish within the grace period
 *   3. close idle and, past the grace period, remaining connections
 *   4. end the pool
 * Repeated calls share one sequence. A listen failure still closes the pool.
 */
export async function startServer(
  config: AppConfig,
  pool: AppPool,
  opts: ServerOptions = {},
): Promise<RunningServer> {
  const drainDelayMs = opts.drainDelayMs ?? config.shutdownDrainDelayMs;
  const gracePeriodMs = opts.gracePeriodMs ?? config.shutdownGraceMs;
  const hardTimeoutMs = opts.hardTimeoutMs ?? config.shutdownHardTimeoutMs;
  const forceExit = opts.forceExit ?? ((code: number) => process.exit(code));
  // Fixed messages only; the reason is a signal name or a constant, never data.
  const log = opts.log ?? ((m: string) => (m.startsWith("figbloom-api shutdown error") ? logError(m) : m.includes("exceeded") ? logWarn(m) : logInfo(m)));

  const app = await buildApp(config, pool);
  try {
    await opts.beforeListen?.(app);
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    await app.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw err;
  }

  let shutdownPromise: Promise<number> | undefined;
  const shutdown = (reason: string): Promise<number> => {
    shutdownPromise ??= (async () => {
      log(`figbloom-api shutting down (${reason})`);
      const hardTimer = setTimeout(() => forceExit(1), hardTimeoutMs);
      hardTimer.unref();
      let code = 0;
      app.lifecycle.draining = true;
      try {
        if (drainDelayMs > 0) await new Promise((r) => setTimeout(r, drainDelayMs));
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        const closed = app.close().then(() => true);
        const timedOut = new Promise<false>((resolve) => {
          graceTimer = setTimeout(() => resolve(false), gracePeriodMs);
        });
        const finished = await Promise.race([closed, timedOut]);
        if (graceTimer) clearTimeout(graceTimer);
        if (!finished) {
          code = 1;
          log("figbloom-api grace period exceeded; closing remaining connections");
          app.server.closeAllConnections();
          await closed.catch(() => undefined);
        }
      } catch (err) {
        code = 1;
        log(`figbloom-api shutdown error: ${err instanceof Error ? err.name : "unknown"}`);
      }
      try {
        await pool.end();
      } catch {
        code = 1;
      }
      clearTimeout(hardTimer);
      return code;
    })();
    return shutdownPromise;
  };

  return { app, shutdown };
}
