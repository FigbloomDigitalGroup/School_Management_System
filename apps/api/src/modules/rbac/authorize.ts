import type { Db } from "../../db/pool.js";
import { forbidden } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import {
  ADMIN_AREAS,
  isAdminArea,
  mayHoldAdminAreas,
  type AdminArea,
  type AppRole,
} from "../identity/roles.js";
import type { SchoolMembership } from "../tenancy/context.js";
import { loadDelegatedPermissionCodes } from "./delegations.js";

export interface AuthzContext {
  userId: string;
  role: AppRole;
  tenantId: string | null;
  membership: SchoolMembership | null;
  isSuperAdmin: boolean;
  /** True when the caller is an org_admin of the org that owns the active school (and school not suspended). */
  isOrgAdminForTenant: boolean;
}

/**
 * Full school administrators only.
 * R2-05 (approved): org admins do NOT automatically inherit school-admin privileges.
 * School-level admin for org admins requires explicit delegation (see loadEffectivePermissions).
 */
export function mayAdminister(ctx: AuthzContext): boolean {
  if (ctx.isSuperAdmin) return true;
  return ctx.membership?.role === "school_admin";
}

export async function loadEffectiveAreas(
  db: Db,
  ctx: AuthzContext,
): Promise<ReadonlySet<AdminArea> | "all"> {
  if (!ctx.tenantId) return new Set();
  if (mayAdminister(ctx)) return "all";
  if (!ctx.membership || !mayHoldAdminAreas(ctx.membership.role)) {
    // Org-admin path: areas only via explicit delegation.
    if (ctx.isOrgAdminForTenant) {
      const delegated = await loadDelegatedPermissionCodes(db, ctx.userId, ctx.tenantId);
      const areas = new Set<AdminArea>();
      for (const code of delegated) {
        if (code.startsWith("area.") && isAdminArea(code.slice(5))) {
          areas.add(code.slice(5) as AdminArea);
        }
      }
      return areas;
    }
    return new Set();
  }

  const direct = await db.query<{ area: string }>(
    `SELECT area FROM staff_area_grants WHERE user_id = $1 AND tenant_id = $2`,
    [ctx.userId, ctx.tenantId],
  );
  const viaRoles = await db.query<{ area: string }>(
    `SELECT UNNEST(r.areas) AS area
     FROM school_role_assignments a
     JOIN school_roles r ON r.id = a.role_id
     WHERE a.user_id = $1 AND a.tenant_id = $2 AND r.tenant_id = $2`,
    [ctx.userId, ctx.tenantId],
  );

  const areas = new Set<AdminArea>();
  for (const row of [...direct.rows, ...viaRoles.rows]) {
    if (isAdminArea(row.area)) areas.add(row.area);
  }
  return areas;
}

export async function loadRolePermissions(db: Db, role: AppRole): Promise<Set<string>> {
  const result = await db.query<{ permission_code: string }>(
    `SELECT permission_code FROM role_permissions WHERE role = $1`,
    [role],
  );
  return new Set(result.rows.map((r) => r.permission_code));
}

/**
 * Effective permission set for the identity slice.
 * Default deny: unknown permissions are not granted.
 * R2-05: org_admin school powers come only from active delegations.
 */
export async function loadEffectivePermissions(
  db: Db,
  ctx: AuthzContext,
): Promise<Set<string>> {
  const perms = await loadRolePermissions(db, ctx.role);
  const areas = await loadEffectiveAreas(db, ctx);

  if (areas === "all") {
    for (const area of ADMIN_AREAS) perms.add(`area.${area}`);
    perms.add("resource.learner.read");
    perms.add("tenant.read");
    perms.add("rbac.staff_areas.manage");
    perms.add("rbac.school_roles.manage");
    perms.add("rbac.org_delegations.manage");
    perms.add("rbac.org_delegations.read");
  } else {
    for (const area of areas) perms.add(`area.${area}`);
    if (areas.has("people")) perms.add("resource.learner.read");
  }

  if (ctx.isOrgAdminForTenant && ctx.tenantId && !mayAdminister(ctx)) {
    const delegated = await loadDelegatedPermissionCodes(db, ctx.userId, ctx.tenantId);
    for (const code of delegated) perms.add(code);
    // Delegation of area.people implies learner read if not already explicit.
    if (delegated.has("area.people")) perms.add("resource.learner.read");
  }

  return perms;
}

