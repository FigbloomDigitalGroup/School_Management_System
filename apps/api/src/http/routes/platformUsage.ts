import type { FastifyInstance } from "fastify";
import type { AppPool } from "../../db/pool.js";
import { withIdentityAccess, withIdentityUserScope } from "../../db/identityAccess.js";
import { buildAuthzContext, requirePermission } from "../../modules/rbac/authorize.js";
import { clientIp } from "../clientIp.js";
import { requireSessionAuth } from "../middleware/authContext.js";

/**
 * Platform usage counts (slice P4 of apps/api/docs/PLATFORM-CONSOLE.md).
 *
 * Counts only (active learners, active staff memberships, active guardian links per school) via the
 * `platform_usage_counts()` SECURITY DEFINER function (migration 112). Zero personal data, no names, no person IDs.
 * Super administrators only (`platform.usage.read`); `X-Tenant-Id` and session school are ignored.
 */

interface UsageRow {
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  tenant_status: string;
  active_learners: number;
  active_staff_memberships: number;
  active_guardian_links: number;
}

export async function registerPlatformUsageRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  const opts = () => ({ acquireTimeoutMs: app.appConfig.poolAcquireTimeoutMs });

  app.get("/v1/platform/usage", async (request) => {
    const actorUserId = await withIdentityAccess(
      pool,
      async (db) => {
        const { user } = await requireSessionAuth(db, request);
        const authz = await buildAuthzContext(db, { userId: user.id, tenantId: null });
        await requirePermission(db, authz, "platform.usage.read", { ip: clientIp(request) });
        return user.id;
      },
      opts(),
    );

    const rows = await withIdentityUserScope(
      pool,
      actorUserId,
      async (db) => {
        const res = await db.query<UsageRow>(`SELECT * FROM public.platform_usage_counts()`);
        return res.rows;
      },
      opts(),
    );

    const items = rows.map((r) => ({
      tenantId: r.tenant_id,
      name: r.tenant_name,
      slug: r.tenant_slug,
      status: r.tenant_status,
      activeLearners: r.active_learners,
      activeStaff: r.active_staff_memberships,
      activeGuardianLinks: r.active_guardian_links,
    }));

    return {
      items,
      totals: {
        schools: items.length,
        activeLearners: items.reduce((a, i) => a + i.activeLearners, 0),
        activeStaff: items.reduce((a, i) => a + i.activeStaff, 0),
        activeGuardianLinks: items.reduce((a, i) => a + i.activeGuardianLinks, 0),
      },
    };
  });
}
