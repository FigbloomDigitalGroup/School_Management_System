import type { FastifyInstance } from "fastify";
import type { AppPool } from "../../db/pool.js";
import { withIdentityAccess } from "../../db/identityAccess.js";

/**
 * Probes (FIG-1617, OI-5).
 *
 * /livez, /health, /v1/health: liveness. No database. They answer as long as the
 * process can serve HTTP, so an orchestrator never restarts a healthy process
 * because PostgreSQL is briefly unavailable. (/health and /v1/health used to run
 * SELECT 1 and returned a generic 500 on database failure; that is a documented
 * contract change.)
 *
 * /readyz: readiness. 503 while draining (shutdown has begun) or when a bounded
 * database check fails. At most one probe runs at a time and its result is
 * cached for readinessCacheMs, so probes cannot multiply database load.
 * Bodies carry no internal detail.
 */
export interface Lifecycle {
  draining: boolean;
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  pool: AppPool,
  lifecycle: Lifecycle,
): Promise<void> {
  const live = async () => ({ status: "ok", service: "figbloom-api", phase: "P1-A" });
  app.get("/livez", live);
  app.get("/health", live);
  app.get("/v1/health", live);

  let cached: { at: number; ok: boolean } | undefined;
  let inFlight: Promise<boolean> | undefined;

  const probe = async (): Promise<boolean> => {
    const config = app.appConfig;
    const budget = Math.min(config.poolAcquireTimeoutMs, config.readinessTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        withIdentityAccess(
          pool,
          async (db) => {
            await db.query("SELECT 1");
          },
          { acquireTimeoutMs: budget },
        ),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("readiness probe timed out")), config.readinessTimeoutMs);
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  app.get("/readyz", async (_request, reply) => {
    if (lifecycle.draining) {
      reply.header("Retry-After", "5");
      return reply.status(503).send({ status: "draining" });
    }
    const now = Date.now();
    if (!cached || now - cached.at >= app.appConfig.readinessCacheMs) {
      inFlight ??= probe().finally(() => {
        inFlight = undefined;
      });
      const ok = await inFlight;
      cached = { at: Date.now(), ok };
    }
    if (!cached.ok) {
      reply.header("Retry-After", "1");
      return reply.status(503).send({ status: "unavailable" });
    }
    return { status: "ready" };
  });
}
