import type { FastifyInstance } from "fastify";
import type { AppPool } from "../../db/pool.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import { assertSameTenant } from "../../modules/tenancy/context.js";
import { clientIp } from "../clientIp.js";
import { withTenantRequest } from "../tenantRequest.js";

/**
 * P1-A authorization probe. It answers "does this caller hold `resource.learner.read` in this
 * school?" and deliberately returns no directory data — the body is a constant.
 *
 * It is NOT a placeholder for the directory API: the real learner endpoints shipped in Phase 3
 * (`/v1/tenants/:tenantId/learners`, see `routes/learners.ts`). This route stays because the P1-A
 * regression suites use it as the permission-predicate probe that is independent of any domain
 * module (`test/p1a.foundation.test.ts`, `test/p1a.audit-hardening.test.ts`,
 * `test/p1a.r2-remediation.test.ts`). Retiring it is a P1-A decision, not a Stage 8 one.
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
        note: "P1-A permission probe only. The learner directory API is /v1/tenants/{tenantId}/learners.",
      };
    });
  });
}
