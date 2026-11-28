import type { Tx } from "../../db/sql.js";
import { notFound } from "../../http/errors.js";
import { assertValidCalendarDate } from "../inventory/inventory.js";

export interface SchoolOverviewReport {
  learners_active: number;
  staff_active: number;
  classes_active: number;
  vehicles_active: number;
  routes_active: number;
  inventory_items_active: number;
  leave_pending: number;
  announcements_published: number;
  open_gate_visits: number;
  sick_bay_open: number;
}

export interface AttendanceDailyReport {
  date: string;
  morning_present: number;
  morning_absent: number;
  morning_late: number;
  morning_excused: number;
  afternoon_present: number;
  afternoon_absent: number;
  afternoon_late: number;
  afternoon_excused: number;
  early_sign_outs: number;
}

export interface FinanceSummaryReport {
  invoices_live: number;
  invoices_paid: number;
  invoices_part_paid: number;
  invoices_unpaid: number;
  invoices_overdue: number;
  amount_due_minor: number;
  amount_paid_minor: number;
  payments_success: number;
  payments_pending: number;
}

/**
 * Academic/CBE counts for a school (optional term). Counts only — no invented KPIs
 * or grade averages. CBE assessments counted when published or closed.
 */
export interface AcademicsSummaryReport {
  term_id: string | null;
  classes_active: number;
  assessments_draft: number;
  assessments_published: number;
  assessments_closed: number;
  cbe_assessments_draft: number;
  cbe_assessments_published: number;
  cbe_assessments_closed: number;
  report_cards_published: number;
  competency_ratings: number;
  learning_areas: number;
}

export async function schoolOverview(tx: Tx, tenantId: string): Promise<SchoolOverviewReport> {
  const r = await tx.query<SchoolOverviewReport>(
    `SELECT
       (SELECT count(*)::int FROM learners WHERE tenant_id = $1 AND archived_at IS NULL) AS learners_active,
       (SELECT count(*)::int FROM school_memberships WHERE tenant_id = $1 AND archived_at IS NULL
          AND role IN ('school_admin', 'teacher', 'staff', 'driver')) AS staff_active,
       (SELECT count(*)::int FROM classes WHERE tenant_id = $1 AND active = true AND archived_at IS NULL) AS classes_active,
       (SELECT count(*)::int FROM vehicles WHERE tenant_id = $1 AND active = true) AS vehicles_active,
       (SELECT count(*)::int FROM transport_routes WHERE tenant_id = $1 AND active = true) AS routes_active,
       (SELECT count(*)::int FROM inventory_items WHERE tenant_id = $1 AND retired_at IS NULL) AS inventory_items_active,
       (SELECT count(*)::int FROM leave_requests WHERE tenant_id = $1 AND status = 'pending') AS leave_pending,
       (SELECT count(*)::int FROM communications_announcements WHERE tenant_id = $1 AND published_at IS NOT NULL) AS announcements_published,
       (SELECT count(*)::int FROM gate_visits WHERE tenant_id = $1 AND status <> 'left') AS open_gate_visits,
       (SELECT count(*)::int FROM sick_bay_visits WHERE tenant_id = $1 AND time_out IS NULL) AS sick_bay_open`,
    [tenantId],
  );
  return r.rows[0]!;
}

function tallyMarks(rows: Array<{ mark: string; n: number }>): {
  present: number;
  absent: number;
  late: number;
  excused: number;
} {
  const m = Object.fromEntries(rows.map((row) => [row.mark, row.n]));
  return {
    present: m.present ?? 0,
    absent: m.absent ?? 0,
    late: m.late ?? 0,
    excused: m.excused ?? 0,
  };
}

