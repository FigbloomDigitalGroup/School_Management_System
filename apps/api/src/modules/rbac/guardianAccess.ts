import type { Tx } from "../../db/sql.js";
import { attachDenialAudit } from "../../db/errors.js";
import { forbidden, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";

/**
 * FIG-1614 Option D (owner-approved): explicit per-person guardian read/write grants.
 *
 * A teacher or staff member holds resource.guardian.read and/or resource.guardian.write only
 * through a row in staff_resource_grants made by a school administrator. The two codes are
 * independent, each revocable on its own, and every grant/revoke/refusal is audited.
 * area.people never implies either. Eligibility (active user, live teacher/staff membership in
 * this school) is enforced by a database trigger, so it cannot be raced.
 */
export const GUARDIAN_ACCESS_CODES = ["resource.guardian.read", "resource.guardian.write"] as const;
export type GuardianAccessCode = (typeof GUARDIAN_ACCESS_CODES)[number];

export type GuardianAccessDenialReason =
  | "grantee_not_eligible"
  | "grantee_not_active"
  | "no_active_grant"
  | "school_suspended";

function denied<E extends Error>(
  err: E,
  input: {
    reason: GuardianAccessDenialReason;
    operation: "grant" | "revoke";
    actorUserId: string;
    tenantId: string;
    targetUserId: string;
    ip?: string | null;
  },
): E {
  attachDenialAudit(err, {
    eventType: "rbac.guardian_access.denied",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { operation: input.operation, reason: input.reason, targetUserId: input.targetUserId },
    ip: input.ip ?? null,
  });
  return err;
}

async function lockPerson(tx: Tx, tenantId: string, userId: string): Promise<void> {
  // Serialises grant/revoke for one person in one school (the application role cannot row-lock).
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `guardian-access:${tenantId}:${userId}`,
  ]);
}

export async function grantGuardianAccess(
  tx: Tx,
  input: {
    actorUserId: string;
    tenantId: string;
    userId: string;
    permissionCodes: GuardianAccessCode[];
    ip?: string | null;
  },
): Promise<{ granted: string[]; newlyGranted: string[] }> {
  const codes = [...new Set(input.permissionCodes)].sort();
  // Suspension must never introduce new privileges, for any administrator (the FIG-1609 rule,
  // applied here too): no guardian grant on a suspended school, a platform super administrator
  // included. Revocation stays possible (it only reduces access). A grant that raced a suspension
  // is inert, because the loader and the membership gate refuse a suspended school.
  const school = await tx.query<{ status: string }>(`SELECT status FROM tenants WHERE id = $1`, [input.tenantId]);
  if (school.rows[0]?.status === "suspended") {
    throw denied(forbidden("School is suspended"), {
      reason: "school_suspended",
      operation: "grant",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      targetUserId: input.userId,
      ip: input.ip,
    });
  }
  await lockPerson(tx, input.tenantId, input.userId);
  const newlyGranted: string[] = [];
  for (const code of codes) {
    try {
      const r = await tx.query(
        `INSERT INTO staff_resource_grants (tenant_id, user_id, permission_code, granted_by)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [input.tenantId, input.userId, code, input.actorUserId],
      );
      if ((r.rowCount ?? 0) > 0) newlyGranted.push(code);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (e.code === "55000" && (e.message === "grantee_not_eligible" || e.message === "grantee_not_active")) {
        const eligible = e.message === "grantee_not_eligible";
        throw denied(
          validationError(
            eligible
              ? "Guardian access can only be granted to an active teacher or staff member of this school"
              : "Guardian access cannot be granted to a disabled user",
          ),
          {
            reason: e.message,
            operation: "grant",
            actorUserId: input.actorUserId,
            tenantId: input.tenantId,
            targetUserId: input.userId,
            ip: input.ip,
          },
        );
      }
      throw err;
    }
  }
  await recordSecurityEvent(tx, {
    eventType: "rbac.guardian_access.granted",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: {
      operation: "grant",
      outcome: "granted",
      targetUserId: input.userId,
      permissionCodes: codes,
      newlyGranted,
      alreadyActive: codes.filter((c) => !newlyGranted.includes(c)),
      grantedBy: input.actorUserId,
    },
    ip: input.ip ?? null,
  });
  return { granted: codes, newlyGranted };
}

export async function revokeGuardianAccess(
  tx: Tx,
  input: {
    actorUserId: string;
    tenantId: string;
    userId: string;
    permissionCodes?: GuardianAccessCode[] | null;
    ip?: string | null;
  },
): Promise<{ revoked: string[] }> {
  await lockPerson(tx, input.tenantId, input.userId);
  const params: unknown[] = [input.tenantId, input.userId, input.actorUserId];
  let filter = "";
  if (input.permissionCodes?.length) {
    filter = " AND permission_code = ANY($4::text[])";
    params.push(input.permissionCodes);
  }
  const res = await tx.query<{ permission_code: string; granted_by: string }>(
    `UPDATE staff_resource_grants
        SET revoked_at = now(), revoked_by = $3, revoke_reason = 'revoked_by_administrator'
      WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL${filter}
      RETURNING permission_code, granted_by`,
    params,
  );
  if ((res.rowCount ?? 0) === 0) {
    throw denied(notFound("No active guardian access to revoke"), {
      reason: "no_active_grant",
      operation: "revoke",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      targetUserId: input.userId,
      ip: input.ip,
    });
  }
  const rows = [...res.rows].sort((a, b) => a.permission_code.localeCompare(b.permission_code));
  await recordSecurityEvent(tx, {
    eventType: "rbac.guardian_access.revoked",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: {
      operation: "revoke",
      outcome: "revoked",
      reason: "revoked_by_administrator",
      targetUserId: input.userId,
      permissionCodes: rows.map((r) => r.permission_code),
      originalGrantors: rows.map((r) => ({ permissionCode: r.permission_code, grantedBy: r.granted_by })),
      revokedBy: input.actorUserId,
    },
    ip: input.ip ?? null,
  });
  return { revoked: rows.map((r) => r.permission_code) };
}

export async function listGuardianAccess(
  tx: Tx,
  input: { tenantId: string; userId: string },
): Promise<Array<{ permissionCode: string; grantedBy: string; createdAt: string }>> {
  const res = await tx.query<{ permission_code: string; granted_by: string; created_at_text: string }>(
    `SELECT permission_code, granted_by,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_text
       FROM staff_resource_grants
      WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL
      ORDER BY permission_code`,
    [input.tenantId, input.userId],
  );
  return res.rows.map((r) => ({
    permissionCode: r.permission_code,
    grantedBy: r.granted_by,
    createdAt: r.created_at_text,
  }));
}

