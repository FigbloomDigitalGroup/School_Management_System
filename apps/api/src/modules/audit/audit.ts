import type { Db } from "../../db/pool.js";
import { normalizeIp } from "../../http/ip.js";

export type SecurityEventType =
  | "auth.login.success"
  | "auth.login.failure"
  | "auth.logout"
  | "auth.session.revoked"
  | "auth.tenant.selected"
  | "auth.password.changed"
  | "auth.password_change.required"
  | "rbac.staff_areas.changed"
  | "rbac.school_role.changed"
  | "rbac.org_delegation.granted"
  | "rbac.org_delegation.revoked"
  | "rbac.permission.denied"
  | "identity.external.linked"
  | "rate_limit.denied";

export async function recordSecurityEvent(
  db: Db,
  input: {
    eventType: SecurityEventType;
    actorUserId?: string | null;
    tenantId?: string | null;
    detail?: Record<string, unknown>;
    ip?: string | null;
  },
): Promise<void> {
  // R2-02: never pass a non-inet value into ::inet (zone IDs / garbage → null).
  const ip = normalizeIp(input.ip);
  await db.query(
    `INSERT INTO security_audit_events (actor_user_id, tenant_id, event_type, detail, ip)
     VALUES ($1, $2, $3, $4::jsonb, $5::inet)`,
    [
      input.actorUserId ?? null,
      input.tenantId ?? null,
      input.eventType,
      JSON.stringify(input.detail ?? {}),
      ip,
    ],
  );
}
