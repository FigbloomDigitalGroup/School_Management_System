import type { Tx } from "../../db/sql.js";
import { notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { getPayment, type PublicPayment } from "./payments.js";
import { lockInvoiceOfPayment, settlePrompt, storedCallbackReceipts, type SettleOutcome } from "./mpesa.js";
import { classifyResultCode, type StkQueryResult } from "./mpesaProvider.js";

/**
 * Operator reconciliation of a pending M-Pesa prompt (remediation batch 4).
 *
 * A prompt that nobody settles (a lost callback, a provider outage, an unknown result code, a callback without a
 * usable receipt) must not block its invoice for ever, and it must not be fixed by an unaudited database update.
 * A finance administrator (resource.finance.administer, checked by the route) may ask the system to settle it, and
 * the SYSTEM decides from evidence; the operator cannot bypass provider evidence:
 *
 *   evidence                                                                       result
 *   the PROVIDER confirms success + a receipt (stored from an authenticated callback, or typed)   settle (credit, up to the balance)
 *   the PROVIDER confirms a final failure (or the operator attests an unknown, non-processing code)   terminal failure; the slot is released
 *   anything else (provider unreachable, unknown/processing code, conflicting receipts, no checkout id)   stays pending: recorded as inconclusive
 * An unreachable provider is never confirmation and a callback alone is never enough. A receipt typed by an operator is
 * the one receipt the provider did not deliver: it is refused if the quarantine holds it for another checkout, and every
 * credit made on one is raised by reconciliation (operator_receipt_credit).
 *
 * Every act is recorded in the append-only evidence ledger (finance_mpesa_events) with the acting user and the mandatory
 * reason, and in the security audit trail. It is idempotent: a settled prompt answers `already_settled` and changes nothing.
 */
export type OperatorAction = "refresh" | "settle_success" | "mark_failed";

/** What the provider said when the route asked it, outside any transaction. */
export type ProviderView = { kind: "query"; result: StkQueryResult } | { kind: "unavailable" };

export type ReconcileOutcome = Exclude<SettleOutcome, "provider_pending"> | "inconclusive";

export interface ReconcileResult {
  outcome: ReconcileOutcome;
  reason: string | null;
  payment: PublicPayment;
}

const RECEIPT = /^[A-Z0-9]{6,20}$/;

export function normalizeReceipt(raw: string): string {
  return raw.toUpperCase().replace(/\s/g, "");
}

export async function operatorReconcile(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    paymentId: string;
    action: OperatorAction;
    receipt?: string | null;
    note: string;
    provider: ProviderView;
    ip?: string | null;
  },
): Promise<ReconcileResult> {
  const note = input.note.trim();
  const noteLength = [...note].length;
  if (noteLength < 10 || noteLength > 500) throw validationError("note must be 10–500 characters");
  let receipt: string | null = null;
  if (input.action === "settle_success") {
    receipt = input.receipt ? normalizeReceipt(input.receipt) : null;
    if (!receipt || !RECEIPT.test(receipt)) throw validationError("An M-Pesa receipt of 6–20 letters and digits is required to settle a payment");
  } else if (input.receipt) {
    throw validationError("A receipt is only accepted with action settle_success");
  }

  await lockInvoiceOfPayment(tx, input.tenantId, input.paymentId);
  const row = await tx.query<{ status: string; checkout_request_id: string | null }>(
    `SELECT status, checkout_request_id FROM finance_payments WHERE tenant_id = $1 AND id = $2 AND method = 'mpesa' FOR UPDATE`,
    [input.tenantId, input.paymentId],
  );
  const payment = row.rows[0];
  if (!payment) throw notFound("Payment not found");
  const finish = async (outcome: ReconcileOutcome, reason: string | null): Promise<ReconcileResult> => ({
    outcome,
    reason,
    payment: await getPayment(tx, { tenantId: input.tenantId, paymentId: input.paymentId }),
  });
  if (payment.status !== "pending") return finish("already_settled", null); // idempotent: nothing to do, nothing changes

  /** Record an inconclusive act: the prompt stays pending and is escalated to the next person. */
  const inconclusive = async (reason: string, resultCode: number | null, providerView: string | null = null): Promise<ReconcileResult> => {
    if (payment.checkout_request_id) {
      await tx.query(
        `INSERT INTO finance_mpesa_events (tenant_id, payment_id, checkout_request_id, source, result_code, outcome, actor_user_id, operator_note, provider_view)
         VALUES ($1, $2, $3, 'operator', $4, 'operator_inconclusive', $5, $6, $7)`,
        [input.tenantId, input.paymentId, payment.checkout_request_id, resultCode, input.actorUserId, note, providerView],
      );
    }
    await recordSecurityEvent(tx, {
      eventType: "finance.mpesa.operator_inconclusive",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      // no event row exists when the prompt never got a checkout id, so the operator's reason is kept here in that case only
      detail: { paymentId: input.paymentId, action: input.action, reason, providerView, ...(payment.checkout_request_id ? {} : { note }), actingVia: "operator" },
      ip: input.ip,
    });
    return finish("inconclusive", reason);
  };

  if (!payment.checkout_request_id) return inconclusive("no_checkout_id", null); // the provider never acknowledged it: nothing to confirm against

  // The provider's own answer is the ONLY authority. An unreachable provider (or one that has forgotten an old checkout)
  // is never confirmation, and neither is a stored callback on its own: the callback URL secret is its only authentication.
  const q = input.provider.kind === "query" ? input.provider.result : null;
  const providerView = q ? (q.done ? `query:${q.resultCode}` : "query:pending") : "unavailable";
  if (!q) return inconclusive("provider_unavailable", null, providerView);
  if (!q.done) return inconclusive("provider_not_finished", null, providerView);
  let attestsTerminalFailure = false;

  if (input.action === "settle_success") {
    if (q.resultCode !== 0) return inconclusive("provider_says_not_paid", q.resultCode, providerView); // never credit against the provider
    // a typed receipt that the unmatched-callback quarantine holds for ANOTHER checkout id belongs to someone else's payment
    const hit = await tx.query<{ hit: boolean }>(`SELECT public.finance_mpesa_quarantine_has_receipt($1, $2) AS hit`, [receipt, payment.checkout_request_id]);
    if (hit.rows[0]?.hit) return inconclusive("receipt_in_quarantine", q.resultCode, providerView);
  } else if (input.action === "mark_failed") {
    if (q.resultCode === 0) return inconclusive("provider_says_paid", 0, providerView); // never fail a paid prompt
    if (classifyResultCode(q.resultCode) === "processing") return inconclusive("provider_processing", q.resultCode, providerView);
    if (classifyResultCode(q.resultCode) === "unknown" && (await storedCallbackReceipts(tx, input.tenantId, input.paymentId)).length > 0) {
      // the provider answered with a code nobody has documented while an authenticated callback claims the money arrived:
      // that contradiction is not for an operator to settle by attestation
      return inconclusive("callback_claims_paid", q.resultCode, providerView);
    }
    attestsTerminalFailure = true; // an UNKNOWN non-processing code is accepted as terminal only on this explicit act
  }
  const query: StkQueryResult = q;

  const outcome = await settlePrompt(tx, {
    tenantId: input.tenantId,
    paymentId: input.paymentId,
    source: "operator",
    query,
    operator: { userId: input.actorUserId, note, receipt, attestsTerminalFailure, action: input.action, providerView, ip: input.ip ?? null },
  });
  if (outcome === "provider_pending") {
    // conflicting receipts, a duplicate receipt or an unusable code: settlePrompt already recorded the ledger row; escalate
    await recordSecurityEvent(tx, {
      eventType: "finance.mpesa.operator_inconclusive",
      actorUserId: input.actorUserId,
      tenantId: input.tenantId,
      detail: { paymentId: input.paymentId, action: input.action, reason: "evidence_not_usable", providerView, actingVia: "operator" },
      ip: input.ip,
    });
    return finish("inconclusive", "evidence_not_usable");
  }
  return finish(outcome, null);
}

