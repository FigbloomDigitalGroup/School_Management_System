import type { FastifyInstance } from "fastify";
import type { Db } from "../../db/pool.js";

export async function registerHealthRoutes(app: FastifyInstance, db: Db): Promise<void> {
  const handler = async () => {
    await db.query("SELECT 1");
    return { status: "ok", service: "figbloom-api", phase: "P1-A" };
  };
  app.get("/health", handler);
  app.get("/v1/health", handler);
}
