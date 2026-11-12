import type { Db } from "../../db/pool.js";
import { forbidden, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { ADMIN_AREAS, isAdminArea } from "../identity/roles.js";
import type { AuthzContext } from "./authorize.js";

/** Local copy to avoid circular import with authorize.ts (R2-05: org_admin is never mayAdminister). */
function actorMayAdminister(ctx: AuthzContext): boolean {
  if (ctx.isSuperAdmin) return true;
  return ctx.membership?.role === "school_admin";
}

/** School-level permissions that may be delegated to an org_admin. */
export const DELEGABLE_PERMISSIONS: ReadonlySet<string> = new Set([
  "tenant.read",
  "rbac.staff_areas.manage",
  "rbac.school_roles.manage",
  "resource.learner.read",
  ...ADMIN_AREAS.map((a) => `area.${a}`),
]);

export function isDelegablePermission(code: string): boolean {
  return DELEGABLE_PERMISSIONS.has(code) || (code.startsWith("area.") && isAdminArea(code.slice(5)));
}

export interface ActiveDelegation {
  id: string;
  permission_code: string;
  organization_id: string;
  granted_by: string;
  created_at: Date;
}

/**
 * Effective delegated permissions for an org admin in a school.
 * Requires live org membership, active org, non-suspended school.
 */
export async function loadActiveDelegations(
  db: Db,
  userId: string,
  tenantId: string,
): Promise<ActiveDelegation[]> {
  const result = await db.query<ActiveDelegation>(
    `SELECT d.id, d.permission_code, d.organization_id, d.granted_by, d.created_at
     FROM org_admin_school_delegations d
     JOIN organization_memberships om
       ON om.user_id = d.delegate_user_id
      AND om.organization_id = d.organization_id
      AND om.role = 'org_admin'
     JOIN organizations o ON o.id = d.organization_id AND o.status = 'active'
     JOIN tenants t ON t.id = d.tenant_id
      AND t.organization_id = d.organization_id
      AND t.status <> 'suspended'
     WHERE d.delegate_user_id = $1
       AND d.tenant_id = $2
       AND d.revoked_at IS NULL
     ORDER BY d.permission_code`,
    [userId, tenantId],
  );
  return result.rows;
}

export async function loadDelegatedPermissionCodes(
  db: Db,
  userId: string,
  tenantId: string,
): Promise<Set<string>> {
  const rows = await loadActiveDelegations(db, userId, tenantId);
  return new Set(rows.map((r) => r.permission_code));
}

export async function assertOrgAdminOfTenantOrg(
  db: Db,
  userId: string,
  tenantId: string,
): Promise<{ organizationId: string }> {
  const result = await db.query<{ organization_id: string }>(
    `SELECT t.organization_id
     FROM tenants t
     JOIN organizations o ON o.id = t.organization_id
     JOIN organization_memberships om
       ON om.organization_id = t.organization_id
      AND om.user_id = $1
      AND om.role = 'org_admin'
     WHERE t.id = $2 AND o.status = 'active'`,
    [userId, tenantId],
  );
  const row = result.rows[0];
  if (!row) throw validationError("Delegate must be an org_admin of this school's organization");
  return { organizationId: row.organization_id };
}

export async function grantOrgAdminDelegations(
  db: Db,
  input: {
    actor: AuthzContext;
    tenantId: string;
    delegateUserId: string;
    permissionCodes: string[];
    ip?: string | null;
  },
): Promise<{ granted: string[] }> {
  if (!actorMayAdminister(input.actor)) {
    throw forbidden("Only school administrators may grant org-admin delegations");
  }
  if (input.delegateUserId === input.actor.userId) {
    throw forbidden("Cannot delegate to yourself");
  }
  if (!input.permissionCodes.length) throw validationError("permissionCodes required");

  const codes = [...new Set(input.permissionCodes)];
  for (const code of codes) {
    if (!isDelegablePermission(code)) {
      throw validationError(`Permission is not delegable: ${code}`);
    }
  }

  const { organizationId } = await assertOrgAdminOfTenantOrg(
    db,
    input.delegateUserId,
    input.tenantId,
  );

  const granted: string[] = [];
  for (const code of codes) {
    const existing = await db.query<{ id: string }>(
      `SELECT id FROM org_admin_school_delegations
       WHERE tenant_id = $1 AND delegate_user_id = $2 AND permission_code = $3
         AND revoked_at IS NULL`,
      [input.tenantId, input.delegateUserId, code],
    );
    if ((existing.rowCount ?? 0) > 0) {
      granted.push(code);
      continue;
    }
    await db.query(
      `INSERT INTO org_admin_school_delegations
         (organization_id, tenant_id, delegate_user_id, permission_code, granted_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [organizationId, input.tenantId, input.delegateUserId, code, input.actor.userId],
    );
    granted.push(code);
  }

  await recordSecurityEvent(db, {
    eventType: "rbac.org_delegation.granted",
    actorUserId: input.actor.userId,
    tenantId: input.tenantId,
    detail: {
      delegateUserId: input.delegateUserId,
      organizationId,
      permissionCodes: granted,
      actingVia: input.actor.isSuperAdmin ? "super_admin" : "school_admin",
    },
    ip: input.ip ?? null,
  });

  return { granted };
}

export async function revokeOrgAdminDelegations(
  db: Db,
  input: {
    actor: AuthzContext;
    tenantId: string;
    delegateUserId: string;
    permissionCodes?: string[] | null;
    ip?: string | null;
  },
): Promise<{ revoked: string[] }> {
  if (!actorMayAdminister(input.actor)) {
    throw forbidden("Only school administrators may revoke org-admin delegations");
  }

  const params: unknown[] = [input.tenantId, input.delegateUserId, input.actor.userId];
  let filter = "";
  if (input.permissionCodes?.length) {
    filter = ` AND permission_code = ANY($4::text[])`;
    params.push(input.permissionCodes);
  }

  const updated = await db.query<{ permission_code: string }>(
    `UPDATE org_admin_school_delegations
     SET revoked_at = now(), revoked_by = $3
     WHERE tenant_id = $1 AND delegate_user_id = $2 AND revoked_at IS NULL
     ${filter}
     RETURNING permission_code`,
    params,
  );

  if ((updated.rowCount ?? 0) === 0) throw notFound("No active delegation to revoke");

  const revoked = updated.rows.map((r) => r.permission_code);
  await recordSecurityEvent(db, {
    eventType: "rbac.org_delegation.revoked",
    actorUserId: input.actor.userId,
    tenantId: input.tenantId,
    detail: {
      delegateUserId: input.delegateUserId,
      permissionCodes: revoked,
      actingVia: input.actor.isSuperAdmin ? "super_admin" : "school_admin",
    },
    ip: input.ip ?? null,
  });

  return { revoked };
}

export async function listOrgAdminDelegations(
  db: Db,
  tenantId: string,
): Promise<
  Array<{
    id: string;
    delegateUserId: string;
    permissionCode: string;
    grantedBy: string;
    createdAt: Date;
    revokedAt: Date | null;
  }>
> {
  const result = await db.query<{
    id: string;
    delegate_user_id: string;
    permission_code: string;
    granted_by: string;
    created_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT id, delegate_user_id, permission_code, granted_by, created_at, revoked_at
     FROM org_admin_school_delegations
     WHERE tenant_id = $1
     ORDER BY created_at DESC, permission_code`,
    [tenantId],
  );
  return result.rows.map((r) => ({
    id: r.id,
    delegateUserId: r.delegate_user_id,
    permissionCode: r.permission_code,
    grantedBy: r.granted_by,
    createdAt: r.created_at,
    revokedAt: r.revoked_at,
  }));
}
