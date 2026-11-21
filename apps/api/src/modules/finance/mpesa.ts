import type { Tx } from "../../db/sql.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { getInvoice } from "./invoices.js";
import { mapPayment, PAYMENT_COLS, type PublicPayment } from "./payments.js";
import { assertWholeShillings, maskMsisdn, MSISDN_PATTERN, toMinor } from "./money.js";
import { classifyResultCode, unpaidOutcome, type StkPushResult, type StkQueryResult } from "./mpesaProvider.js";

/** A pending prompt for the same phone and amount within this window is returned again (legacy: 2 minutes). */
export const PROMPT_REUSE_SECONDS = 120;

/**
 * Step 1 of an M-Pesa prompt, inside the caller's tenant transaction (legacy mpesa-stk-push):
 * whole shillings, at least KES 1, at most the outstanding balance rounded UP to the next shilling (so a
 * balance with cents can be cleared; the extra cents become an UNAPPLIED amount on the payment, audited and raised by reconciliation). One pending prompt
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
  // A settlement is a SYSTEM obligation (docs/WORKER-ISOLATION-PROPOSAL.md §6; owner decision of the Stage 11
  // remediation programme, recorded in docs/acceptance/stage11-worker-remediation/): it must still run if the person who started the prompt is later disabled or
  // loses their membership, so no enqueuer is stored. The initiator stays on record in the immutable job
  // payload and in the prompt_started audit event; the worker never acts on their behalf.
  await tx.query(
    `INSERT INTO jobs (tenant_id, job_type, payload, idempotency_key, run_after, enqueued_by_user_id)
     VALUES ($1, 'mpesa.stk_settle', $2::jsonb, $3, now() + make_interval(secs => $4), NULL)`,
    [
      input.tenantId,
      JSON.stringify({ paymentId: payment.id, initiatedBy: input.actorUserId }),
      `settle:${payment.id}`,
      input.settleDelaySeconds,
    ],
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
  await lockInvoiceOfPayment(tx, input.tenantId, input.paymentId);
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

/**
 * Lock order is ALWAYS invoice first, then payment (createPrompt, recordPayment and the payment guard all lock the
 * invoice before touching its payments). Settlement and push-outcome code locks the invoice here BEFORE the payment
 * row, so a prompt being created and a callback settling the previous one on the same invoice cannot deadlock
 * (review F1: the callback's transaction, and with it the confirmed evidence, was the one PostgreSQL would abort).
 */