export interface MpesaEventView {
  id: string;
  source: "callback" | "status_query" | "operator";
  outcome: string;
  result_code: number | null;
  result_desc: string | null;
  callback_amount_minor: number | null;
  receipt: string | null;
  msisdn_masked: string | null;
  actor_user_id: string | null;
  operator_note: string | null;
  evidence_basis: string | null;
  provider_view: string | null;
  received_at: string;
}

/** The provider evidence ledger of one M-Pesa payment (what an operator inspects before reconciling). */
export async function listMpesaEvents(
  tx: Tx,
  input: { tenantId: string; paymentId: string; includeNotes: boolean },
): Promise<{ payment_id: string; status: string; checkout_request_id: string | null; event_count: number; events: MpesaEventView[] }> {
  const p = await tx.query<{ checkout_request_id: string | null; status: string }>(
    `SELECT checkout_request_id, status FROM finance_payments WHERE tenant_id = $1 AND id = $2 AND method = 'mpesa'`,
    [input.tenantId, input.paymentId],
  );
  if (!p.rows[0]) throw notFound("Payment not found");
  const ev = await tx.query<{
    id: string;
    source: MpesaEventView["source"];
    outcome: string;
    result_code: number | null;
    result_desc: string | null;
    callback_amount_minor: string | null;
    receipt: string | null;
    msisdn_masked: string | null;
    actor_user_id: string | null;
    operator_note: string | null;
    evidence_basis: string | null;
    provider_view: string | null;
    received_at: Date;
  }>(
    // the NEWEST 200 rows (a flood of redeliveries must not push an operator's own acts out of view), shown oldest first
    `SELECT * FROM (
       SELECT id, source, outcome, result_code, result_desc, callback_amount_minor, receipt, msisdn_masked, actor_user_id, operator_note,
              evidence_basis, provider_view, received_at
         FROM finance_mpesa_events WHERE tenant_id = $1 AND payment_id = $2 ORDER BY received_at DESC, id DESC LIMIT 200) t
      ORDER BY received_at, id`,
    [input.tenantId, input.paymentId],
  );
  const total = await tx.query<{ n: string }>(`SELECT count(*) AS n FROM finance_mpesa_events WHERE tenant_id = $1 AND payment_id = $2`, [
    input.tenantId,
    input.paymentId,
  ]);
  return {
    payment_id: input.paymentId,
    status: p.rows[0].status,
    checkout_request_id: p.rows[0].checkout_request_id,
    event_count: Number(total.rows[0]!.n),
    events: ev.rows.map((r) => ({ ...r, operator_note: input.includeNotes ? r.operator_note : null, callback_amount_minor: r.callback_amount_minor === null ? null : Number(r.callback_amount_minor), received_at: r.received_at.toISOString() })),
  };
}
