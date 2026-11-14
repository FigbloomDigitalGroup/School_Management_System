import type { FastifyInstance } from "fastify";
import type { AppPool } from "../../db/pool.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import { assertSameTenant } from "../../modules/tenancy/context.js";
import { clientIp } from "../clientIp.js";
import { withTenantRequest } from "../tenantRequest.js";

/**
 * Representative resource predicate endpoint for P1-A.
 * Later learner modules replace this with real directory APIs (Phase 3).
 */
export async function registerResourceRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.get("/v1/tenants/:tenantId/resources/learners", async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, tenantId);
      await requirePermission(tx, auth.authz, "resource.learner.read", {
        ip: clientIp(request),
        deferAudit: true,
      });
      return {
        tenantId,
        resource: "learners",
        access: "granted",
        note: "Representative P1-A predicate; directory data arrives in Phase 3",
      };
    });
  });
}