export async function lockInvoiceOfPayment(tx: Tx, tenantId: string, paymentId: string): Promise<void> {
  const inv = await tx.query<{ invoice_id: string }>(`SELECT invoice_id FROM finance_payments WHERE tenant_id = $1 AND id = $2`, [tenantId, paymentId]);
  const invoiceId = inv.rows[0]?.invoice_id;
  if (!invoiceId) throw notFound("Payment not found");
  await tx.query(`SELECT 1 FROM finance_invoices WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, invoiceId]);
}

export interface CallbackEvidence {
  resultCode: number | null;
  resultDesc: string | null;
  amountMinor: number | null;
  receipt: string | null;
  msisdn: string | null;
}

export type SettleOutcome = "settled_success" | "settled_failure" | "already_settled" | "provider_pending" | "conflict";

const RECEIPT = /^[A-Z0-9]{6,20}$/;

/**
 * An operator's reconciliation act (batch 4): the acting finance administrator, the mandatory reason, an optional
 * receipt typed from independent evidence, and whether they attest that an UNKNOWN (undocumented, non-processing)
 * provider result code is a terminal failure. It never bypasses provider evidence: the caller has already required
 * a provider confirmation (a successful query, or an authenticated callback already on record).
 */
export interface OperatorContext {
  userId: string;
  note: string;
  receipt?: string | null;
  attestsTerminalFailure?: boolean;
  /** Which action the operator asked for, what the provider said at that moment, and where the call came from (audit). */
  action?: string;
  providerView?: string;
  ip?: string | null;
}

/**
 * The receipts the PROVIDER's authenticated callbacks have delivered for this prompt (the callback route persists
 * every authenticated callback before it queries the provider, so evidence survives a failed query, a 503 or a
 * process stop). Only the persisted callbacks themselves (outcome callback_received) that CLAIM success carry usable
 * receipts (ledger rows written by a settlement are not evidence); they are used
 * only after the provider's own query confirms success, and the system never makes a receipt up.
 */
export async function storedCallbackReceipts(tx: Tx, tenantId: string, paymentId: string): Promise<string[]> {
  const res = await tx.query<{ receipt: string }>(
    `SELECT DISTINCT receipt FROM finance_mpesa_events
      WHERE tenant_id = $1 AND payment_id = $2 AND source = 'callback' AND outcome = 'callback_received'
        AND result_code = 0 AND receipt IS NOT NULL
      ORDER BY receipt`,
    [tenantId, paymentId],
  );
  return res.rows.map((r) => r.receipt);
}

/**
 * Persist an authenticated callback BEFORE the provider is queried (review F-4). A query that throws, a 503, a
 * redelivery that never comes or a process stop can no longer lose the receipt the callback carried. Append-only.
 * The receipt is the callback's CLAIM: it is trusted only after the provider's own query confirms success (settlePrompt),
 * and the only thing that authenticates a callback is the secret in its URL.
 */
export async function recordCallbackReceived(
  tx: Tx,
  input: { tenantId: string; paymentId: string; checkoutRequestId: string; evidence: CallbackEvidence },
): Promise<void> {
  const ev = input.evidence;
  await tx.query(
    `INSERT INTO finance_mpesa_events
       (tenant_id, payment_id, checkout_request_id, source, result_code, result_desc, callback_amount_minor, receipt, msisdn_masked, outcome)
     VALUES ($1, $2, $3, 'callback', $4, $5, $6, $7, $8, 'callback_received')`,
    [
      input.tenantId,
      input.paymentId,
      input.checkoutRequestId,
      ev.resultCode,
      ev.resultDesc ? ev.resultDesc.slice(0, 200) : null,
      ev.amountMinor,
      ev.receipt && RECEIPT.test(ev.receipt) ? ev.receipt : null,
      ev.msisdn && /^254\d{9}$/.test(ev.msisdn) ? maskMsisdn(ev.msisdn) : null,
    ],
  );
}

/**
 * A missing checkout id is NEVER proof that the request was not sent (the push response may simply not have
 * been stored yet, or the process may have stopped between the provider call and its record). An uncertain
 * prompt therefore stays pending, the settle job retries, and reconciliation (`prompt_never_sent`) shows it to
 * a person; it is never turned into a failure here. Only the PROVIDER's own answer fails a prompt.
 *
 * Settle a pending prompt from the PROVIDER'S confirmed answer (STK query), never from callback data
 * alone (legacy mpesa-callback re-confirms every callback). Shared by the callback, the settle job and the
 * operator reconciliation.
 *   * Only a pending prompt changes (row lock; a repeated callback or a second worker is a no-op).
 *   * Success credits the PROMPT'S OWN amount up to the invoice's balance (the database decides applied vs unapplied).
 *   * Success requires a valid, unique receipt and the system never makes one up. The STK query does not return a
 *     receipt, so it comes from, in order: this callback; an authenticated callback stored earlier (batch 5: the
 *     settle job can complete a payment whose callback already arrived); the operator's typed receipt. Two different
 *     candidate receipts are a CONFLICT: nothing is credited and the prompt waits for a person.
 *   * A colliding receipt leaves the prompt pending (never fails a provider-confirmed payment).
 *   * Every call writes a finance_mpesa_events row (no secrets; masked phone), with the acting operator when there is one.
 */
export async function settlePrompt(
  tx: Tx,
  input: {
    tenantId: string;
    paymentId: string;
    source: "callback" | "status_query" | "operator";
    query: StkQueryResult;
    evidence?: CallbackEvidence;
    /** Present when the worker settles: attribution of the job attempt (never a user). */
    job?: { jobId: string; jobType: string; attempt: number; leaseToken: string };
    /** Present when an administrator reconciles the prompt (source must be "operator"). */
    operator?: OperatorContext;
  },
): Promise<SettleOutcome> {
  if ((input.source === "operator") !== Boolean(input.operator)) throw new Error("an operator settlement needs its operator context, and only it");
  // F-8: the worker has no UPDATE privilege on finance tables, so it cannot take FOR UPDATE locks here.
  // finance_worker_settle_payment() locks the job, payment and (via the guard) invoice as the table owner.
  // Callback/operator paths keep the application-level invoice lock ordering.
  if (!input.job) await lockInvoiceOfPayment(tx, input.tenantId, input.paymentId);
  const res = await tx.query<{ status: string; checkout_request_id: string | null; amount_minor: string; invoice_id: string }>(
    `SELECT status, checkout_request_id, amount_minor, invoice_id FROM finance_payments
      WHERE tenant_id = $1 AND id = $2 AND method = 'mpesa'${input.job ? "" : " FOR UPDATE"}`,
    [input.tenantId, input.paymentId],
  );
  const payment = res.rows[0];
  if (!payment) throw notFound("Payment not found");
  if (!payment.checkout_request_id) throw new Error("a prompt without a provider checkout id cannot be settled");
  const ev = input.evidence;
  const op = input.operator;
  const log = async (outcome: string, resultCode: number | null, basis: string | null = null, receiptOverride: string | null = null) => {
    const callbackReceipt = ev?.receipt && RECEIPT.test(ev.receipt) ? ev.receipt : null;
    await tx.query(
      `INSERT INTO finance_mpesa_events
         (tenant_id, payment_id, checkout_request_id, source, result_code, result_desc, callback_amount_minor, receipt, msisdn_masked,
          outcome, actor_user_id, operator_note, evidence_basis, provider_view)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        input.tenantId,
        input.paymentId,
        payment.checkout_request_id as string,
        input.source,
        resultCode,
        ev?.resultDesc ? ev.resultDesc.slice(0, 200) : null,
        ev?.amountMinor ?? null,
        receiptOverride ?? callbackReceipt,
        ev?.msisdn && /^254\d{9}$/.test(ev.msisdn) ? maskMsisdn(ev.msisdn) : null,
        outcome,
        op?.userId ?? null,
        op ? op.note : null,
        basis,
        op?.providerView ?? null,
      ],
    );
  };
  // Every settlement audit row names how it was reached. A worker attempt carries the job attribution and
  // actingVia "worker" (the database accepts nothing else from the worker role); an operator act names the
  // administrator; a callback is "callback".
  const audit = (eventType: "finance.mpesa.settled" | "finance.payment.unapplied", detail: Record<string, unknown>) =>
    recordSecurityEvent(tx, {
      eventType,
      actorUserId: op?.userId ?? null,
      tenantId: input.tenantId,
      detail: {
        ...detail,
        source: input.source,
        actingVia: input.job ? "worker" : input.source,
        ...(input.job ? { jobId: input.job.jobId, jobType: input.job.jobType, attempt: input.job.attempt } : {}),
        ...(op ? { action: op.action ?? null, providerView: op.providerView ?? null } : {}),
      },
      ip: op?.ip ?? null,
    });
  if (payment.status !== "pending" && !input.job) {
    await log("already_settled", ev?.resultCode ?? null);
    return "already_settled";
  }
  if (!input.query.done) {
    if (payment.status !== "pending") return "already_settled";
    await log("provider_pending", ev?.resultCode ?? null);
    return "provider_pending";
  }
  const code = input.query.resultCode;
  if (code === 0) {
    // Candidate receipts: this callback's, the ones stored from earlier authenticated callbacks, and the operator's.
    const stored = await storedCallbackReceipts(tx, input.tenantId, input.paymentId);
    const claimed = ev?.resultCode === 0 && ev.receipt && RECEIPT.test(ev.receipt) ? ev.receipt : null; // only a callback that itself claims success
    const opReceipt = op?.receipt && RECEIPT.test(op.receipt) ? op.receipt : null;
    const known = new Set<string>([...stored, ...(claimed ? [claimed] : [])]);
    let receipt: string | null = null;
    let basis: "callback" | "stored_callback" | "operator_receipt" | null = null;
    let conflict = false;
    if (opReceipt) {
      // an operator may CHOOSE among receipts the provider's authenticated callbacks delivered, never contradict them
      if (known.size > 0 && !known.has(opReceipt)) conflict = true;
      else {
        receipt = opReceipt;
        basis = "operator_receipt";
      }
    } else if (known.size > 1) {
      conflict = true;
    } else if (known.size === 1) {
      receipt = [...known][0]!;
      basis = claimed ? "callback" : "stored_callback";
    }
    if (conflict) {
      // Two different receipts for one prompt: nothing is credited and nothing is guessed.
      await log("evidence_conflict", code);
      if (!input.job) {
        await audit("finance.mpesa.settled", { paymentId: input.paymentId, outcome: "evidence_conflict" });
      }
      return "provider_pending";
    }
    // STK query confirms payment but does not return a receipt. Crediting without one leaves a NULL
    // mpesa_receipt that the partial unique index ignores, so the office could later record the same
    // code as a second payment. Keep pending until a unique receipt is available (callback, stored callback, operator).
    if (!receipt || !basis) {
      if (payment.status !== "pending") return "already_settled";
      await log("provider_pending", code);
      return "provider_pending";
    }
    // The receipt index is system-wide but RLS hides other schools' rows, so a duplicate is detected by
    // the unique index itself, inside a savepoint: never credited twice, nothing about the other school leaked.
    await tx.query("SAVEPOINT finance_settle_credit");
    let duplicate = false;
    let workerOutcome: string | null = null;
    try {
      if (input.job) {
        // F-8: the worker has no direct UPDATE on finance_payments. Settlement is lease-bound and
        // receipt-gated inside finance_worker_settle_payment (tenant from the job row, not the GUC).
        const r = await tx.query<{ outcome: string }>(
          `SELECT public.finance_worker_settle_payment($1, $2, $3, $4, 'success', $5, NULL) AS outcome`,
          [input.job.jobId, input.job.leaseToken, input.job.attempt, input.paymentId, receipt],
        );
        workerOutcome = r.rows[0]?.outcome ?? "settled_success";
      } else {
        await tx.query(`UPDATE finance_payments SET status = 'success', mpesa_receipt = $3 WHERE tenant_id = $1 AND id = $2`, [
          input.tenantId,
          input.paymentId,
          receipt,
        ]);
      }
      await tx.query("RELEASE SAVEPOINT finance_settle_credit");
    } catch (err) {
      if ((err as { code?: string }).code !== "23505") throw err;
      await tx.query("ROLLBACK TO SAVEPOINT finance_settle_credit");
      duplicate = true;
    }
    if (duplicate) {
      // Provider confirmed success: do not fail the prompt. Leave pending for operator reconciliation.
      await log("duplicate_receipt", code, basis, receipt);
      if (!input.job) {
        await audit("finance.mpesa.settled", { paymentId: input.paymentId, outcome: "duplicate_receipt_kept_pending" });
      }
      return "provider_pending";
    }
    if (workerOutcome === "already_settled") {
      if (payment.status === "pending") {
        await log("already_settled", code, basis, receipt);
      }
      return "already_settled";
    }
    if (workerOutcome === "conflict") {
      await log("evidence_conflict", code, basis, receipt);
      return "conflict";
    }
    if (basis === "stored_callback") await log("evidence_recovered", code, basis, receipt);
    await log("settled_success", code, basis, receipt);
    if (!input.job) {
      const promptAmount = toMinor(payment.amount_minor);
      await audit("finance.mpesa.settled", {
        paymentId: input.paymentId,
        invoiceId: payment.invoice_id,
        outcome: "success",
        receiptBasis: basis,
        amountMinor: promptAmount,
        callbackAmountMismatch: ev?.amountMinor !== null && ev?.amountMinor !== undefined && ev.amountMinor !== promptAmount,
      });
      // The database decided how much reached the invoice (applied) under the invoice lock; the rest is unapplied.
      // The provider-confirmed amount is never altered and never discarded: the unapplied part stays on the payment
      // until an approved allocation or refund workflow exists, and is raised by reconciliation.
      const applied = await tx.query<{ applied_minor: string; unapplied_minor: string }>(
        `SELECT applied_minor, unapplied_minor FROM finance_payments WHERE tenant_id = $1 AND id = $2`,
        [input.tenantId, input.paymentId],
      );
      const unapplied = toMinor(applied.rows[0]!.unapplied_minor);
      if (unapplied > 0) {
        await audit("finance.payment.unapplied", {
          paymentId: input.paymentId,
          invoiceId: payment.invoice_id,
          amountMinor: promptAmount,
          appliedMinor: toMinor(applied.rows[0]!.applied_minor),
          unappliedMinor: unapplied,
        });
      }
    }
    return "settled_success";
  }
  // Only a code known to be a FINAL failure fails the payment. A still-processing or unknown code is an
  // uncertain provider outcome: it stays pending (retry, reconciliation) and is never recorded as a failure,
  // unless a finance administrator attests that an UNKNOWN code is terminal (never for a still-processing one).
  const cls = classifyResultCode(code);
  if (cls !== "final_failure" && !(cls === "unknown" && op?.attestsTerminalFailure)) {
    if (payment.status !== "pending") return "already_settled";
    await log("provider_pending", code);
    return "provider_pending";
  }
  const outcome = unpaidOutcome(code);
  if (input.job) {
    const r = await tx.query<{ outcome: string }>(
      `SELECT public.finance_worker_settle_payment($1, $2, $3, $4, $5, NULL, $6) AS outcome`,
      [
        input.job.jobId,
        input.job.leaseToken,
        input.job.attempt,
        input.paymentId,
        outcome.status,
        outcome.failure_reason,
      ],
    );
    const workerOutcome = r.rows[0]?.outcome ?? "settled_failure";
    if (workerOutcome === "already_settled") {
      if (payment.status === "pending") {
        await log("already_settled", code);
      }
      return "already_settled";
    }
    if (workerOutcome === "evidence_required") {
      // N-1: the lease is not evidence. The database kept the payment pending and recorded failure_unconfirmed;
      // only a stored authenticated final-failure callback (or an operator) can fail it. Reconciliation shows it.
      return "provider_pending";
    }
    if (workerOutcome === "conflict") {
      await log("evidence_conflict", code);
      return "conflict";
    }
  } else {
    await tx.query(`UPDATE finance_payments SET status = $3, failure_reason = $4 WHERE tenant_id = $1 AND id = $2`, [
      input.tenantId,
      input.paymentId,
      outcome.status,
      outcome.failure_reason,
    ]);
  }
  await log("settled_failure", code);
  if (!input.job) {
    await audit("finance.mpesa.settled", { paymentId: input.paymentId, outcome: outcome.status, reason: outcome.failure_reason });
  }
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
