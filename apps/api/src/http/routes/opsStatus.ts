import type { FastifyInstance } from "fastify";
import type { AppPool } from "../../db/pool.js";
import { withIdentityAccess } from "../../db/identityAccess.js";
import { buildAuthzContext, requirePermission } from "../../modules/rbac/authorize.js";
import { requireSessionAuth } from "../middleware/authContext.js";
import { forbidden } from "../errors.js";

/**
 * GET /v1/platform/ops/status — worker liveness, queue depth/lag, dead jobs, reconciliation backlog and unmatched
 * callbacks as COUNTS AND AGES ONLY (no payloads, no personal or financial detail). Super administrators only.
 * It is the operational surface behind the worker heartbeat and reconciliation sweep (migration 071): a worker that stops
 * shows as a growing last_seen_age_seconds / oldest_due_lag_seconds; alert delivery is an external dependency (no provider).
 */
export async function registerOpsStatusRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.get("/v1/platform/ops/status", async (request) =>
    withIdentityAccess(pool, async (db) => {
      const { user } = await requireSessionAuth(db, request);
      const authz = await buildAuthzContext(db, { userId: user.id, tenantId: null });
      // super administrators only (unknown/other roles fail closed)
      if (!authz.isSuperAdmin) throw forbidden("Insufficient permissions");
      await requirePermission(db, authz, "platform.ops.read");
      const snap = await db.query<{ s: Record<string, unknown> }>(`SELECT public.finance_ops_snapshot() AS s`);
      return { status: snap.rows[0]!.s };
    }),
  );
}
