import type { TxOrIdentity } from "../../db/sql.js";
import { attachDenialAudit } from "../../db/errors.js";
import { forbidden, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { ADMIN_AREAS } from "../identity/roles.js";

/**
 * School-level permissions that may be delegated to an org_admin: EXACTLY the approved policy
 * (owner, 2026-11-12, re-confirmed 2026-11-17): tenant.read, rbac.staff_areas.manage,
 * rbac.school_roles.manage, resource.learner.read and the admin areas EXCEPT `people`.
 *
 * `area.people` is not grantable (owner decision 2026-11-17): it makes the People set effective,
 * which includes learner, staff and document WRITES. Existing active area.people delegations are
 * not revoked (no silent loss of access); they keep working (see loadActiveDelegations) and stay
 * revocable. A future granular model (resource.learner.write, resource.staff.*, resource.document.*
 * as separate delegable codes) is the intended direction and is not part of this change.
 *
 * Deliberately NOT delegable (earlier phases listed them; the owner did not approve them):
 * resource.learner.write, resource.guardian.*, resource.staff.*, resource.school_profile.*,
 * resource.document.*. Guardian access in particular is granted only through the explicit
 * per-person model (staff_resource_grants, FIG-1614). The SQL twin is public.is_delegable_permission
 * (migrations 025 and 026); test/fig1609.hardening.test.ts fails if the two drift.
 */
/** The one code that may no longer be GRANTED but is still honoured where it already exists. */
export const GRANDFATHERED_DELEGATED_CODE = "area.people";

export const DELEGABLE_PERMISSIONS: ReadonlySet<string> = new Set([
  "tenant.read",
  "rbac.staff_areas.manage",
  "rbac.school_roles.manage",
  "resource.learner.read",
  ...ADMIN_AREAS.filter((a) => a !== "people").map((a) => `area.${a}`),
]);

export function isDelegablePermission(code: string): boolean {
  return DELEGABLE_PERMISSIONS.has(code);
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
  db: TxOrIdentity,
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
       -- Legacy rows with a code that is no longer delegable stay on record (and revocable) but are
       -- INERT: they confer nothing. The database predicate is the same one the INSERT guard uses.
       AND (public.is_delegable_permission(d.permission_code)
            OR d.permission_code = '${GRANDFATHERED_DELEGATED_CODE}')
     ORDER BY d.permission_code`,
    [userId, tenantId],
  );
  return result.rows;
}

export async function loadDelegatedPermissionCodes(
  db: TxOrIdentity,
  userId: string,
  tenantId: string,
): Promise<Set<string>> {
  const rows = await loadActiveDelegations(db, userId, tenantId);
  return new Set(rows.map((r) => r.permission_code));
}

/**
 * Recipient eligibility that must hold on EVERY grant and replay, including a re-grant of codes that
 * are already active (no insert happens then, so the database trigger does not run): an active user
 * who is an org_admin of the school's organization.
 */
export async function assertRecipientEligible(
  db: TxOrIdentity,
  userId: string,
  tenantId: string,
): Promise<{ organizationId: string }> {
  const found = await assertOrgAdminOfTenantOrg(db, userId, tenantId);
  const status = await db.query<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [userId]);
  if (status.rows[0]?.status !== "active") throw validationError("Delegate must be an active user");
  return found;
}

export async function assertOrgAdminOfTenantOrg(
  db: TxOrIdentity,
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

/** Who is exercising delegation authority (FIG-1609). Audit `actingVia` for grant/revoke events. */
export type DelegationActingVia = "super_admin" | "school_admin" | "org_admin";
export type DelegationOperation = "grant" | "revoke";

/** Reason classes written to `rbac.org_delegation.denied` audit events. */
export type DelegationDenialReason =
  | "no_authority"
  | "school_suspended"
  | "self_delegation"
  | "not_delegable"
  | "ineligible_recipient"
  | "no_active_delegation";

export interface DelegationActor {
  userId: string;
  via: DelegationActingVia;
  organizationId: string;
  tenantId: string;
}

/** Attach a denial audit (persisted after rollback by withTenantTransaction) to any error. */
function withDenial<E extends Error>(
  err: E,
  input: {
    operation: DelegationOperation;
    reason: DelegationDenialReason;
    actorUserId: string;
    tenantId: string | null;
    extra?: Record<string, unknown>;
    ip?: string | null;
  },
): E {
  attachDenialAudit(err, {
    eventType: "rbac.org_delegation.denied",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { operation: input.operation, reason: input.reason, ...(input.extra ?? {}) },
    ip: input.ip ?? null,
  });
  return err;
}

/**
 * Decide, from identity-plane tables only, whether `userId` holds delegation authority over
 * `tenantId` (FIG-1609). Deliberately independent of buildAuthzContext: that refuses every
 * non-super-admin in a suspended school, but revocation must stay available there.
 *
 *   super_admin  platform role + role permission rbac.org_delegations.manage
 *   school_admin live membership in THIS school + rbac.org_delegations.manage
 *   org_admin    live membership of the organization that owns THIS school (organization
 *                active) + org.delegations.grant / org.delegations.revoke on the org_admin role
 *
 * Suspension is not checked here; grant refuses it separately, revoke allows it.
 * The permission codes are re-read from role_permissions on every call: nothing is cached and
 * no client value is consulted.
 */
export async function resolveDelegationActor(
  db: TxOrIdentity,
  input: { userId: string; tenantId: string; operation: DelegationOperation; ip?: string | null },
): Promise<DelegationActor> {
  // The tenant id is caller-supplied and may not exist; security_audit_events.tenant_id is a
  // foreign key, so an unknown id is recorded in the detail, not in the column.
  let knownTenant = false;
  const deny = (reason: DelegationDenialReason) =>
    withDenial(forbidden("Missing permission"), {
      operation: input.operation,
      reason,
      actorUserId: input.userId,
      tenantId: knownTenant ? input.tenantId : null,
      extra: knownTenant ? undefined : { requestedTenantId: input.tenantId },
      ip: input.ip,
    });

  const tenant = await db.query<{ organization_id: string; org_status: string }>(
    `SELECT t.organization_id, o.status AS org_status
       FROM tenants t JOIN organizations o ON o.id = t.organization_id
      WHERE t.id = $1`,
    [input.tenantId],
  );
  const school = tenant.rows[0];
  if (!school) throw deny("no_authority");
  knownTenant = true;

  const hasRolePermission = async (role: string, code: string): Promise<boolean> => {
    const r = await db.query(`SELECT 1 FROM role_permissions WHERE role = $1 AND permission_code = $2`, [role, code]);
    return (r.rowCount ?? 0) > 0;
  };
  const actor = (via: DelegationActingVia): DelegationActor => ({
    userId: input.userId,
    via,
    organizationId: school.organization_id,
    tenantId: input.tenantId,
  });

  const platform = await db.query(
    `SELECT 1 FROM platform_roles WHERE user_id = $1 AND role = 'super_admin'`,
    [input.userId],
  );
  if ((platform.rowCount ?? 0) > 0 && (await hasRolePermission("super_admin", "rbac.org_delegations.manage"))) {
    return actor("super_admin");
  }

  const member = await db.query(
    `SELECT 1 FROM school_memberships
      WHERE user_id = $1 AND tenant_id = $2 AND role = 'school_admin' AND archived_at IS NULL`,
    [input.userId, input.tenantId],
  );
  if ((member.rowCount ?? 0) > 0 && (await hasRolePermission("school_admin", "rbac.org_delegations.manage"))) {
    return actor("school_admin");
  }

  if (school.org_status === "active") {
    const org = await db.query(
      `SELECT 1 FROM organization_memberships
        WHERE user_id = $1 AND organization_id = $2 AND role = 'org_admin'`,
      [input.userId, school.organization_id],
    );
    const code = input.operation === "grant" ? "org.delegations.grant" : "org.delegations.revoke";
    if ((org.rowCount ?? 0) > 0 && (await hasRolePermission("org_admin", code))) {
      return actor("org_admin");
    }
  }
  throw deny("no_authority");
}

/**
 * Refuses a grant (or the replay of one) on a suspended school, for every actor. Used before the
 * idempotency lookup so a stored success can never be replayed into a suspended school.
 * The database trigger org_delegation_guard re-checks inside the insert and is the race-safe backstop.
 */
export async function assertSchoolAcceptsGrants(
  db: TxOrIdentity,
  actor: DelegationActor,
  ctx: { delegateUserId: string; ip?: string | null },
): Promise<void> {
  const status = await db.query<{ status: string }>(`SELECT status FROM tenants WHERE id = $1`, [actor.tenantId]);
  if (status.rows[0]?.status === "suspended") {
    throw withDenial(forbidden("School is suspended"), {
      operation: "grant",
      reason: "school_suspended",
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      ip: ctx.ip,
      extra: { actingVia: actor.via, organizationId: actor.organizationId, delegateUserId: ctx.delegateUserId },
    });
  }
}

/** The codes of this delegate that are active right now (used to validate an idempotent replay). */
export async function activeDelegationCodes(db: TxOrIdentity, tenantId: string, delegateUserId: string): Promise<Set<string>> {
  const r = await db.query<{ permission_code: string }>(
    `SELECT permission_code FROM org_admin_school_delegations
      WHERE tenant_id = $1 AND delegate_user_id = $2 AND revoked_at IS NULL`,
    [tenantId, delegateUserId],
  );
  return new Set(r.rows.map((x) => x.permission_code));
}

export async function grantOrgAdminDelegations(
  db: TxOrIdentity,
  input: {
    actor: DelegationActor;
    delegateUserId: string;
    permissionCodes: string[];
    ip?: string | null;
  },
): Promise<{ granted: string[] }> {
  const { actor } = input;
  const deny = <E extends Error>(err: E, reason: DelegationDenialReason, extra?: Record<string, unknown>) =>
    withDenial(err, {
      operation: "grant",
      reason,
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      ip: input.ip,
      extra: {
        actingVia: actor.via,
        organizationId: actor.organizationId,
        delegateUserId: input.delegateUserId,
        ...extra,
      },
    });

  // No administrator, super administrator included, may create a delegation on a suspended school.
  // The status is read inside this transaction, not carried over from the authority check.
  await assertSchoolAcceptsGrants(db, actor, { delegateUserId: input.delegateUserId, ip: input.ip });
  if (input.delegateUserId === actor.userId) {
    throw deny(forbidden("Cannot delegate to yourself"), "self_delegation");
  }
  if (!input.permissionCodes.length) throw validationError("permissionCodes required");

  const codes = [...new Set(input.permissionCodes)];
  for (const code of codes) {
    if (!isDelegablePermission(code)) {
      throw deny(validationError(`Permission is not delegable: ${code}`), "not_delegable", {
        permissionCode: code,
      });
    }
  }

  let organizationId: string;
  try {
    ({ organizationId } = await assertRecipientEligible(db, input.delegateUserId, actor.tenantId));
  } catch (err) {
    throw err instanceof Error ? deny(err, "ineligible_recipient") : err;
  }

  // Serialise grant and revoke for one person in one school, so that "already active" and "newly
  // granted" are decided against a stable state and the audit event never names a grantor for a
  // row someone else created (the application role cannot row-lock these tables).
  await lockDelegations(db, actor.tenantId, input.delegateUserId);

  const granted: string[] = [];
  const alreadyActive: string[] = [];
  for (const code of codes) {
    const existing = await db.query<{ id: string }>(
      `SELECT id FROM org_admin_school_delegations
       WHERE tenant_id = $1 AND delegate_user_id = $2 AND permission_code = $3
         AND revoked_at IS NULL`,
      [actor.tenantId, input.delegateUserId, code],
    );
    if ((existing.rowCount ?? 0) > 0) {
      granted.push(code);
      alreadyActive.push(code);
      continue;
    }
    try {
      const inserted = await db.query(
        `INSERT INTO org_admin_school_delegations
           (organization_id, tenant_id, delegate_user_id, permission_code, granted_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [organizationId, actor.tenantId, input.delegateUserId, code, actor.userId],
      );
      if ((inserted.rowCount ?? 0) === 0) {
        // Backstop: the unique index kept another row. It is theirs, not this actor's grant.
        granted.push(code);
        alreadyActive.push(code);
        continue;
      }
    } catch (err) {
      // Race-safe backstop: the org_delegation_guard trigger locks the school and recipient rows.
      const e = err as { code?: string; message?: string };
      if (e.code === "55000" && e.message === "school_suspended") {
        throw deny(forbidden("School is suspended"), "school_suspended");
      }
      if (e.code === "55000" && e.message === "recipient_not_active") {
        throw deny(validationError("Delegate must be an active user"), "ineligible_recipient", { cause: "recipient_not_active" });
      }
      if (e.code === "23514" && e.message === "permission_not_delegable") {
        throw deny(validationError(`Permission is not delegable: ${code}`), "not_delegable", { permissionCode: code });
      }
      throw err;
    }
    granted.push(code);
  }

  await recordSecurityEvent(db, {
    eventType: "rbac.org_delegation.granted",
    actorUserId: actor.userId,
    tenantId: actor.tenantId,
    detail: {
      operation: "grant",
      outcome: "granted",
      delegateUserId: input.delegateUserId,
      organizationId,
      permissionCodes: granted,
      // Codes that were already active keep their original grantor and are not re-attributed.
      newlyGranted: granted.filter((c) => !alreadyActive.includes(c)),
      alreadyActive,
      grantedBy: actor.userId,
      actingVia: actor.via,
    },
    ip: input.ip ?? null,
  });

  return { granted };
}

