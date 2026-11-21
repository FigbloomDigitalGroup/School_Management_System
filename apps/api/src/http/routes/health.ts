import type { FastifyInstance } from "fastify";
import type { AppPool } from "../../db/pool.js";
import { checkDatabaseReady } from "../../db/identityAccess.js";
import { logWarn } from "../../log.js";

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
 * database check fails (acquire budget, statement timeout and a client-side read timeout all apply;
 * a probe that times out gives its connection up rather than leaving it checked out). At most one probe runs at a time and its result is
 * cached for readinessCacheMs, so probes cannot multiply database load.
 * Bodies carry no internal detail. Readiness also runs the session-mint HMAC self-test
 * (migration 015): a database with no provisioned secret, or one that does not match this
 * process's SESSION_MINT_HMAC_KEY, is NOT ready, because login would fail closed. The body
 * says only `reason: "configuration"`; the specific cause is logged without any key material.
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

  type ProbeResult = { ok: boolean; reason?: "configuration" };
  let cached: ({ at: number } & ProbeResult) | undefined;
  let inFlight: Promise<ProbeResult> | undefined;

  const probe = async (): Promise<ProbeResult> => {
    const config = app.appConfig;
    const budget = Math.min(config.poolAcquireTimeoutMs, config.readinessTimeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const hmac = await Promise.race([
        checkDatabaseReady(pool, {
          acquireTimeoutMs: budget,
          queryTimeoutMs: config.readinessTimeoutMs,
          sessionMintHmacKey: config.sessionMintHmacKey,
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("readiness probe timed out")), config.readinessTimeoutMs);
        }),
      ]);
      if (hmac !== undefined && hmac !== "ok") {
        logWarn(`readiness: session mint HMAC self-test failed (${hmac})`);
        return { ok: false, reason: "configuration" };
      }
      return { ok: true };
    } catch {
      return { ok: false };
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
      const result = await inFlight;
      cached = { at: Date.now(), ...result };
    }
    if (!cached.ok) {
      reply.header("Retry-After", "1");
      return reply
        .status(503)
        .send(cached.reason ? { status: "unavailable", reason: cached.reason } : { status: "unavailable" });
    }
    return { status: "ready" };
  });
}
