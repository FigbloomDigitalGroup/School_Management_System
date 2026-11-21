import type { Tx } from "../../db/sql.js";
import { conflict, notFound, validationError } from "../../http/errors.js";
import { recordSecurityEvent } from "../audit/audit.js";
import { pageQuery, type Page, type PageInput } from "../academics/pagination.js";
import { toMinor } from "./money.js";

/**
 * Reconciliation (Stage 11; no legacy equivalent — legacy had only the overpaid-invoices view, proof
 * flags and STK-query settlement). A run checks the school's internal records against each other and
 * against the M-Pesa provider evidence already received, and records FINDINGS. It never changes money:
 * corrective actions stay explicit, separate and authorized (record a payment, void a charge, adjust a
 * total). Resolving a finding records who, when and why; a resolved (kind, subject) is not raised again.
 *
 * Checks (each derivable from stored evidence; no external statement import exists):
 *   invoice_total_mismatch   stored totals differ from the recomputation (should be impossible: tamper alarm)
 *   overpaid_invoice         paid more than the total (cannot arise since the overpayment policy: kept as a tamper alarm)
 *   contradicted_success_callback  an authenticated callback CLAIMED success with a receipt, but the provider's own answer failed the payment
 *                            (the provider is the authority, so the payment is failed; a person must check that no money was taken)
 *   callback_receipt_mismatch   a payment was credited with one receipt while an authenticated callback claimed success with a DIFFERENT one
 *                            (a planted or contradictory callback, or a provider inconsistency)
 *   recovered_receipt_credit  a payment credited by the settle job or an operator with a receipt RECOVERED from a stored callback
 *                            (authenticated only by the callback URL secret): raised until a person has checked it
 *   operator_receipt_credit   a payment credited with a receipt TYPED BY AN OPERATOR (the one receipt the provider did not deliver):
 *                            raised until a person has checked it against the M-Pesa statement
 *   unapplied_payment        a confirmed payment whose amount exceeded the invoice's balance at settlement: the excess is
 *                            held unapplied on the payment (never credited to the invoice, never discarded)
 *   stale_pending_prompt     an M-Pesa prompt still pending after `stale_after_minutes`
 *   prompt_never_sent        the provider never acknowledged the prompt (no checkout id): check with the family
 *   callback_amount_mismatch the callback claimed a different amount than the prompt credited
 *   proof_already_paid       a pending proof whose transaction code is already recorded as a payment
 */
export type FindingKind =
  | "dead_settlement_job"
  | "paid_unconfirmed_no_callback"
  | "invoice_total_mismatch"
  | "overpaid_invoice"
  | "unapplied_payment"
  | "operator_receipt_credit"
  | "recovered_receipt_credit"
  | "contradicted_success_callback"
  | "callback_receipt_mismatch"
  | "stale_pending_prompt"
  | "prompt_never_sent"
  | "callback_amount_mismatch"
  | "proof_already_paid";

const PER_CHECK_LIMIT = 1000;

