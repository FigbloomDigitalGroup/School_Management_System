import type { Db } from "../../db/pool.js";
import { forbidden, validationError } from "../../http/errors.js";
import type { SchoolRole } from "../identity/roles.js";

export interface SchoolMembership {
  id: string;
  user_id: string;
  tenant_id: string;
  role: SchoolRole;
  login_id: string | null;
  tenant_status: string;
  organization_id: string;
}

export interface TenantRecord {
  id: string;
  name: string;
  slug: string;
  status: string;
  organization_id: string;
  timezone: string;
}

/**
 * Resolve an active school membership for the authenticated user.
 * Never trusts a client-supplied tenant id without this check.
 */
export async function resolveSchoolMembership(
  db: Db,
  userId: string,
  tenantId: string | null | undefined,
): Promise<SchoolMembership> {
  if (!tenantId) throw forbidden("Tenant context required");

  const result = await db.query<SchoolMembership>(
    `SELECT m.id, m.user_id, m.tenant_id, m.role, m.login_id,
            t.status AS tenant_status, t.organization_id
     FROM school_memberships m
     JOIN tenants t ON t.id = m.tenant_id
     WHERE m.user_id = $1
       AND m.tenant_id = $2
       AND m.archived_at IS NULL`,
    [userId, tenantId],
  );
  const membership = result.rows[0];
  if (!membership) throw forbidden("No membership for this school");

  if (membership.tenant_status === "suspended") {
    throw forbidden("School is suspended");
  }
  return membership;
}

export async function assertTenantAccess(
  db: Db,
  userId: string,
  tenantId: string,
  opts?: { allowSuperAdmin?: boolean; allowOrgAdmin?: boolean },
): Promise<{ via: "membership" | "super_admin" | "org_admin"; membership?: SchoolMembership }> {
  if (opts?.allowSuperAdmin) {
    const platform = await db.query(
      `SELECT 1 FROM platform_roles WHERE user_id = $1 AND role = 'super_admin'`,
      [userId],
    );
    if ((platform.rowCount ?? 0) > 0) return { via: "super_admin" };
  }

  if (opts?.allowOrgAdmin) {
    const org = await db.query(
      `SELECT 1
       FROM organization_memberships om
       JOIN tenants t ON t.organization_id = om.organization_id
       JOIN organizations o ON o.id = om.organization_id
       WHERE om.user_id = $1
         AND t.id = $2
         AND om.role = 'org_admin'
         AND o.status = 'active'
         AND t.status <> 'suspended'`,
      [userId, tenantId],
    );
    if ((org.rowCount ?? 0) > 0) return { via: "org_admin" };
  }

  const membership = await resolveSchoolMembership(db, userId, tenantId);
  return { via: "membership", membership };
}

/** Default deny when requested resource tenant differs from established context. */
export function assertSameTenant(contextTenantId: string | null | undefined, resourceTenantId: string): void {
  if (!contextTenantId) throw forbidden("Tenant context required");
  if (contextTenantId !== resourceTenantId) throw forbidden("Cross-tenant access denied");
}

export async function getTenant(db: Db, tenantId: string): Promise<TenantRecord> {
  const result = await db.query<TenantRecord>(
    `SELECT id, name, slug, status, organization_id, timezone FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const tenant = result.rows[0];
  if (!tenant) throw validationError("Unknown tenant");
  return tenant;
}

export async function listMembershipsForUser(db: Db, userId: string): Promise<SchoolMembership[]> {
  const result = await db.query<SchoolMembership>(
    `SELECT m.id, m.user_id, m.tenant_id, m.role, m.login_id,
            t.status AS tenant_status, t.organization_id
     FROM school_memberships m
     JOIN tenants t ON t.id = m.tenant_id
     WHERE m.user_id = $1 AND m.archived_at IS NULL
     ORDER BY m.created_at`,
    [userId],
  );
  return result.rows;
}
