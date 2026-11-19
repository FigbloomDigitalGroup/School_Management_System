import type { TxOrIdentity } from "../../db/sql.js";
import { attachDenialAudit } from "../../db/errors.js";
import { forbidden } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { describeError, logError } from "../../log.js";
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

/**
 * Resource permissions implied by holding the People admin area (directly, via a school role, or by
 * org-admin delegation). Exported so tests can pin the exact set: widening it is a security change.
 */
export const PEOPLE_AREA_IMPLIED: readonly string[] = [
  "resource.learner.read",
  "resource.learner.write",
  "resource.staff.read",
  "resource.staff.write",
  "resource.school_profile.read",
  "resource.document.read",
  "resource.document.write",
];

/** Resource permissions implied by the Academics admin area. */
export const ACADEMICS_AREA_IMPLIED: readonly string[] = [
  "resource.academics.read",
  "resource.academics.write",
];

/**
 * Resource permissions implied by the Attendance admin area.
 * Collector PII (`resource.early_sign_out.collector.read`) is NOT implied — least privilege.
 */
export const ATTENDANCE_AREA_IMPLIED: readonly string[] = [
  "resource.attendance.read",
  "resource.attendance.write",
  "resource.early_sign_out.read",
];

/** Active explicit guardian grants of one person in one school (FIG-1614). Empty for a null tenant. */
async function loadExplicitGuardianGrants(
  db: TxOrIdentity,
  userId: string,
  tenantId: string | null,
): Promise<string[]> {
  if (!tenantId) return [];
  const res = await db.query<{ permission_code: string }>(
    // A suspended school exercises no delegated permission (owner decision, FIG-1614 item 8). The
    // membership check upstream already refuses such a request; filtering here as well means the
    // loader is correct on its own, as loadDelegatedPermissionCodes is.
    `SELECT g.permission_code FROM staff_resource_grants g
       JOIN tenants t ON t.id = g.tenant_id
      WHERE g.tenant_id = $1 AND g.user_id = $2 AND g.revoked_at IS NULL
        AND t.status <> 'suspended'`,
    [tenantId, userId],
  );
  return res.rows.map((r) => r.permission_code);
}

export async function loadEffectiveAreas(
  db: TxOrIdentity,
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

export async function loadRolePermissions(db: TxOrIdentity, role: AppRole): Promise<Set<string>> {
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
  db: TxOrIdentity,
  ctx: AuthzContext,
): Promise<Set<string>> {
  const perms = await loadRolePermissions(db, ctx.role);
  const areas = await loadEffectiveAreas(db, ctx);

  if (areas === "all") {
    for (const area of ADMIN_AREAS) perms.add(`area.${area}`);
    perms.add("resource.learner.read");
    perms.add("resource.learner.write");
    perms.add("resource.guardian.read");
    perms.add("resource.guardian.write");
    perms.add("resource.staff.read");
    perms.add("resource.staff.write");
    perms.add("resource.school_profile.read");
    perms.add("resource.school_profile.write");
    perms.add("resource.document.read");
    perms.add("resource.document.write");
    perms.add("resource.academics.read");
    perms.add("resource.academics.write");
    perms.add("resource.attendance.read");
    perms.add("resource.attendance.write");
    perms.add("resource.early_sign_out.read");
    perms.add("resource.early_sign_out.collector.read");
    perms.add("tenant.read");
    perms.add("rbac.staff_areas.manage");
    perms.add("rbac.school_roles.manage");
    perms.add("rbac.org_delegations.manage");
    perms.add("rbac.org_delegations.read");
  } else {
    for (const area of areas) perms.add(`area.${area}`);
    // School-office people area implies learner/staff/document R/W and a READ-ONLY school profile
    // (People workflows). It does NOT imply:
    //  - resource.guardian.* (VS-2 / F-6; FIG-1614 Option D: only an explicit per-person grant, below);
    //  - resource.school_profile.write (F-02: school name, timezone and profile are school
    //    configuration, a full-administrator power; People administrators may not change them).
    // Guardian-subject documents additionally need resource.guardian.* (F-01).
    if (areas.has("people")) {
      for (const code of PEOPLE_AREA_IMPLIED) perms.add(code);
    }
    if (areas.has("academics")) {
      for (const code of ACADEMICS_AREA_IMPLIED) perms.add(code);
    }
    if (areas.has("attendance")) {
      for (const code of ATTENDANCE_AREA_IMPLIED) perms.add(code);
    }
    // FIG-1614 Option D: guardian read/write only through an explicit, revocable per-person grant
    // (staff_resource_grants). Only teacher/staff members can hold one; the database enforces it.
    if (ctx.membership && mayHoldAdminAreas(ctx.membership.role)) {
      for (const code of await loadExplicitGuardianGrants(db, ctx.userId, ctx.tenantId)) perms.add(code);
    }
  }

  if (ctx.isOrgAdminForTenant && ctx.tenantId && !mayAdminister(ctx)) {
    const delegated = await loadDelegatedPermissionCodes(db, ctx.userId, ctx.tenantId);
    for (const code of delegated) perms.add(code);
    // Delegation of area.people implies exactly the same People-area set — not guardian contacts
    // (FIG-1614) and not school-profile writes (F-02). Those need their own explicit delegation.
    if (delegated.has("area.people")) {
      for (const code of PEOPLE_AREA_IMPLIED) perms.add(code);
    }
    if (delegated.has("area.academics")) {
      for (const code of ACADEMICS_AREA_IMPLIED) perms.add(code);
    }
    if (delegated.has("area.attendance")) {
      for (const code of ATTENDANCE_AREA_IMPLIED) perms.add(code);
    }
  }

  return perms;
}

export async function hasPermission(
  db: TxOrIdentity,
  ctx: AuthzContext,
  permission: string,
): Promise<boolean> {
  if (!permission) return false;
  const perms = await loadEffectivePermissions(db, ctx);
  return perms.has(permission);
}

export async function requirePermission(
  db: TxOrIdentity,
  ctx: AuthzContext,
  permission: string,
  opts?: { ip?: string | null; deferAudit?: boolean },
): Promise<void> {
  const ok = await hasPermission(db, ctx, permission);
  if (ok) return;
  const err = forbidden("Missing permission");
  attachDenialAudit(err, {
    eventType: "rbac.permission.denied",
    actorUserId: ctx.userId,
    tenantId: ctx.tenantId,
    detail: { permission, role: ctx.role, isOrgAdminForTenant: ctx.isOrgAdminForTenant },
    ip: opts?.ip ?? null,
  });
  // Inside a tenant transaction the write would roll back with the denial.
  // The transaction primitive persists it after rollback. Identity-path callers
  // write immediately on their autocommit connection.
  if (!opts?.deferAudit) {
    try {
      await recordSecurityEvent(db, {
        eventType: "rbac.permission.denied",
        actorUserId: ctx.userId,
        tenantId: ctx.tenantId,
        detail: { permission, role: ctx.role, isOrgAdminForTenant: ctx.isOrgAdminForTenant },
        ip: opts?.ip ?? null,
      });
    } catch (auditErr) {
      logError("denial_audit_write_failed", { outcome: "inline", ...describeError(auditErr) });
    }
  }
  throw err;
}

/**
 * How the actor obtained school-level power for audit trails (R2-05).
 */
export async function resolveActingVia(
  db: TxOrIdentity,
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
  db: TxOrIdentity,
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