const CHECKS: Array<{ kind: FindingKind; subject: "invoice" | "payment" | "proof"; sql: string }> = [
  {
    kind: "invoice_total_mismatch",
    subject: "invoice",
    sql: `SELECT i.id AS subject_id, jsonb_build_object('stored_total_minor', i.total_minor, 'computed_total_minor', c.total,
                  'stored_paid_minor', i.paid_minor, 'computed_paid_minor', c.paid) AS detail
            FROM finance_invoices i
            CROSS JOIN LATERAL (SELECT
              COALESCE((SELECT sum(amount_minor) FROM finance_invoice_lines l WHERE l.tenant_id = i.tenant_id AND l.invoice_id = i.id), 0)
              + COALESCE((SELECT sum(amount_minor) FROM finance_charges ch WHERE ch.tenant_id = i.tenant_id AND ch.invoice_id = i.id AND ch.voided_at IS NULL), 0)
              + COALESCE((SELECT sum(delta_minor) FROM finance_invoice_adjustments a WHERE a.tenant_id = i.tenant_id AND a.invoice_id = i.id), 0) AS total,
              COALESCE((SELECT sum(applied_minor) FROM finance_payments p WHERE p.tenant_id = i.tenant_id AND p.invoice_id = i.id AND p.status = 'success'), 0) AS paid) c
           WHERE i.tenant_id = $1 AND (i.total_minor <> c.total OR i.paid_minor <> c.paid)
           ORDER BY i.id`,
  },
  {
    kind: "overpaid_invoice",
    subject: "invoice",
    sql: `SELECT i.id AS subject_id, jsonb_build_object('total_minor', i.total_minor, 'paid_minor', i.paid_minor,
                  'overpaid_minor', i.paid_minor - i.total_minor, 'learner_id', i.learner_id) AS detail
            FROM finance_invoices i WHERE i.tenant_id = $1 AND i.voided_at IS NULL AND i.paid_minor > i.total_minor
           ORDER BY i.id`,
  },
  {
    kind: "unapplied_payment",
    subject: "payment",
    sql: `SELECT p.id AS subject_id, jsonb_build_object('invoice_id', p.invoice_id, 'method', p.method, 'amount_minor', p.amount_minor,
                  'applied_minor', p.applied_minor, 'unapplied_minor', p.unapplied_minor, 'completed_at', p.completed_at) AS detail
            FROM finance_payments p WHERE p.tenant_id = $1 AND p.status = 'success' AND p.unapplied_minor > 0
           ORDER BY p.completed_at, p.id`,
  },
  {
    kind: "operator_receipt_credit",
    subject: "payment",
    sql: `SELECT DISTINCT ON (p.id) p.id AS subject_id, jsonb_build_object('invoice_id', p.invoice_id, 'receipt', p.mpesa_receipt,
                  'operator_user_id', e.actor_user_id, 'credited_at', e.received_at, 'provider_view', e.provider_view) AS detail
            FROM finance_mpesa_events e
            JOIN finance_payments p ON p.id = e.payment_id AND p.tenant_id = e.tenant_id
           WHERE e.tenant_id = $1 AND e.source = 'operator' AND e.evidence_basis = 'operator_receipt'
             AND e.outcome = 'settled_success' AND p.status = 'success'
           ORDER BY p.id, e.received_at`,
  },
  {
    kind: "recovered_receipt_credit",
    subject: "payment",
    sql: `SELECT DISTINCT ON (p.id) p.id AS subject_id, jsonb_build_object('invoice_id', p.invoice_id, 'receipt', p.mpesa_receipt,
                  'acting_source', e.source, 'credited_at', e.received_at, 'callback_amount_minor', cb.callback_amount_minor,
                  'confirmed_minor', p.amount_minor) AS detail
            FROM finance_mpesa_events e
            JOIN finance_payments p ON p.id = e.payment_id AND p.tenant_id = e.tenant_id
            LEFT JOIN LATERAL (SELECT c.callback_amount_minor FROM finance_mpesa_events c
                                WHERE c.tenant_id = e.tenant_id AND c.payment_id = e.payment_id AND c.outcome = 'callback_received'
                                  AND c.receipt = p.mpesa_receipt ORDER BY c.received_at LIMIT 1) cb ON true
           WHERE e.tenant_id = $1 AND e.evidence_basis = 'stored_callback' AND e.outcome = 'settled_success' AND p.status = 'success'
           ORDER BY p.id, e.received_at`,
  },
  {
    kind: "contradicted_success_callback",
    subject: "payment",
    sql: `SELECT DISTINCT ON (p.id) p.id AS subject_id, jsonb_build_object('invoice_id', p.invoice_id, 'payment_status', p.status,
                  'failure_reason', p.failure_reason, 'claimed_receipt', c.receipt, 'claimed_at', c.received_at) AS detail
            FROM finance_payments p
            JOIN finance_mpesa_events c ON c.tenant_id = p.tenant_id AND c.payment_id = p.id AND c.source = 'callback'
                 AND c.outcome = 'callback_received' AND c.result_code = 0 AND c.receipt IS NOT NULL
           WHERE p.tenant_id = $1 AND p.method = 'mpesa' AND p.status IN ('failed', 'cancelled', 'timeout')
           ORDER BY p.id, c.received_at`,
  },
  {
    kind: "callback_receipt_mismatch",
    subject: "payment",
    sql: `SELECT DISTINCT ON (p.id) p.id AS subject_id, jsonb_build_object('invoice_id', p.invoice_id, 'credited_receipt', p.mpesa_receipt,
                  'claimed_receipt', c.receipt, 'claimed_at', c.received_at) AS detail
            FROM finance_payments p
            JOIN finance_mpesa_events c ON c.tenant_id = p.tenant_id AND c.payment_id = p.id AND c.source = 'callback'
                 AND c.outcome = 'callback_received' AND c.result_code = 0 AND c.receipt IS NOT NULL AND c.receipt <> p.mpesa_receipt
           WHERE p.tenant_id = $1 AND p.method = 'mpesa' AND p.status = 'success'
           ORDER BY p.id, c.received_at`,
  },
  {
    kind: "stale_pending_prompt",
    subject: "payment",
    sql: `SELECT p.id AS subject_id, jsonb_build_object('invoice_id', p.invoice_id, 'amount_minor', p.amount_minor,
                  'created_at', p.created_at) AS detail
            FROM finance_payments p
           WHERE p.tenant_id = $1 AND p.status = 'pending' AND p.checkout_request_id IS NOT NULL
             AND p.created_at < now() - make_interval(mins => $2)
           ORDER BY p.created_at, p.id`,
  },
  {
    kind: "prompt_never_sent",
    subject: "payment",
    sql: `SELECT p.id AS subject_id, jsonb_build_object('invoice_id', p.invoice_id, 'amount_minor', p.amount_minor,
                  'status', p.status, 'created_at', p.created_at) AS detail
            FROM finance_payments p
           WHERE p.tenant_id = $1 AND p.method = 'mpesa' AND p.checkout_request_id IS NULL AND p.msisdn IS NOT NULL
             AND (p.failure_reason = 'not_sent' /* legacy rows only: the database refuses new ones (migration 043) */ OR (p.status = 'pending' AND p.created_at < now() - make_interval(mins => $2)))
           ORDER BY p.created_at, p.id`,
  },
  {
    kind: "callback_amount_mismatch",
    subject: "payment",
    sql: `SELECT DISTINCT ON (p.id) p.id AS subject_id, jsonb_build_object('invoice_id', p.invoice_id,
                  'confirmed_minor', p.amount_minor, 'applied_minor', p.applied_minor, 'callback_amount_minor', e.callback_amount_minor) AS detail
            FROM finance_payments p
            JOIN finance_mpesa_events e ON e.tenant_id = p.tenant_id AND e.payment_id = p.id
           WHERE p.tenant_id = $1 AND p.status = 'success' AND e.callback_amount_minor IS NOT NULL
             AND e.callback_amount_minor <> p.amount_minor
           ORDER BY p.id, e.received_at`,
  },
  {
    kind: "proof_already_paid",
    subject: "proof",
    sql: `SELECT pr.id AS subject_id, jsonb_build_object('invoice_id', pr.invoice_id, 'payment_id', p.id) AS detail
            FROM finance_payment_proofs pr
            JOIN finance_payments p ON p.tenant_id = pr.tenant_id AND p.status = 'success'
             AND (p.mpesa_receipt = pr.txn_code OR p.reference_norm = pr.txn_code)
           WHERE pr.tenant_id = $1 AND pr.status = 'pending' AND pr.txn_code IS NOT NULL
           ORDER BY pr.id`,
  },
];

