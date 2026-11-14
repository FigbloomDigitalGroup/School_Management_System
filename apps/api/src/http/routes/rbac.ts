import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { uuidString } from "../schemas.js";
import type { AppPool } from "../../db/pool.js";
import { recordSecurityEvent } from "../../modules/audit/audit.js";
import { ADMIN_AREAS, isAdminArea, mayHoldAdminAreas } from "../../modules/identity/roles.js";
import {
  loadEffectivePermissions,
  mayAdminister,
  requirePermission,
  resolveActingVia,
} from "../../modules/rbac/authorize.js";
import {
  grantOrgAdminDelegations,
  listOrgAdminDelegations,
  loadDelegatedPermissionCodes,
  revokeOrgAdminDelegations,
} from "../../modules/rbac/delegations.js";
import { clientIp } from "../clientIp.js";
import { forbidden, notFound, validationError } from "../errors.js";
import { withTenantRequest } from "../tenantRequest.js";

const SetAreasSchema = z.object({
  userId: uuidString,
  areas: z.array(z.string().max(32)).max(32),
});

const DelegationGrantSchema = z.object({
  delegateUserId: uuidString,
  permissionCodes: z.array(z.string().min(1).max(64)).min(1).max(64),
});

const DelegationRevokeSchema = z.object({
  delegateUserId: uuidString,
  permissionCodes: z.array(z.string().min(1).max(64)).max(64).optional(),
});

export async function registerRbacRoutes(app: FastifyInstance, pool: AppPool): Promise<void> {
  app.get("/v1/rbac/permissions", async (request) => {
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      await requirePermission(tx, auth.authz, "rbac.permissions.read", {
        ip: clientIp(request),
        deferAudit: true,
      });
      const permissions = [...(await loadEffectivePermissions(tx, auth.authz))].sort();
      const delegatedPermissions =
        auth.authz.isOrgAdminForTenant && auth.authz.tenantId && !mayAdminister(auth.authz)
          ? [...(await loadDelegatedPermissionCodes(tx, auth.user.id, auth.authz.tenantId))].sort()
          : [];
      return {
        role: auth.authz.role,
        tenantId: auth.authz.tenantId,
        mayAdminister: mayAdminister(auth.authz),
        isOrgAdminForTenant: auth.authz.isOrgAdminForTenant,
        isSuperAdmin: auth.authz.isSuperAdmin,
        delegatedPermissions,
        actingVia: await resolveActingVia(tx, auth.authz),
        permissions,
      };
    });
  });

  app.get("/v1/rbac/org-delegations", async (request) => {
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      await requirePermission(tx, auth.authz, "rbac.org_delegations.read", {
        ip: clientIp(request),
        deferAudit: true,
      });
      const tenantId = auth.authz.tenantId!;
      const items = await listOrgAdminDelegations(tx, tenantId);
      return { tenantId, items };
    });
  });

  app.post("/v1/rbac/org-delegations", async (request) => {
    const parsed = DelegationGrantSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("delegateUserId and permissionCodes[] are required");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      await requirePermission(tx, auth.authz, "rbac.org_delegations.manage", {
        ip: clientIp(request),
        deferAudit: true,
      });
      const result = await grantOrgAdminDelegations(tx, {
        actor: auth.authz,
        tenantId: auth.authz.tenantId!,
        delegateUserId: parsed.data.delegateUserId,
        permissionCodes: parsed.data.permissionCodes,
        ip: clientIp(request),
      });
      return {
        ok: true,
        tenantId: auth.authz.tenantId,
        delegateUserId: parsed.data.delegateUserId,
        granted: result.granted,
      };
    });
  });

  app.delete("/v1/rbac/org-delegations", async (request) => {
    const parsed = DelegationRevokeSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("delegateUserId is required");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      await requirePermission(tx, auth.authz, "rbac.org_delegations.manage", {
        ip: clientIp(request),
        deferAudit: true,
      });
      const result = await revokeOrgAdminDelegations(tx, {
        actor: auth.authz,
        tenantId: auth.authz.tenantId!,
        delegateUserId: parsed.data.delegateUserId,
        permissionCodes: parsed.data.permissionCodes ?? null,
        ip: clientIp(request),
      });
      return {
        ok: true,
        tenantId: auth.authz.tenantId,
        delegateUserId: parsed.data.delegateUserId,
        revoked: result.revoked,
      };
    });
  });

  app.put("/v1/rbac/staff-areas", async (request) => {
    const parsed = SetAreasSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("userId and areas[] are required");
    return withTenantRequest(pool, app.appConfig, request, async ({ tx, auth }) => {
      await requirePermission(tx, auth.authz, "rbac.staff_areas.manage", {
        ip: clientIp(request),
        deferAudit: true,
      });

      const tenantId = auth.authz.tenantId!;
      if (parsed.data.userId === auth.user.id) {
        throw forbidden("Cannot change your own admin areas");
      }
      if (!parsed.data.areas.every(isAdminArea)) throw validationError("Unknown admin area");
      const areas = [...new Set(parsed.data.areas)].filter(isAdminArea);
      const actingVia = await resolveActingVia(tx, auth.authz);

      // SELECT-only grant on school_memberships cannot take FOR UPDATE.
      // The advisory lock serialises concurrent area edits for this membership.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `staff-areas:${tenantId}:${parsed.data.userId}`,
      ]);
      const target = await tx.query<{ role: string }>(
        `SELECT role FROM school_memberships
         WHERE user_id = $1 AND tenant_id = $2 AND archived_at IS NULL`,
        [parsed.data.userId, tenantId],
      );
      if (!target.rows[0]) throw notFound("Membership not found");
      if (!mayHoldAdminAreas(target.rows[0].role)) {
        throw forbidden("Only teacher or staff memberships may hold admin areas");
      }

      const previous = await tx.query<{ area: string }>(
        `SELECT area FROM staff_area_grants WHERE user_id = $1 AND tenant_id = $2 ORDER BY area`,
        [parsed.data.userId, tenantId],
      );
      await tx.query(`DELETE FROM staff_area_grants WHERE user_id = $1 AND tenant_id = $2`, [
        parsed.data.userId,
        tenantId,
      ]);
      for (const area of areas) {
        await tx.query(
          `INSERT INTO staff_area_grants (tenant_id, user_id, area, granted_by)
           VALUES ($1, $2, $3, $4)`,
          [tenantId, parsed.data.userId, area, auth.user.id],
        );
      }
      await recordSecurityEvent(tx, {
        eventType: "rbac.staff_areas.changed",
        actorUserId: auth.user.id,
        tenantId,
        detail: {
          targetUserId: parsed.data.userId,
          previousAreas: previous.rows.map((r) => r.area),
          areas,
          actingVia,
          actorIsOrgAdmin: auth.authz.isOrgAdminForTenant,
        },
        ip: clientIp(request),
      });

      return {
        ok: true,
        userId: parsed.data.userId,
        areas: [...ADMIN_AREAS].filter((a) => areas.includes(a)),
      };
    });
  });
}