export async function attendanceDaily(tx: Tx, tenantId: string, date: string): Promise<AttendanceDailyReport> {
  // S14-4: Strict calendar date validation (rejects 2026-02-31 with 400 before PostgreSQL date cast).
  assertValidCalendarDate(date, "date");

  // S14-5: Exclude archived learners and align afternoon counts with Stage 10 attendance_counted rules
  // (afternoon absent/excused marks are not counted when a non-voided early_sign_outs row exists for that learner & day).
  const morning = await tx.query<{ mark: string; n: number }>(
    `SELECT a.mark, count(*)::int AS n
       FROM attendance a
       JOIN learners l ON l.id = a.learner_id AND l.tenant_id = a.tenant_id AND l.archived_at IS NULL
      WHERE a.tenant_id = $1 AND a.taken_on = $2::date
      GROUP BY a.mark`,
    [tenantId, date],
  );
  const afternoon = await tx.query<{ mark: string; n: number }>(
    `SELECT pm.mark, count(*)::int AS n
       FROM attendance_afternoon pm
       JOIN learners l ON l.id = pm.learner_id AND l.tenant_id = pm.tenant_id AND l.archived_at IS NULL
      WHERE pm.tenant_id = $1
        AND pm.taken_on = $2::date
        AND NOT (
          pm.mark IN ('absent', 'excused')
          AND EXISTS (
            SELECT 1 FROM early_sign_outs e
             WHERE e.tenant_id = pm.tenant_id
               AND e.learner_id = pm.learner_id
               AND e.taken_on = pm.taken_on
               AND e.voided_at IS NULL
          )
        )
      GROUP BY pm.mark`,
    [tenantId, date],
  );
  const early = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM early_sign_outs e
       JOIN learners l ON l.id = e.learner_id AND l.tenant_id = e.tenant_id AND l.archived_at IS NULL
      WHERE e.tenant_id = $1 AND e.taken_on = $2::date AND e.voided_at IS NULL`,
    [tenantId, date],
  );

  const m = tallyMarks(morning.rows);
  const a = tallyMarks(afternoon.rows);
  return {
    date,
    morning_present: m.present,
    morning_absent: m.absent,
    morning_late: m.late,
    morning_excused: m.excused,
    afternoon_present: a.present,
    afternoon_absent: a.absent,
    afternoon_late: a.late,
    afternoon_excused: a.excused,
    early_sign_outs: early.rows[0]?.n ?? 0,
  };
}

export async function financeSummary(tx: Tx, tenantId: string, termId?: string): Promise<FinanceSummaryReport> {
  // S14-3: Validate termId belongs to tenantId.
  if (termId) {
    const term = await tx.query(`SELECT 1 FROM academic_terms WHERE tenant_id = $1 AND id = $2`, [tenantId, termId]);
    if (!term.rows[0]) throw notFound("Academic term not found");
  }

  // S14-2 & S14-7: Use public.finance_school_today($1) instead of hard-coded 'Africa/Nairobi',
  // and filter both invoices and payments consistently by live (non-voided) invoices and optional termId.
  const inv = await tx.query<{
    invoices_live: number;
    invoices_paid: number;
    invoices_part_paid: number;
    invoices_unpaid: number;
    invoices_overdue: number;
    amount_due_minor: string;
    amount_paid_minor: string;
  }>(
    `SELECT
       count(*)::int AS invoices_live,
       count(*) FILTER (WHERE public.finance_invoice_status(total_minor, paid_minor, due_on, public.finance_school_today($1)) = 'paid')::int AS invoices_paid,
       count(*) FILTER (WHERE public.finance_invoice_status(total_minor, paid_minor, due_on, public.finance_school_today($1)) = 'part_paid')::int AS invoices_part_paid,
       count(*) FILTER (WHERE public.finance_invoice_status(total_minor, paid_minor, due_on, public.finance_school_today($1)) = 'unpaid')::int AS invoices_unpaid,
       count(*) FILTER (WHERE public.finance_invoice_status(total_minor, paid_minor, due_on, public.finance_school_today($1)) = 'overdue')::int AS invoices_overdue,
       coalesce(sum(total_minor), 0)::bigint AS amount_due_minor,
       coalesce(sum(paid_minor), 0)::bigint AS amount_paid_minor
     FROM finance_invoices
     WHERE tenant_id = $1
       AND voided_at IS NULL
       AND ($2::uuid IS NULL OR term_id = $2::uuid)`,
    [tenantId, termId ?? null],
  );
  const pay = await tx.query<{ payments_success: number; payments_pending: number }>(
    `SELECT
       count(*) FILTER (WHERE p.status = 'success')::int AS payments_success,
       count(*) FILTER (WHERE p.status = 'pending')::int AS payments_pending
     FROM finance_payments p
     JOIN finance_invoices i ON i.id = p.invoice_id AND i.tenant_id = p.tenant_id
     WHERE p.tenant_id = $1
       AND i.voided_at IS NULL
       AND ($2::uuid IS NULL OR i.term_id = $2::uuid)`,
    [tenantId, termId ?? null],
  );
  const row = inv.rows[0]!;
  return {
    invoices_live: row.invoices_live,
    invoices_paid: row.invoices_paid,
    invoices_part_paid: row.invoices_part_paid,
    invoices_unpaid: row.invoices_unpaid,
    invoices_overdue: row.invoices_overdue,
    amount_due_minor: Number(row.amount_due_minor),
    amount_paid_minor: Number(row.amount_paid_minor),
    payments_success: pay.rows[0]?.payments_success ?? 0,
    payments_pending: pay.rows[0]?.payments_pending ?? 0,
  };
}

export async function academicsSummary(
  tx: Tx,
  tenantId: string,
  termId?: string,
): Promise<AcademicsSummaryReport> {
  if (termId) {
    const term = await tx.query(`SELECT 1 FROM academic_terms WHERE tenant_id = $1 AND id = $2`, [tenantId, termId]);
    if (!term.rows[0]) throw notFound("Academic term not found");
  }

  const r = await tx.query<{
    classes_active: number;
    assessments_draft: number;
    assessments_published: number;
    assessments_closed: number;
    cbe_assessments_draft: number;
    cbe_assessments_published: number;
    cbe_assessments_closed: number;
    report_cards_published: number;
    competency_ratings: number;
    learning_areas: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM classes
         WHERE tenant_id = $1 AND active = true AND archived_at IS NULL) AS classes_active,
       (SELECT count(*)::int FROM assessments
         WHERE tenant_id = $1 AND status = 'draft' AND archived_at IS NULL
           AND ($2::uuid IS NULL OR term_id = $2::uuid)) AS assessments_draft,
       (SELECT count(*)::int FROM assessments
         WHERE tenant_id = $1 AND status = 'published' AND archived_at IS NULL
           AND ($2::uuid IS NULL OR term_id = $2::uuid)) AS assessments_published,
       (SELECT count(*)::int FROM assessments
         WHERE tenant_id = $1 AND status = 'closed' AND archived_at IS NULL
           AND ($2::uuid IS NULL OR term_id = $2::uuid)) AS assessments_closed,
       (SELECT count(*)::int FROM cbe_assessments
         WHERE tenant_id = $1 AND status = 'draft'
           AND ($2::uuid IS NULL OR term_id = $2::uuid)) AS cbe_assessments_draft,
       (SELECT count(*)::int FROM cbe_assessments
         WHERE tenant_id = $1 AND status = 'published'
           AND ($2::uuid IS NULL OR term_id = $2::uuid)) AS cbe_assessments_published,
       (SELECT count(*)::int FROM cbe_assessments
         WHERE tenant_id = $1 AND status = 'closed'
           AND ($2::uuid IS NULL OR term_id = $2::uuid)) AS cbe_assessments_closed,
       (SELECT count(*)::int FROM report_card_publications
         WHERE tenant_id = $1
           AND ($2::uuid IS NULL OR term_id = $2::uuid)) AS report_cards_published,
       (SELECT count(*)::int FROM learner_competency_ratings
         WHERE tenant_id = $1
           AND ($2::uuid IS NULL OR term_id = $2::uuid)) AS competency_ratings,
       (SELECT count(*)::int FROM learning_areas WHERE tenant_id = $1) AS learning_areas`,
    [tenantId, termId ?? null],
  );
  const row = r.rows[0]!;
  return {
    term_id: termId ?? null,
    classes_active: row.classes_active,
    assessments_draft: row.assessments_draft,
    assessments_published: row.assessments_published,
    assessments_closed: row.assessments_closed,
    cbe_assessments_draft: row.cbe_assessments_draft,
    cbe_assessments_published: row.cbe_assessments_published,
    cbe_assessments_closed: row.cbe_assessments_closed,
    report_cards_published: row.report_cards_published,
    competency_ratings: row.competency_ratings,
    learning_areas: row.learning_areas,
  };
}