export interface PublicRun {
  id: string;
  tenantId: string;
  started_by: string | null;
  started_at: string;
  stale_after_minutes: number;
  findings_count: number;
}

export interface PublicFinding {
  id: string;
  tenantId: string;
  run_id: string;
  kind: FindingKind;
  subject_type: "invoice" | "payment" | "proof";
  subject_id: string;
  detail: Record<string, unknown>;
  status: "open" | "resolved";
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  owner_user_id: string | null;
  assigned_at: string | null;
  escalated_at: string | null;
  reopened_count: number;
  resolution_evidence: string | null;
  age_minutes: number;
  created_at: string;
}

type RunRow = { id: string; tenant_id: string; started_by: string | null; started_at: Date; stale_after_minutes: number; findings_count: number };
type FindingRow = {
  id: string;
  tenant_id: string;
  run_id: string;
  kind: FindingKind;
  subject_type: PublicFinding["subject_type"];
  subject_id: string;
  detail: Record<string, unknown>;
  status: PublicFinding["status"];
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution_note: string | null;
  owner_user_id: string | null;
  assigned_at: Date | null;
  escalated_at: Date | null;
  reopened_count: number;
  resolution_evidence: string | null;
  created_at: Date;
};

const mapRun = (r: RunRow): PublicRun => ({
  id: r.id,
  tenantId: r.tenant_id,
  started_by: r.started_by,
  started_at: r.started_at.toISOString(),
  stale_after_minutes: r.stale_after_minutes,
  findings_count: r.findings_count,
});

function normaliseDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) out[k] = k.endsWith("_minor") && v !== null ? toMinor(v as string | number) : v;
  return out;
}

const mapFinding = (r: FindingRow): PublicFinding => ({
  id: r.id,
  tenantId: r.tenant_id,
  run_id: r.run_id,
  kind: r.kind,
  subject_type: r.subject_type,
  subject_id: r.subject_id,
  detail: normaliseDetail(r.detail),
  status: r.status,
  resolved_by: r.resolved_by,
  resolved_at: r.resolved_at ? r.resolved_at.toISOString() : null,
  resolution_note: r.resolution_note,
  owner_user_id: r.owner_user_id,
  assigned_at: r.assigned_at ? r.assigned_at.toISOString() : null,
  escalated_at: r.escalated_at ? r.escalated_at.toISOString() : null,
  reopened_count: r.reopened_count,
  resolution_evidence: r.resolution_evidence,
  age_minutes: Math.max(0, Math.floor((Date.now() - r.created_at.getTime()) / 60_000)),
  created_at: r.created_at.toISOString(),
});

const FINDING_COLS = `id, tenant_id, run_id, kind, subject_type, subject_id, detail, status, resolved_by, resolved_at, resolution_note, owner_user_id, assigned_at, escalated_at, reopened_count, resolution_evidence, created_at`;