export async function hasPermission(
  db: Db,
  ctx: AuthzContext,
  permission: string,
): Promise<boolean> {
  if (!permission) return false;
  const perms = await loadEffectivePermissions(db, ctx);
  return perms.has(permission);
}

export async function requirePermission(
  db: Db,
  ctx: AuthzContext,
  permission: string,
  opts?: { ip?: string | null },
): Promise<void> {
  const ok = await hasPermission(db, ctx, permission);
  if (ok) return;
  await recordSecurityEvent(db, {
    eventType: "rbac.permission.denied",
    actorUserId: ctx.userId,
    tenantId: ctx.tenantId,
    detail: { permission, role: ctx.role, isOrgAdminForTenant: ctx.isOrgAdminForTenant },
    ip: opts?.ip ?? null,
  });
  throw forbidden("Missing permission");
}

/**
 * How the actor obtained school-level power for audit trails (R2-05).
 */
export async function resolveActingVia(
  db: Db,
  ctx: AuthzContext,
): Promise<"super_admin" | "school_admin" | "org_admin_delegation" | "membership" | AppRole> {
  if (ctx.isSuperAdmin) return "super_admin";
  if (ctx.membership?.role === "school_admin") return "school_admin";
  if (ctx.isOrgAdminForTenant && ctx.tenantId) {
    const delegated = await loadDelegatedPermissionCodes(db, ctx.userId, ctx.tenantId);
    if (delegated.size > 0) return "org_admin_delegation";
  }
  return ctx.membership?.role ?? ctx.role;
}

/**
 * Build authz context from authenticated identity + optional tenant.
 * Client role/permission payloads are ignored — role comes from membership/platform tables.
 */
export async function buildAuthzContext(
  db: Db,
  input: {
    userId: string;
    tenantId?: string | null;
    membership?: SchoolMembership | null;
  },
): Promise<AuthzContext> {
  const platform = await db.query<{ role: string }>(
    `SELECT role FROM platform_roles WHERE user_id = $1`,
    [input.userId],
  );
  const isSuperAdmin = platform.rows.some((r) => r.role === "super_admin");

  let membership = input.membership ?? null;
  let isOrgAdminForTenant = false;
  let role: AppRole = "student"; // placeholder overwritten

  if (isSuperAdmin && !input.tenantId) {
    role = "super_admin";
  } else if (input.tenantId) {
    if (!membership) {
      const m = await db.query<SchoolMembership>(
        `SELECT m.id, m.user_id, m.tenant_id, m.role, m.login_id,
                t.status AS tenant_status, t.organization_id
         FROM school_memberships m
         JOIN tenants t ON t.id = m.tenant_id
         WHERE m.user_id = $1 AND m.tenant_id = $2 AND m.archived_at IS NULL`,
        [input.userId, input.tenantId],
      );
      membership = m.rows[0] ?? null;
    }

    const org = await db.query(
      `SELECT 1
       FROM organization_memberships om
       JOIN tenants t ON t.organization_id = om.organization_id
       JOIN organizations o ON o.id = om.organization_id
       WHERE om.user_id = $1 AND t.id = $2
         AND om.role = 'org_admin' AND o.status = 'active'
         AND t.status <> 'suspended'`,
      [input.userId, input.tenantId],
    );
    isOrgAdminForTenant = (org.rowCount ?? 0) > 0;

    // AUD-02: suspension is enforced on every request, not only at sign-in.
    // Platform super admins may still act in a suspended school (support / unsuspend).
    if (membership && membership.tenant_status === "suspended" && !isSuperAdmin) {
      throw forbidden("School is suspended");
    }

    if (membership) {
      role = membership.role;
    } else if (isSuperAdmin) {
      role = "super_admin";
    } else if (isOrgAdminForTenant) {
      role = "org_admin";
    } else {
      throw forbidden("No membership for this school");
    }
  } else {
    const orgOnly = await db.query(
      `SELECT 1 FROM organization_memberships WHERE user_id = $1 LIMIT 1`,
      [input.userId],
    );
    if ((orgOnly.rowCount ?? 0) > 0) role = "org_admin";
    else if (isSuperAdmin) role = "super_admin";
    else throw forbidden("Tenant context required");
  }

  return {
    userId: input.userId,
    role,
    tenantId: input.tenantId ?? null,
    membership,
    isSuperAdmin,
    isOrgAdminForTenant,
  };
}
