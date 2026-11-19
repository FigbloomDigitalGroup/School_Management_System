import type { Tx } from "../../db/sql.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { getInvoice } from "./invoices.js";
import { mapPayment, PAYMENT_COLS, type PublicPayment } from "./payments.js";
import { assertWholeShillings, maskMsisdn, MSISDN_PATTERN, toMinor } from "./money.js";
import { unpaidOutcome, type StkPushResult, type StkQueryResult } from "./mpesaProvider.js";

/** A pending prompt for the same phone and amount within this window is returned again (legacy: 2 minutes). */
export const PROMPT_REUSE_SECONDS = 120;

/**
 * Step 1 of an M-Pesa prompt, inside the caller's tenant transaction (legacy mpesa-stk-push):
 * whole shillings, at least KES 1, at most the outstanding balance rounded UP to the next shilling (so a
 * balance with cents can be cleared; the extra cents become a recorded overpayment). One pending prompt
 * per invoice. The settle job is enqueued in the SAME transaction (transactional outbox), so a prompt
 * can never exist without the background check that settles it if no callback arrives.
 */
export async function createPrompt(
  tx: Tx,
  input: {
    tenantId: string;
    actorUserId: string;
    invoice_id: string;
    amount_minor: number;
    msisdn: string;
    settleDelaySeconds: number;
    ip?: string | null;
  },
): Promise<{ payment: PublicPayment; reused: boolean }> {
  if (!MSISDN_PATTERN.test(input.msisdn)) throw validationError("msisdn must be a Kenyan mobile number 2547XXXXXXXX or 2541XXXXXXXX");
  assertWholeShillings(input.amount_minor, "amount_minor");
  const invoice = await getInvoice(tx, { tenantId: input.tenantId, invoiceId: input.invoice_id, lock: true });
  if (invoice.voided_at) throw conflict("The invoice is voided");
  if (invoice.balance_minor === 0) throw conflict("Nothing is owed on this invoice");
  const ceiling = Math.ceil(invoice.balance_minor / 100) * 100;
  if (input.amount_minor > ceiling) throw validationError("That is more than the outstanding balance");

  const pending = await tx.query<{ id: string; msisdn: string; amount_minor: string; recent: boolean }>(
    `SELECT id, msisdn, amount_minor, created_at > now() - make_interval(secs => $3) AS recent
       FROM finance_payments WHERE tenant_id = $1 AND invoice_id = $2 AND status = 'pending' FOR UPDATE`,
    [input.tenantId, input.invoice_id, PROMPT_REUSE_SECONDS],
  );
  const existing = pending.rows[0];
  if (existing) {
    if (existing.recent && existing.msisdn === input.msisdn && toMinor(existing.amount_minor) === input.amount_minor) {
      const row = await tx.query(`SELECT ${PAYMENT_COLS} FROM finance_payments WHERE id = $1`, [existing.id]);
      return { payment: mapPayment(row.rows[0] as Parameters<typeof mapPayment>[0]), reused: true };
    }
    throw conflict("A payment prompt for this invoice is still in progress");
  }
  const res = await tx.query(
    `INSERT INTO finance_payments (tenant_id, invoice_id, amount_minor, method, status, msisdn, recorded_by)
     VALUES ($1, $2, $3, 'mpesa', 'pending', $4, $5) RETURNING ${PAYMENT_COLS}`,
    [input.tenantId, input.invoice_id, input.amount_minor, input.msisdn, input.actorUserId],
  );
  const payment = mapPayment(res.rows[0] as Parameters<typeof mapPayment>[0]);
  await tx.query(
    `INSERT INTO jobs (tenant_id, job_type, payload, idempotency_key, run_after, enqueued_by_user_id)
     VALUES ($1, 'mpesa.stk_settle', $2::jsonb, $3, now() + make_interval(secs => $4), $5)`,
    [input.tenantId, JSON.stringify({ paymentId: payment.id }), `settle:${payment.id}`, input.settleDelaySeconds, input.actorUserId],
  );
  await recordSecurityEvent(tx, {
    eventType: "finance.mpesa.prompt_started",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { paymentId: payment.id, invoiceId: input.invoice_id, amountMinor: input.amount_minor, msisdn: maskMsisdn(input.msisdn) },
    ip: input.ip,
  });
  return { payment, reused: false };
}

