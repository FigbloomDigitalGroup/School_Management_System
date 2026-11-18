import { serviceUnavailable } from "../http/errors.js";

/** Thrown when the pool cannot hand out a client within the acquire budget (→ 503). */
export function poolAcquireTimeoutError(
  message = "Database connection acquisition timed out",
): ReturnType<typeof serviceUnavailable> {
  return serviceUnavailable(message, 1);
}

export interface DenialAuditPayload {
  eventType:
    | "rbac.permission.denied"
    | "rbac.org_delegation.denied"
    | "rbac.guardian_access.denied"
    | "rbac.staff_areas.denied";
  actorUserId: string;
  tenantId: string | null;
  detail: Record<string, unknown>;
  ip?: string | null;
}

/** Marker so withTenantTransaction can audit after rollback (AD-3 denial audit). */
export function attachDenialAudit(err: unknown, payload: DenialAuditPayload): void {
  if (err && typeof err === "object") {
    (err as { denialAudit?: DenialAuditPayload }).denialAudit = payload;
  }
}

export function getDenialAudit(err: unknown): DenialAuditPayload | undefined {
  if (!err || typeof err !== "object") return undefined;
  return (err as { denialAudit?: DenialAuditPayload }).denialAudit;
}
