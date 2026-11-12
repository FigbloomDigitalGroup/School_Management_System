import type { FastifyInstance } from "fastify";
import type { Db } from "../../db/pool.js";
import { requireTenantAuth } from "../middleware/authContext.js";
import { clientIp } from "../clientIp.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import { assertSameTenant } from "../../modules/tenancy/context.js";

/**
 * Representative resource predicate endpoint for P1-A.
 * Later learner modules replace this with real directory APIs (Phase 3).
 */
export async function registerResourceRoutes(app: FastifyInstance, db: Db): Promise<void> {
  app.get("/v1/tenants/:tenantId/resources/learners", async (request) => {
    const auth = await requireTenantAuth(db, request);
    const { tenantId } = request.params as { tenantId: string };
    assertSameTenant(auth.authz.tenantId, tenantId);
    await requirePermission(db, auth.authz, "resource.learner.read", { ip: clientIp(request) });
    return {
      tenantId,
      resource: "learners",
      access: "granted",
      note: "Representative P1-A predicate; directory data arrives in Phase 3",
    };
  });
}
