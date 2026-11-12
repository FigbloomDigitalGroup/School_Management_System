import type { FastifyInstance } from "fastify";
import type { Db } from "../../db/pool.js";
import { requireTenantAuth } from "../middleware/authContext.js";
import { clientIp } from "../clientIp.js";
import { requirePermission } from "../../modules/rbac/authorize.js";
import { assertSameTenant, getTenant } from "../../modules/tenancy/context.js";
import { notFound } from "../errors.js";

export async function registerTenancyRoutes(app: FastifyInstance, db: Db): Promise<void> {
  app.get("/v1/tenants/:tenantId", async (request) => {
    const auth = await requireTenantAuth(db, request);
    const { tenantId } = request.params as { tenantId: string };

    // Cross-tenant denial: path tenant must match established context
    // (or elevated acting-as via authz already established for that tenant).
    assertSameTenant(auth.authz.tenantId, tenantId);
    await requirePermission(db, auth.authz, "tenant.read", { ip: clientIp(request) });

    try {
      const tenant = await getTenant(db, tenantId);
      return {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        status: tenant.status,
        timezone: tenant.timezone,
        organizationId: tenant.organization_id,
      };
    } catch {
      throw notFound("Tenant not found");
    }
  });
}
