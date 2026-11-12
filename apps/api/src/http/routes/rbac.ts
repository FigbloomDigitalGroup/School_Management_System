import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { withTransaction } from "../../db/pool.js";
import { requireTenantAuth } from "../middleware/authContext.js";
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
import { ADMIN_AREAS, isAdminArea, mayHoldAdminAreas } from "../../modules/identity/roles.js";
import { validationError, forbidden, notFound } from "../errors.js";
import { recordSecurityEvent } from "../../modules/audit/audit.js";
import { clientIp } from "../clientIp.js";

const SetAreasSchema = z.object({
  userId: z.string().uuid(),
  areas: z.array(z.string().max(32)).max(32),
});

const DelegationGrantSchema = z.object({
  delegateUserId: z.string().uuid(),
  permissionCodes: z.array(z.string().min(1).max(64)).min(1).max(64),
});

const DelegationRevokeSchema = z.object({
  delegateUserId: z.string().uuid(),
  permissionCodes: z.array(z.string().min(1).max(64)).max(64).optional(),
});

export async function registerRbacRoutes(app: FastifyInstance, db: pg.Pool): Promise<void> {
  app.get("/v1/rbac/permissions", async (request) => {
    const auth = await requireTenantAuth(db, request);
    await requirePermission(db, auth.authz, "rbac.permissions.read", { ip: clientIp(request) });
    const permissions = [...(await loadEffectivePermissions(db, auth.authz))].sort();
    const delegatedPermissions =
      auth.authz.isOrgAdminForTenant && auth.authz.tenantId && !mayAdminister(auth.authz)
        ? [...(await loadDelegatedPermissionCodes(db, auth.user.id, auth.authz.tenantId))].sort()
        : [];
    return {
      role: auth.authz.role,
      tenantId: auth.authz.tenantId,
      mayAdminister: mayAdminister(auth.authz),
      isOrgAdminForTenant: auth.authz.isOrgAdminForTenant,
      isSuperAdmin: auth.authz.isSuperAdmin,
      delegatedPermissions,
      actingVia: await resolveActingVia(db, auth.authz),
      permissions,
    };
  });

  app.get("/v1/rbac/org-delegations", async (request) => {
    const auth = await requireTenantAuth(db, request);
    await requirePermission(db, auth.authz, "rbac.org_delegations.read", {
      ip: clientIp(request),
    });
    const tenantId = auth.authz.tenantId!;
    const items = await listOrgAdminDelegations(db, tenantId);
    return { tenantId, items };
  });

  app.post("/v1/rbac/org-delegations", async (request, reply) => {
    const auth = await requireTenantAuth(db, request);
    await requirePermission(db, auth.authz, "rbac.org_delegations.manage", {
      ip: clientIp(request),
    });
    const parsed = DelegationGrantSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("delegateUserId and permissionCodes[] are required");
    const result = await grantOrgAdminDelegations(db, {
      actor: auth.authz,
      tenantId: auth.authz.tenantId!,
      delegateUserId: parsed.data.delegateUserId,
      permissionCodes: parsed.data.permissionCodes,
      ip: clientIp(request),
    });
    return reply.code(200).send({
      ok: true,
      tenantId: auth.authz.tenantId,
      delegateUserId: parsed.data.delegateUserId,
      granted: result.granted,
    });
  });

  app.delete("/v1/rbac/org-delegations", async (request, reply) => {
    const auth = await requireTenantAuth(db, request);
    await requirePermission(db, auth.authz, "rbac.org_delegations.manage", {
      ip: clientIp(request),
    });
    const parsed = DelegationRevokeSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("delegateUserId is required");
    const result = await revokeOrgAdminDelegations(db, {
      actor: auth.authz,
      tenantId: auth.authz.tenantId!,
      delegateUserId: parsed.data.delegateUserId,
      permissionCodes: parsed.data.permissionCodes ?? null,
      ip: clientIp(request),
    });
    return reply.send({
      ok: true,
      tenantId: auth.authz.tenantId,
      delegateUserId: parsed.data.delegateUserId,
      revoked: result.revoked,
    });
  });

  app.put("/v1/rbac/staff-areas", async (request, reply) => {
    const auth = await requireTenantAuth(db, request);
    await requirePermission(db, auth.authz, "rbac.staff_areas.manage", { ip: clientIp(request) });

    const parsed = SetAreasSchema.safeParse(request.body);
    if (!parsed.success) throw validationError("userId and areas[] are required");

    const tenantId = auth.authz.tenantId!;
    if (parsed.data.userId === auth.user.id) {
      throw forbidden("Cannot change your own admin areas");
    }

    if (!parsed.data.areas.every(isAdminArea)) throw validationError("Unknown admin area");
    const areas = [...new Set(parsed.data.areas)].filter(isAdminArea);

    // requirePermission already enforced rbac.staff_areas.manage (native or delegated).
    const actingVia = await resolveActingVia(db, auth.authz);

    await withTransaction(db, async (client) => {
      const target = await client.query<{ role: string }>(
        `SELECT role FROM school_memberships
         WHERE user_id = $1 AND tenant_id = $2 AND archived_at IS NULL
         FOR UPDATE`,
        [parsed.data.userId, tenantId],
      );
      if (!target.rows[0]) throw notFound("Membership not found");
      if (!mayHoldAdminAreas(target.rows[0].role)) {
        throw forbidden("Only teacher or staff memberships may hold admin areas");
      }

      const previous = await client.query<{ area: string }>(
        `SELECT area FROM staff_area_grants WHERE user_id = $1 AND tenant_id = $2 ORDER BY area`,
        [parsed.data.userId, tenantId],
      );
      await client.query(
        `DELETE FROM staff_area_grants WHERE user_id = $1 AND tenant_id = $2`,
        [parsed.data.userId, tenantId],
      );
      for (const area of areas) {
        await client.query(
          `INSERT INTO staff_area_grants (tenant_id, user_id, area, granted_by)
           VALUES ($1, $2, $3, $4)`,
          [tenantId, parsed.data.userId, area, auth.user.id],
        );
      }
      await recordSecurityEvent(client, {
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
    });

    return reply.send({
      ok: true,
      userId: parsed.data.userId,
      areas: [...ADMIN_AREAS].filter((a) => areas.includes(a)),
    });
  });
}