async function lockDelegations(db: TxOrIdentity, tenantId: string, userId: string): Promise<void> {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `org-delegation:${tenantId}:${userId}`,
  ]);
}

export async function revokeOrgAdminDelegations(
  db: TxOrIdentity,
  input: {
    actor: DelegationActor;
    delegateUserId: string;
    permissionCodes?: string[] | null;
    ip?: string | null;
  },
): Promise<{ revoked: string[] }> {
  const { actor } = input;
  await lockDelegations(db, actor.tenantId, input.delegateUserId);
  const params: unknown[] = [actor.tenantId, input.delegateUserId, actor.userId];
  let filter = "";
  if (input.permissionCodes?.length) {
    filter = ` AND permission_code = ANY($4::text[])`;
    params.push(input.permissionCodes);
  }

  // Scoped by the school the actor was authorised for (and, through the composite foreign key,
  // by its organization). Allowed on a suspended school: revocation only removes privilege.
  const updated = await db.query<{ permission_code: string; granted_by: string }>(
    `UPDATE org_admin_school_delegations
     SET revoked_at = now(), revoked_by = $3
     WHERE tenant_id = $1 AND delegate_user_id = $2 AND revoked_at IS NULL
     ${filter}
     RETURNING permission_code, granted_by`,
    params,
  );

  if ((updated.rowCount ?? 0) === 0) {
    throw withDenial(notFound("No active delegation to revoke"), {
      operation: "revoke",
      reason: "no_active_delegation",
      actorUserId: actor.userId,
      tenantId: actor.tenantId,
      ip: input.ip,
      extra: { actingVia: actor.via, organizationId: actor.organizationId, delegateUserId: input.delegateUserId },
    });
  }

  const rows = [...updated.rows].sort((a, b) => a.permission_code.localeCompare(b.permission_code));
  const revoked = rows.map((r) => r.permission_code);
  await recordSecurityEvent(db, {
    eventType: "rbac.org_delegation.revoked",
    actorUserId: actor.userId,
    tenantId: actor.tenantId,
    detail: {
      operation: "revoke",
      outcome: "revoked",
      delegateUserId: input.delegateUserId,
      organizationId: actor.organizationId,
      permissionCodes: revoked,
      // The grantor of every revoked delegation, which may differ from the actor.
      originalGrantors: rows.map((r) => ({ permissionCode: r.permission_code, grantedBy: r.granted_by })),
      revokedBy: actor.userId,
      actingVia: actor.via,
    },
    ip: input.ip ?? null,
  });

  return { revoked };
}