/**
 * Step 2, in a NEW transaction after the provider call (never inside the request's first transaction,
 * so no database transaction is held open across the network call). Records the provider's ids, or
 * marks the prompt failed when the provider refused it. A provider that could not be reached leaves the
 * prompt pending without ids: the settle job does NOT auto-fail it (a late push response or unmatched
 * callback must stay recoverable), and reconciliation flags `prompt_never_sent` for a person to check.
 */
export async function recordPushOutcome(
  tx: Tx,
  input: { tenantId: string; paymentId: string; result: StkPushResult | { error: true }; actorUserId: string | null },
): Promise<PublicPayment> {
  const lock = await tx.query<{ status: string }>(
    `SELECT status FROM finance_payments WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.paymentId],
  );
  if (!lock.rows[0]) throw notFound("Payment not found");
  if (lock.rows[0].status === "pending") {
    if ("accepted" in input.result && input.result.accepted) {
      await tx.query(
        `UPDATE finance_payments SET checkout_request_id = $3, merchant_request_id = $4 WHERE tenant_id = $1 AND id = $2`,
        [input.tenantId, input.paymentId, input.result.checkoutRequestId, input.result.merchantRequestId],
      );
    } else if ("accepted" in input.result && !input.result.accepted) {
      await tx.query(
        `UPDATE finance_payments SET status = 'failed', failure_reason = 'unreachable' WHERE tenant_id = $1 AND id = $2`,
        [input.tenantId, input.paymentId],
      );
      await recordSecurityEvent(tx, {
        eventType: "finance.mpesa.prompt_failed",
        actorUserId: input.actorUserId,
        tenantId: input.tenantId,
        detail: { paymentId: input.paymentId, responseCode: input.result.responseCode },
      });
    }
  }
  const row = await tx.query(`SELECT ${PAYMENT_COLS} FROM finance_payments WHERE tenant_id = $1 AND id = $2`, [input.tenantId, input.paymentId]);
  return mapPayment(row.rows[0] as Parameters<typeof mapPayment>[0]);
}

export interface CallbackEvidence {
  resultCode: number | null;
  resultDesc: string | null;
  amountMinor: number | null;
  receipt: string | null;
  msisdn: string | null;
}

export type SettleOutcome = "settled_success" | "settled_failure" | "already_settled" | "provider_pending" | "not_sent";

/**
 * Settle a pending prompt from the PROVIDER'S confirmed answer (STK query), never from callback data
 * alone (legacy mpesa-callback re-confirms every callback). Shared by the callback and the settle job.
 *   * Only a pending prompt changes (row lock; a repeated callback or a second worker is a no-op).
 *   * Success credits the PROMPT'S OWN amount; a callback amount that differs is logged, not credited.
 *   * Success requires a valid receipt (Daraja STK query does not return one; the settle job alone
 *     cannot credit). A colliding receipt leaves the prompt pending with evidence for reconciliation —
 *     never marks a provider-confirmed payment failed.
 *   * Every call writes a finance_mpesa_events row (no secrets; masked phone).
 */
export async function settlePrompt(
  tx: Tx,
  input: {
    tenantId: string;
    paymentId: string;
    source: "callback" | "status_query";
    query: StkQueryResult | { notSent: true };
    evidence?: CallbackEvidence;
  },
): Promise<SettleOutcome> {
  const res = await tx.query<{ status: string; checkout_request_id: string | null; amount_minor: string; invoice_id: string }>(
    `SELECT status, checkout_request_id, amount_minor, invoice_id FROM finance_payments
      WHERE tenant_id = $1 AND id = $2 AND method = 'mpesa' FOR UPDATE`,
    [input.tenantId, input.paymentId],
  );
  const payment = res.rows[0];
  if (!payment) throw notFound("Payment not found");
  const ev = input.evidence;
  const log = async (outcome: SettleOutcome | "provider_error", resultCode: number | null) => {
    await tx.query(
      `INSERT INTO finance_mpesa_events
         (tenant_id, payment_id, checkout_request_id, source, result_code, result_desc, callback_amount_minor, receipt, msisdn_masked, outcome)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        input.tenantId,
        input.paymentId,
        payment.checkout_request_id ?? "not-sent",
        input.source,
        resultCode,
        ev?.resultDesc ? ev.resultDesc.slice(0, 200) : null,
        ev?.amountMinor ?? null,
        ev?.receipt && /^[A-Z0-9]{6,20}$/.test(ev.receipt) ? ev.receipt : null,
        ev?.msisdn && /^254\d{9}$/.test(ev.msisdn) ? maskMsisdn(ev.msisdn) : null,
        outcome,
      ],
    );
  };
  if (payment.status !== "pending") {
    await log("already_settled", ev?.resultCode ?? null);
    return "already_settled";
  }
  if ("notSent" in input.query) {
    await tx.query(`UPDATE finance_payments SET status = 'failed', failure_reason = 'not_sent' WHERE tenant_id = $1 AND id = $2`, [
      input.tenantId,
      input.paymentId,
    ]);
    await log("not_sent", null);
    await recordSecurityEvent(tx, {
      eventType: "finance.mpesa.settled",
      actorUserId: null,
      tenantId: input.tenantId,
      detail: { paymentId: input.paymentId, outcome: "not_sent", actingVia: input.source },
    });
    return "not_sent";
  }
  if (!input.query.done) {
    await log("provider_pending", ev?.resultCode ?? null);
    return "provider_pending";
  }
  const code = input.query.resultCode;
  if (code === 0) {
    const receipt = ev?.receipt && /^[A-Z0-9]{6,20}$/.test(ev.receipt) ? ev.receipt : null;
    // STK query confirms payment but does not return a receipt. Crediting without one leaves a NULL
    // mpesa_receipt that the partial unique index ignores, so the office could later record the same
    // code as a second payment. Keep pending until a unique receipt arrives (normally the callback).
    if (!receipt) {
      await log("provider_pending", code);
      return "provider_pending";
    }
    // The receipt index is system-wide but RLS hides other schools' rows, so a duplicate is detected by
    // the unique index itself, inside a savepoint: never credited twice, nothing about the other school leaked.
    await tx.query("SAVEPOINT finance_settle_credit");
    let duplicate = false;
    try {
      await tx.query(`UPDATE finance_payments SET status = 'success', mpesa_receipt = $3 WHERE tenant_id = $1 AND id = $2`, [
        input.tenantId,
        input.paymentId,
        receipt,
      ]);
      await tx.query("RELEASE SAVEPOINT finance_settle_credit");
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err;
      await tx.query("ROLLBACK TO SAVEPOINT finance_settle_credit");
      duplicate = true;
    }
    if (duplicate) {
      // Provider confirmed success: do not fail the prompt. Leave pending for operator reconciliation.
      await log("settled_failure", code);
      await recordSecurityEvent(tx, {
        eventType: "finance.mpesa.settled",
        actorUserId: null,
        tenantId: input.tenantId,
        detail: { paymentId: input.paymentId, outcome: "duplicate_receipt_kept_pending", actingVia: input.source },
      });
      return "provider_pending";
    }
    await log("settled_success", code);
    const promptAmount = toMinor(payment.amount_minor);
    await recordSecurityEvent(tx, {
      eventType: "finance.mpesa.settled",
      actorUserId: null,
      tenantId: input.tenantId,
      detail: {
        paymentId: input.paymentId,
        invoiceId: payment.invoice_id,
        outcome: "success",
        amountMinor: promptAmount,
        callbackAmountMismatch: ev?.amountMinor !== null && ev?.amountMinor !== undefined && ev.amountMinor !== promptAmount,
        actingVia: input.source,
      },
    });
    const inv = await tx.query<{ paid_minor: string; total_minor: string }>(
      `SELECT paid_minor, total_minor FROM finance_invoices WHERE tenant_id = $1 AND id = $2`,
      [input.tenantId, payment.invoice_id],
    );
    const over = toMinor(inv.rows[0]!.paid_minor) - toMinor(inv.rows[0]!.total_minor);
    if (over > 0) {
      await recordSecurityEvent(tx, {
        eventType: "finance.payment.overpaid",
        actorUserId: null,
        tenantId: input.tenantId,
        detail: { paymentId: input.paymentId, invoiceId: payment.invoice_id, overpaidMinor: Math.min(over, promptAmount) },
      });
    }
    return "settled_success";
  }
  const outcome = unpaidOutcome(code);
  await tx.query(`UPDATE finance_payments SET status = $3, failure_reason = $4 WHERE tenant_id = $1 AND id = $2`, [
    input.tenantId,
    input.paymentId,
    outcome.status,
    outcome.failure_reason,
  ]);
  await log("settled_failure", code);
  await recordSecurityEvent(tx, {
    eventType: "finance.mpesa.settled",
    actorUserId: null,
    tenantId: input.tenantId,
    detail: { paymentId: input.paymentId, outcome: outcome.status, reason: outcome.failure_reason, actingVia: input.source },
  });
  return "settled_failure";
}

