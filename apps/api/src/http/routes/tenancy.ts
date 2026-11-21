import type { FastifyInstance } from "fastify";
import type { AppPool } from "../../db/pool.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import { assertSameTenant, getTenant } from "../../modules/tenancy/context.js";
import { clientIp } from "../clientIp.js";
import { AppError, notFound } from "../errors.js";
import { withTenantRequest } from "../tenantRequest.js";

export async function registerTenancyRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.get("/v1/tenants/:tenantId", async (request) => {
    const { tenantId } = request.params as { tenantId: string };
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      assertSameTenant(auth.authz.tenantId, tenantId);
      await requirePermission(tx, auth.authz, "tenant.read", {
        ip: clientIp(request),
        deferAudit: true,
      });
      try {
        const tenant = await getTenant(tx, tenantId);
        return {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          status: tenant.status,
          timezone: tenant.timezone,
          organizationId: tenant.organization_id,
        };
      } catch (err) {
        // Only a genuine not-found/forbidden is a 404. A database failure (timeout, outage,
        // permission) must surface as 503/500, not masquerade as a missing school.
        if (err instanceof AppError && (err.statusCode === 404 || err.statusCode === 403)) {
          throw notFound("Tenant not found");
        }
        throw err;
      }
    });
  });
}