export type DelegationListStatus = "active" | "revoked" | "all";

export type OrgDelegationListRow = {
  id: string;
  delegateUserId: string;
  permissionCode: string;
  grantedBy: string;
  /** ISO-8601 UTC with microseconds from PostgreSQL (cursor key). */
  createdAt: string;
  revokedAt: string | null;
};

/**
 * SQL keyset page for org-admin delegations.
 * ORDER BY created_at DESC, id ASC — mixed-direction predicate (FIG-1621):
 * `created_at < $ts OR (created_at = $ts AND id > $id)`.
 */
export async function listOrgAdminDelegationsPage(
  db: TxOrIdentity,
  input: {
    tenantId: string;
    status?: DelegationListStatus;
    limit: number;
    after?: { createdAt: string; id: string } | null;
  },
): Promise<OrgDelegationListRow[]> {
  const status = input.status ?? "active";
  const statusClause =
    status === "active"
      ? "AND revoked_at IS NULL"
      : status === "revoked"
        ? "AND revoked_at IS NOT NULL"
        : "";
  const params: unknown[] = [input.tenantId];
  let keyset = "";
  if (input.after) {
    params.push(input.after.createdAt, input.after.id);
    keyset = `AND (created_at < $${params.length - 1}::timestamptz
                   OR (created_at = $${params.length - 1}::timestamptz AND id > $${params.length}::uuid))`;
  }
  params.push(input.limit);
  const limitParam = `$${params.length}`;
  const result = await db.query<{
    id: string;
    delegate_user_id: string;
    permission_code: string;
    granted_by: string;
    created_at_text: string;
    revoked_at_text: string | null;
  }>(
    `SELECT id, delegate_user_id, permission_code, granted_by,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_text,
            CASE WHEN revoked_at IS NULL THEN NULL
                 ELSE to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            END AS revoked_at_text
     FROM org_admin_school_delegations
     WHERE tenant_id = $1
     ${statusClause}
     ${keyset}
     ORDER BY created_at DESC, id
     LIMIT ${limitParam}`,
    params,
  );
  return result.rows.map((r) => ({
    id: r.id,
    delegateUserId: r.delegate_user_id,
    permissionCode: r.permission_code,
    grantedBy: r.granted_by,
    createdAt: r.created_at_text,
    revokedAt: r.revoked_at_text,
  }));
}

