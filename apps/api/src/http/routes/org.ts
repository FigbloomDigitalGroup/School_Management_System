import type { FastifyInstance } from "fastify";
import type { AppPool } from "../../db/pool.js";
import { withIdentityAccess } from "../../db/identityAccess.js";
import { buildAuthzContext, requirePermission } from "../../modules/rbac/authorize.js";
import { clientIp } from "../clientIp.js";
import { requireSessionAuth } from "../middleware/authContext.js";

/**
 * Organization-level aggregate endpoints (R2-05).
 * Separated from school-scoped tenant.read / learner record access.
 * Identity path only: no tenant context.
 */
export async function registerOrgRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.get("/v1/org/schools", async (request) => {
    return withIdentityAccess(
      pool,
      async (db) => {
        const { user } = await requireSessionAuth(db, request);
        const authz = await buildAuthzContext(db, { userId: user.id, tenantId: null });
        await requirePermission(db, authz, "org.tenants.read", { ip: clientIp(request) });

        const result = await db.query<{
          id: string;
          name: string;
          slug: string;
          status: string;
          organization_id: string;
          organization_name: string;
          organization_slug: string;
        }>(
          `SELECT t.id, t.name, t.slug, t.status,
                  o.id AS organization_id, o.name AS organization_name, o.slug AS organization_slug
           FROM tenants t
           JOIN organizations o ON o.id = t.organization_id
           JOIN organization_memberships om
             ON om.organization_id = o.id
            AND om.user_id = $1
            AND om.role = 'org_admin'
           WHERE o.status = 'active'
           ORDER BY o.name, t.name`,
          [user.id],
        );

        return {
          schools: result.rows.map((r) => ({
            id: r.id,
            name: r.name,
            slug: r.slug,
            status: r.status,
            organizationId: r.organization_id,
            organizationName: r.organization_name,
            organizationSlug: r.organization_slug,
          })),
        };
      },
      { acquireTimeoutMs: app.appConfig.poolAcquireTimeoutMs },
    );
  });
}