/** Callback body (Daraja STK callback), validated before anything is looked up. */
export function parseStkCallback(body: unknown): { checkoutRequestId: string; merchantRequestId: string | null; evidence: CallbackEvidence } | null {
  const stk = (body as { Body?: { stkCallback?: Record<string, unknown> } } | null)?.Body?.stkCallback;
  if (!stk || typeof stk !== "object") return null;
  const checkout = stk.CheckoutRequestID;
  if (typeof checkout !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(checkout)) return null;
  const merchant = typeof stk.MerchantRequestID === "string" && stk.MerchantRequestID.length <= 80 ? stk.MerchantRequestID : null;
  const rawCode = stk.ResultCode;
  const resultCode = typeof rawCode === "number" && Number.isInteger(rawCode) ? rawCode : typeof rawCode === "string" && /^\d{1,6}$/.test(rawCode) ? Number(rawCode) : null;
  const items = ((stk.CallbackMetadata as { Item?: Array<{ Name?: unknown; Value?: unknown }> } | undefined)?.Item ?? []).filter(
    (i) => i && typeof i.Name === "string",
  );
  const value = (name: string) => items.find((i) => i.Name === name)?.Value;
  const amount = value("Amount");
  const amountMinor = callbackAmountToMinor(amount);
  const receipt = value("MpesaReceiptNumber");
  const phone = value("PhoneNumber");
  return {
    checkoutRequestId: checkout,
    merchantRequestId: merchant,
    evidence: {
      resultCode,
      resultDesc: typeof stk.ResultDesc === "string" ? stk.ResultDesc : null,
      amountMinor,
      receipt: typeof receipt === "string" ? receipt.toUpperCase() : null,
      msisdn: typeof phone === "number" || typeof phone === "string" ? String(phone) : null,
    },
  };
}

/** Parse Daraja Amount into integer minor units without binary floating-point money math. */
export function callbackAmountToMinor(amount: unknown): number | null {
  if (typeof amount === "number") {
    if (!Number.isFinite(amount) || amount < 0 || amount >= 1e9) return null;
    if (Number.isInteger(amount)) return amount * 100;
    amount = String(amount);
  }
  if (typeof amount !== "string") return null;
  const trimmed = amount.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  const minor = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return Number.isSafeInteger(minor) && minor >= 0 && minor < 1e11 ? minor : null;
}
