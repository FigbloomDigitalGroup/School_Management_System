import type { TxOrIdentity } from "../../db/sql.js";
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
  db: TxOrIdentity,
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

/** Default deny when requested resource tenant differs from established context. */
export function assertSameTenant(contextTenantId: string | null | undefined, resourceTenantId: string): void {
  if (!contextTenantId) throw forbidden("Tenant context required");
  if (contextTenantId !== resourceTenantId) throw forbidden("Cross-tenant access denied");
}

export async function getTenant(db: TxOrIdentity, tenantId: string): Promise<TenantRecord> {
  const result = await db.query<TenantRecord>(
    `SELECT id, name, slug, status, organization_id, timezone FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const tenant = result.rows[0];
  if (!tenant) throw validationError("Unknown tenant");
  return tenant;
}

/** Absolute safety ceiling for /auth/me membership materialisation (never silent truncate). */
export const AUTH_ME_MEMBERSHIP_HARD_CAP = 2_000;

export async function listMembershipsForUser(db: TxOrIdentity, userId: string): Promise<SchoolMembership[]> {
  const result = await db.query<SchoolMembership>(
    `SELECT m.id, m.user_id, m.tenant_id, m.role, m.login_id,
            t.status AS tenant_status, t.organization_id
     FROM school_memberships m
     JOIN tenants t ON t.id = m.tenant_id
     WHERE m.user_id = $1 AND m.archived_at IS NULL
     ORDER BY m.created_at, m.id
     LIMIT $2`,
    [userId, AUTH_ME_MEMBERSHIP_HARD_CAP + 1],
  );
  return result.rows;
}
