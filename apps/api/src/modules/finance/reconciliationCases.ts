import type { Tx } from "../../db/sql.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";

/**
 * Reconciliation CASE operations (acceptance programme 6.3). Cases are the existing reconciliation findings, extended with
 * an owner, aging, escalation and re-raise history (migration 071). Nothing here settles or fails a payment on its own.
 */

/** Assign (or unassign) the person responsible for a case. The owner must be an active member of the same school. */
export async function assignFinding(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; findingId: string; ownerUserId: string | null; ip?: string | null },
): Promise<{ id: string; owner_user_id: string | null; assigned_at: string | null }> {
  const cur = await tx.query<{ status: string }>(
    `SELECT status FROM finance_reconciliation_findings WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.findingId],
  );
  if (!cur.rows[0]) throw notFound("Finding not found");
  if (cur.rows[0].status !== "open") throw conflict("A resolved finding cannot be reassigned");
  if (input.ownerUserId) {
    const m = await tx.query(
      `SELECT 1 FROM school_memberships WHERE tenant_id = $1 AND user_id = $2 AND archived_at IS NULL AND role::text IN ('school_admin', 'teacher', 'staff')`,
      [input.tenantId, input.ownerUserId],
    );
    if ((m.rowCount ?? 0) === 0) throw validationError("owner_user_id must be an active staff member of this school");
  }
  const res = await tx.query<{ id: string; owner_user_id: string | null; assigned_at: Date | null }>(
    `UPDATE finance_reconciliation_findings
        SET owner_user_id = $3, assigned_at = CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() END
      WHERE tenant_id = $1 AND id = $2 RETURNING id, owner_user_id, assigned_at`,
    [input.tenantId, input.findingId, input.ownerUserId],
  );
  const row = res.rows[0]!;
  await recordSecurityEvent(tx, {
    eventType: "finance.reconciliation.assigned",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { findingId: input.findingId, ownerUserId: input.ownerUserId },
    ip: input.ip,
  });
  return { id: row.id, owner_user_id: row.owner_user_id, assigned_at: row.assigned_at ? row.assigned_at.toISOString() : null };
}

/**
 * Operator recovery for a pending M-Pesa payment that NEVER received a provider checkout id (FIN-1): the prompt was not
 * acknowledged, so there is nothing for the provider to confirm. The operator withdraws it with a reason AND supporting
 * evidence (e.g. the M-Pesa statement or portal check); the act is permission-checked by the route, attributed and audited.
 * Refused whenever ANY provider evidence exists for the payment (a stored callback, any event row), so an operator can
 * never manufacture an outcome against provider evidence. A callback that later arrives for a withdrawn prompt carries a
 * checkout id nothing here knows, so it lands in the unmatched-callback quarantine and is counted in the platform status.
 */
export async function withdrawUnacknowledgedPrompt(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; paymentId: string; reason: string; evidence: string; ip?: string | null },
): Promise<{ payment_id: string; status: "cancelled"; failure_reason: "operator_withdrawn"; resolved_findings: number }> {
  const reason = input.reason.trim();
  const evidence = input.evidence.trim();
  if (reason.length < 3 || reason.length > 300) throw validationError("reason must be 3–300 characters");
  if (evidence.length < 3 || evidence.length > 1000) throw validationError("evidence must be 3–1000 characters");
  const p = await tx.query<{ id: string; status: string; method: string; checkout_request_id: string | null; invoice_id: string }>(
    `SELECT id, status, method, checkout_request_id, invoice_id FROM finance_payments WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.paymentId],
  );
  const pay = p.rows[0];
  if (!pay || pay.method !== "mpesa") throw notFound("Payment not found");
  if (pay.status !== "pending") throw conflict("Only a pending prompt can be withdrawn");
  if (pay.checkout_request_id) throw conflict("This prompt was acknowledged by the provider; reconcile it against the provider instead");
  const ev = await tx.query(`SELECT 1 FROM finance_mpesa_events WHERE tenant_id = $1 AND payment_id = $2 LIMIT 1`, [input.tenantId, input.paymentId]);
  if ((ev.rowCount ?? 0) > 0) throw conflict("Provider evidence exists for this payment; it cannot be withdrawn");
  await tx.query(
    `UPDATE finance_payments SET status = 'cancelled', failure_reason = 'operator_withdrawn' WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
    [input.tenantId, input.paymentId],
  );
  const resolved = await tx.query(
    `UPDATE finance_reconciliation_findings
        SET status = 'resolved', resolved_by = $3, resolved_at = now(), resolution_note = $4, resolution_evidence = $5
      WHERE tenant_id = $1 AND subject_id = $2 AND status = 'open' AND kind IN ('prompt_never_sent', 'stale_pending_prompt', 'dead_settlement_job')`,
    [input.tenantId, input.paymentId, input.actorUserId, `withdrawn: ${reason}`, evidence],
  );
  await recordSecurityEvent(tx, {
    eventType: "finance.mpesa.prompt_withdrawn",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { paymentId: input.paymentId, invoiceId: pay.invoice_id, reason, evidence, actingVia: "operator" },
    ip: input.ip,
  });
  return { payment_id: input.paymentId, status: "cancelled", failure_reason: "operator_withdrawn", resolved_findings: resolved.rowCount ?? 0 };
}
