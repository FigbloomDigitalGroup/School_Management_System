import type { FastifyInstance } from "fastify";
import type { AppPool } from "../../db/pool.js";
import { withIdentityAccess } from "../../db/identityAccess.js";

export async function registerHealthRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  const handler = async () => {
    await withIdentityAccess(
      pool,
      async (db) => {
        await db.query("SELECT 1");
      },
      { acquireTimeoutMs: app.appConfig.poolAcquireTimeoutMs },
    );
    return { status: "ok", service: "figbloom-api", phase: "P1-A" };
  };
  app.get("/health", handler);
  app.get("/v1/health", handler);
}