export async function runReconciliation(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; stale_after_minutes: number; ip?: string | null },
): Promise<{ run: PublicRun; findings: PublicFinding[] }> {
  if (!Number.isInteger(input.stale_after_minutes) || input.stale_after_minutes < 5 || input.stale_after_minutes > 10_080) {
    throw validationError("stale_after_minutes must be 5–10080");
  }
  const run = await tx.query<RunRow>(
    `INSERT INTO finance_reconciliation_runs (tenant_id, started_by, stale_after_minutes) VALUES ($1, $2, $3)
     RETURNING id, tenant_id, started_by, started_at, stale_after_minutes, findings_count`,
    [input.tenantId, input.actorUserId, input.stale_after_minutes],
  );
  const runId = run.rows[0]!.id;
  let count = 0;
  for (const check of CHECKS) {
    const params: unknown[] = check.sql.includes("$2") ? [input.tenantId, input.stale_after_minutes] : [input.tenantId];
    const rows = await tx.query<{ subject_id: string; detail: Record<string, unknown> }>(`${check.sql} LIMIT ${PER_CHECK_LIMIT}`, params);
    for (const r of rows.rows) {
      const acknowledged = await tx.query(
        `SELECT 1 FROM finance_reconciliation_findings WHERE tenant_id = $1 AND kind = $2 AND subject_id = $3 AND status = 'resolved' LIMIT 1`,
        [input.tenantId, check.kind, r.subject_id],
      );
      if ((acknowledged.rowCount ?? 0) > 0) continue;
      await tx.query(
        `INSERT INTO finance_reconciliation_findings (tenant_id, run_id, kind, subject_type, subject_id, detail)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [input.tenantId, runId, check.kind, check.subject, r.subject_id, JSON.stringify(r.detail)],
      );
      count++;
    }
  }
  const updated = await tx.query<RunRow>(
    `UPDATE finance_reconciliation_runs SET findings_count = $3 WHERE tenant_id = $1 AND id = $2
     RETURNING id, tenant_id, started_by, started_at, stale_after_minutes, findings_count`,
    [input.tenantId, runId, count],
  );
  await recordSecurityEvent(tx, {
    eventType: "finance.reconciliation.run",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { runId, findings: count },
    ip: input.ip,
  });
  const findings = await tx.query<FindingRow>(
    `SELECT ${FINDING_COLS} FROM finance_reconciliation_findings WHERE tenant_id = $1 AND run_id = $2 ORDER BY kind, subject_id`,
    [input.tenantId, runId],
  );
  return { run: mapRun(updated.rows[0]!), findings: findings.rows.map(mapFinding) };
}

export async function listFindings(
  tx: Tx,
  input: { tenantId: string; runId?: string; status?: "open" | "resolved"; page: PageInput },
): Promise<Page<PublicFinding>> {
  const params: unknown[] = [input.tenantId];
  const where = ["tenant_id = $1"];
  if (input.runId) {
    params.push(input.runId);
    where.push(`run_id = $${params.length}`);
  }
  if (input.status) {
    params.push(input.status);
    where.push(`status = $${params.length}`);
  }
  const out = await pageQuery<FindingRow>(
    tx,
    `SELECT ${FINDING_COLS} FROM finance_reconciliation_findings WHERE ${where.join(" AND ")}`,
    params,
    { name: "reconciliation_findings", expr: "q.created_at", type: "timestamptz", dir: "desc" },
    input.page,
  );
  return { items: out.rows.map(mapFinding), page: out.page };
}

export async function listRuns(tx: Tx, input: { tenantId: string; page: PageInput }): Promise<Page<PublicRun>> {
  const out = await pageQuery<RunRow>(
    tx,
    `SELECT id, tenant_id, started_by, started_at, stale_after_minutes, findings_count FROM finance_reconciliation_runs WHERE tenant_id = $1`,
    [input.tenantId],
    { name: "reconciliation_runs", expr: "q.started_at", type: "timestamptz", dir: "desc" },
    input.page,
  );
  return { items: out.rows.map(mapRun), page: out.page };
}

const EVIDENCE_REQUIRED_KINDS = new Set(["dead_settlement_job", "paid_unconfirmed_no_callback", "prompt_never_sent", "stale_pending_prompt", "contradicted_success_callback"]);

export async function resolveFinding(
  tx: Tx,
  input: { tenantId: string; actorUserId: string; findingId: string; note: string; evidence?: string | null; ip?: string | null },
): Promise<PublicFinding> {
  const note = input.note.trim();
  if (note.length < 3 || note.length > 500) throw validationError("note must be 3–500 characters");
  const cur = await tx.query<{ status: string; kind: string }>(
    `SELECT status, kind FROM finance_reconciliation_findings WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [input.tenantId, input.findingId],
  );
  if (!cur.rows[0]) throw notFound("Finding not found");
  if (cur.rows[0].status !== "open") throw conflict("This finding is already resolved");
  // Payment-evidence cases need supporting evidence on resolution (owner decision 6.3): who, when, why AND on what basis.
  const evidence = input.evidence?.trim() || null;
  if (EVIDENCE_REQUIRED_KINDS.has(cur.rows[0].kind) && (!evidence || evidence.length < 3)) throw validationError("evidence is required to resolve this kind of case");
  if (evidence && evidence.length > 1000) throw validationError("evidence must be at most 1000 characters");
  const res = await tx.query<FindingRow>(
    `UPDATE finance_reconciliation_findings SET status = 'resolved', resolved_by = $3, resolution_note = $4, resolution_evidence = $5
      WHERE tenant_id = $1 AND id = $2 RETURNING ${FINDING_COLS}`,
    [input.tenantId, input.findingId, input.actorUserId, note, evidence],
  );
  await recordSecurityEvent(tx, {
    eventType: "finance.reconciliation.resolved",
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    detail: { findingId: input.findingId, kind: res.rows[0]!.kind, subjectId: res.rows[0]!.subject_id },
    ip: input.ip,
  });
  return mapFinding(res.rows[0]!);
}
