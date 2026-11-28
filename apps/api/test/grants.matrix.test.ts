import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestApp } from "./support.js";

/** DML figbloom_app may hold. Anything else, including TRUNCATE, is drift. */
const EXPECTED: Record<string, string[]> = {
  organizations: ["SELECT"],
  tenants: ["SELECT"],
  // Migration 014: session writes are SECURITY DEFINER + HMAC; runtime retains SELECT only.
  sessions: ["SELECT"],
  platform_roles: ["SELECT"],
  organization_memberships: ["SELECT"],
  permissions: ["SELECT"],
  role_permissions: ["SELECT"],
  school_memberships: ["SELECT"],
  school_roles: ["SELECT"],
  school_role_assignments: ["SELECT"],
  auth_rate_buckets: ["INSERT", "SELECT", "UPDATE"],
  external_identities: ["INSERT", "SELECT", "UPDATE"],
  external_identity_link_events: ["INSERT"],
  staff_area_grants: ["DELETE", "INSERT", "SELECT"],
  // Migration 025: UPDATE only on (revoked_at, revoked_by), asserted as column grants below.
  org_admin_school_delegations: ["INSERT", "SELECT"],
  // Migration 027: every directory table's UPDATE is column-level — only the columns its module
  // writes — so no table-level UPDATE appears here. The exact column sets are asserted below.
  learners: ["INSERT", "SELECT"],
  guardians: ["INSERT", "SELECT"],
  guardian_links: ["INSERT", "SELECT"],
  school_profiles: ["INSERT", "SELECT"],
  staff_members: ["INSERT", "SELECT"],
  // Migration 025 (FIG-1614 Option D): grant rows are inserted and soft-revoked (UPDATE), never deleted.
  staff_resource_grants: ["INSERT", "SELECT"],
  directory_documents: ["INSERT", "SELECT"],
  idempotency_keys: ["INSERT", "SELECT", "UPDATE"],
  security_audit_events: ["INSERT"],
  // Stage 9 structure (029) and assessments/CBC/higher-ed (030–032).
  // UPDATE is column-level only, so it does not appear as a table privilege.
  academic_years: ["INSERT", "SELECT"],
  academic_terms: ["INSERT", "SELECT"],
  subjects: ["INSERT", "SELECT"],
  classes: ["INSERT", "SELECT"],
  class_memberships: ["INSERT", "SELECT"],
  teaching_assignments: ["INSERT", "SELECT"],
  timetable_slots: ["INSERT", "SELECT"],
  timetable_publications: ["INSERT", "SELECT"],
  assessments: ["INSERT", "SELECT"],
  assessment_components: ["INSERT", "SELECT"],
  mark_entries: ["INSERT", "SELECT"],
  homework_items: ["INSERT", "SELECT"],
  learning_materials: ["INSERT", "SELECT"],
  report_card_publications: ["INSERT", "SELECT"],
  grading_schemes: ["INSERT", "SELECT"],
  curriculum_provenance: ["INSERT", "SELECT"],
  learning_areas: ["INSERT", "SELECT"],
  strands: ["INSERT", "SELECT"],
  sub_strands: ["INSERT", "SELECT"],
  learning_outcomes: ["INSERT", "SELECT"],
  rubric_descriptor_configs: ["INSERT", "SELECT"],
  cbe_assessments: ["INSERT", "SELECT"],
  cbe_results: ["INSERT", "SELECT"],
  evidence_assets: ["INSERT", "SELECT"],
  learner_competency_ratings: ["INSERT", "SELECT"],
  learner_competency_rating_revisions: ["INSERT", "SELECT"],
  curriculum_reference_entries: ["SELECT"],
  he_courses: ["INSERT", "SELECT"],
  he_sections: ["INSERT", "SELECT"],
  he_enrolments: ["INSERT", "SELECT"],
  he_grades: ["INSERT", "SELECT"],
  online_exam_papers: ["INSERT", "SELECT"],
  online_exam_attempts: ["INSERT", "SELECT"],
  attempt_marks: ["INSERT", "SELECT"],
  // Stage 10 attendance (033).
  attendance_settings: ["INSERT", "SELECT"],
  attendance: ["INSERT", "SELECT"],
  attendance_afternoon: ["INSERT", "SELECT"],
  attendance_coverage: ["INSERT", "SELECT"],
  vehicle_locations: ["INSERT", "SELECT"],
  mfa_factors: ["INSERT", "SELECT"],
  mfa_recovery_codes: ["INSERT", "SELECT"],
  early_sign_outs: ["INSERT", "SELECT"],
  early_sign_out_collectors: ["INSERT", "SELECT"],
  // Migration 035 (owner decisions OD-1/3/5): append-only revision tables. No UPDATE, no DELETE.
  mark_corrections: ["INSERT", "SELECT"],
  cbe_result_revisions: ["INSERT", "SELECT"],
  he_grade_revisions: ["INSERT", "SELECT"],
  // Migrations 036-039 (Stage 11 finance and the job runtime): INSERT + SELECT only; UPDATE is column-level.
  // jobs: column-level only since migration 065 (INSERT of enqueue columns, SELECT excluding lease_token): no table-level grant
  finance_fee_items: ["INSERT", "SELECT"],
  finance_invoices: ["INSERT", "SELECT"],
  finance_invoice_lines: ["INSERT", "SELECT"],
  finance_charges: ["INSERT", "SELECT"],
  finance_invoice_adjustments: ["INSERT", "SELECT"],
  finance_payments: ["INSERT", "SELECT"],
  finance_mpesa_events: ["INSERT", "SELECT"],
  finance_payment_proofs: ["INSERT", "SELECT"],
  finance_reconciliation_runs: ["INSERT", "SELECT"],
  finance_reconciliation_findings: ["INSERT", "SELECT"],
  finance_ai_helper_settings: ["INSERT", "SELECT"],
  finance_ai_helper_optins: ["INSERT", "SELECT"],
  finance_ai_helper_optin_log: ["INSERT", "SELECT"],
  finance_bank_statements: ["INSERT", "SELECT"],
  finance_bank_statement_lines: ["INSERT", "SELECT"],
  teacher_reports: ["INSERT", "SELECT"],
  // Migration 048 (Stage 12 announcements): UPDATE is column-level only.
  communications_announcements: ["INSERT", "SELECT"],
  communications_announcement_reads: ["INSERT", "SELECT"],
  communications_announcement_deliveries: ["INSERT", "SELECT"],
  // Migration 050–051.
  notification_preferences: ["DELETE", "INSERT", "SELECT"],
  device_tokens: ["DELETE", "INSERT", "SELECT"],
  gate_visits: ["INSERT", "SELECT"],
  medical_settings: ["INSERT", "SELECT"],
  sick_bay_visit_corrections: ["SELECT"], // 066: append-only history, written only by the guard trigger
  sick_bay_visits: ["INSERT", "SELECT"],
  medical_notices: ["INSERT", "SELECT"],
  conversations: ["INSERT", "SELECT"],
  conversation_members: ["INSERT", "SELECT"],
  chat_messages: ["INSERT", "SELECT"],
  inventory_items: ["INSERT", "SELECT"],
  inventory_issues: ["INSERT", "SELECT"],
  // Migration 118 (docs/BEHAVIOUR.md): an entry is only ever voided or followed up (column grants), a staff note never changes.
  behaviour_settings: ["INSERT", "SELECT"],
  behaviour_categories: ["INSERT", "SELECT"],
  behaviour_entries: ["INSERT", "SELECT"],
  behaviour_staff_notes: ["INSERT", "SELECT"],
  // Migration 115: a stock movement is never rewritten or removed.
  inventory_movements: ["INSERT", "SELECT"],
  leave_requests: ["INSERT", "SELECT"],
  activities: ["INSERT", "SELECT"],
  activity_patrons: ["INSERT", "SELECT"],
  activity_members: ["INSERT", "SELECT"],
  vehicles: ["INSERT", "SELECT"],
  transport_routes: ["INSERT", "SELECT"],
  route_stops: ["INSERT", "SELECT"],
  vehicle_assignments: ["INSERT", "SELECT"],
  learner_transport: ["INSERT", "SELECT"],
  trips: ["INSERT", "SELECT"],
  trip_events: ["INSERT", "SELECT"],
  transport_notifications: ["SELECT"],
  notification_outbox: ["INSERT", "SELECT"],
  notifications: ["SELECT"],
  notification_delivery_attempts: ["SELECT"],
  storage_objects: ["INSERT", "SELECT"],
  export_jobs: ["INSERT", "SELECT"],
  learner_health_profiles: ["INSERT", "SELECT"],
  medication_authorizations: ["INSERT", "SELECT"],
  medication_schedules: ["INSERT", "SELECT"],
  medication_administration_records: ["INSERT", "SELECT"],
  medication_administration_corrections: ["INSERT", "SELECT"],
  medication_incidents: ["INSERT", "SELECT"],
  curriculum_import_batches: ["INSERT", "SELECT"],
  transport_incidents: ["INSERT", "SELECT"],
  import_batches: ["INSERT", "SELECT"],
  // Migration 108 (My HR): the platform link is written by an operator as the migrator; the API reads it. Migration 117 adds a
  // column-level UPDATE of the three HR-answer columns (asserted below), so no table-level UPDATE appears here.
  platform_school_links: ["SELECT"],
};

/** Stage 12: columns figbloom_app may UPDATE on announcements (identity/provenance never listed). */
const EXPECTED_COMMUNICATIONS_UPDATE_COLUMNS: Record<string, string[]> = {
  communications_announcements: ["audience", "body", "channels", "published_at", "subject"],
  conversations: ["last_message_at"],
  conversation_members: ["last_read_at"],
  medical_settings: ["notify_guardians", "updated_at", "updated_by"],
  medical_notices: ["read_at"],
  notification_preferences: [
    "absence_today",
    "chat_messages",
    "fee_reminders",
    "general_notices",
    "results_published",
    "updated_at",
  ],
  gate_visits: [
    "escalated",
    "escalated_at",
    "escalation_notified_at",
    "host_notified_at",
    "left_at",
    "note",
    "reception_at",
    "status",
    "updated_at",
    "with_host_at",
  ],
  sick_bay_visits: [
    "assessment",
    "attendance_mark",
    "attendance_marked_at",
    "complaint",
    "correction_reason",
    "follow_up",
    "observations",
    "outcome",
    "pulse_bpm",
    "referred_to",
    "row_version",
    "temperature_c",
    "time_out",
    "treatment",
    "updated_at",
  ],
};

/**
 * Stage 11: the ONLY columns each runtime role may UPDATE on the finance tables and jobs. Money (amounts, totals,
 * paid, currency), identity, provenance and the payment's method/reference/msisdn are in no list: no
 * application path changes them, and the privilege is absent as well as the code. Widening any list is a security change.
 */
const EXPECTED_FINANCE_UPDATE_COLUMNS: Record<"figbloom_app" | "figbloom_worker", Record<string, string[]>> = {
  figbloom_app: {
    finance_fee_items: ["active", "amount_minor", "applies_to", "archived_at", "form_level", "name", "updated_at"],
    finance_invoices: ["due_on", "updated_at", "void_reason", "voided_at", "voided_by"],
    finance_charges: ["void_reason", "voided_at", "voided_by"],
    finance_payments: ["checkout_request_id", "completed_at", "failure_reason", "merchant_request_id", "mpesa_receipt", "status", "updated_at"],
    finance_payment_proofs: ["payment_id", "rejection_reason", "reviewed_at", "reviewed_by", "status"],
    finance_reconciliation_runs: ["findings_count"],
    finance_reconciliation_findings: ["assigned_at", "owner_user_id", "resolution_evidence", "resolution_note", "resolved_at", "resolved_by", "status"],
    finance_ai_helper_settings: ["access_mode", "cancel_days", "price_minor", "updated_at", "updated_by"],
    finance_ai_helper_optins: ["changed_at", "changed_by", "opted_in"],
    finance_bank_statements: ["matched_count", "status", "unmatched_count"],
    finance_bank_statement_lines: ["match_note", "match_status", "matched_at", "matched_by", "matched_invoice_id", "matched_payment_id"],
  },
  figbloom_worker: {
    // F-8 & F8-A (migrations 047, 061): worker has no direct UPDATE on finance_payments, finance_invoices or jobs.
  },
};
const FINANCE_NEVER_UPDATABLE: Array<[string, string[]]> = [
  ["finance_invoices", ["lines_minor", "charges_minor", "adjustments_minor", "total_minor", "paid_minor", "currency", "learner_id", "term_id", "tenant_id"]],
  ["finance_payments", ["amount_minor", "currency", "method", "reference", "msisdn", "invoice_id", "proof_id", "recorded_by", "tenant_id", "applied_minor", "unapplied_minor"]],
  ["finance_invoice_lines", ["amount_minor", "name"]],
  ["finance_invoice_adjustments", ["to_total_minor", "delta_minor", "reason"]],
  ["jobs", ["tenant_id", "job_type", "payload", "idempotency_key", "enqueued_by_user_id", "attempts", "cancel_reason", "status", "leased_by", "lease_expires_at", "run_after", "last_error_code", "finished_at"]],
];

/**
 * Migration 027 (P3-AUDIT-009). Identity (`id`, `tenant_id`), provenance (`created_at`,
 * `created_by`, `uploaded_by`) and storage-contract columns (`storage_key`, `storage_status`,
 * `logo_object_key`) are absent from every list: no application path updates them, and the
 * privilege is now gone as well as the code. Widening any of these lists is a security change.
 */
const EXPECTED_DIRECTORY_UPDATE_COLUMNS: Record<string, string[]> = {
  learners: [
    "active",
    "admission_no",
    "archived_at",
    "boarding",
    "date_of_birth",
    "full_name",
    "gender",
    "updated_at",
  ],
  guardians: ["active", "alt_phone", "archived_at", "email", "full_name", "phone", "updated_at"],
  guardian_links: ["archived_at", "archived_reason"],
  staff_members: [
    "active",
    "archived_at",
    "classification",
    "email",
    "full_name",
    "phone",
    "staff_title",
    "updated_at",
    "user_id",
  ],
  school_profiles: [
    "accent",
    "contact_email",
    "contact_phone",
    "country",
    "county",
    "institution_type",
    "level",
    "moe_registration",
    "updated_at",
  ],
  directory_documents: ["archived_at", "updated_at"],
};

/**
 * Migration 079 (CBC engine) column-level UPDATE grants, plus prior Stage 9 grants they extend.
 * Migration 101 adds classes.room and the subject level, year range and core flag (class, subject and
 * teaching-assignment updates); teaching_assignments keeps its 029 columns.
 * Migration 107 adds the one column a higher-education section may change, its instructor.
 * Identity/provenance columns (id, tenant_id, created_*) must never appear.
 */
const EXPECTED_ACADEMICS_079_UPDATE_COLUMNS: Record<string, string[]> = {
  classes: [
    "active",
    "archived_at",
    "class_teacher_staff_id",
    "education_level",
    "form_level",
    "name",
    "pathway",
    "room",
    "stream",
    "updated_at",
  ],
  subjects: [
    "active",
    "archived_at",
    "code",
    "education_level",
    "is_core",
    "max_form_level",
    "min_form_level",
    "name",
    "updated_at",
  ],
  teaching_assignments: ["active", "archived_at", "staff_member_id", "updated_at"],
  learning_areas: ["code", "education_level", "is_core", "max_grade", "min_grade", "name", "pathway"],
  rubric_descriptor_configs: ["criteria", "descriptors", "name", "scoring_mode", "version"],
  cbe_assessments: [
    "assessment_date",
    "closed_at",
    "curriculum_version_label",
    "instructions",
    "instrument_type",
    "learning_outcome_id",
    "published_at",
    "row_version",
    "rubric_config_id",
    "status",
    "strand_id",
    "sub_strand_id",
    "title",
  ],
  cbe_results: [
    "completion_status",
    "criterion_scores",
    "evidence_asset_id",
    "level_code",
    "marked_at",
    "marked_by",
    "observation",
    "points",
    "row_version",
    "teacher_feedback",
  ],
  learner_competency_ratings: ["level_code", "rated_at", "rated_by", "row_version"],
  // Migration 107: a higher-education section's instructor, and nothing else about the section.
  he_sections: ["instructor_staff_id"],
  homework_items: ["archived_at", "archived_by", "body", "class_id", "due_on", "hand_in", "parent_guide", "subject_id", "title", "updated_at"],
  assessments: ["archived_at", "published_at", "status", "title", "updated_at", "version"],
  online_exam_papers: ["archived_at", "max_score", "published_at", "questions", "title"],
  learning_materials: ["archived_at", "class_id", "description", "published_at", "subject_id", "title", "url"],
};

const ACADEMICS_079_NEVER_UPDATABLE: Record<string, string[]> = {
  classes: ["id", "tenant_id", "academic_year_id", "created_at", "created_by"],
  subjects: ["id", "tenant_id", "created_at", "created_by"],
  teaching_assignments: ["id", "tenant_id", "class_id", "subject_id", "created_at", "created_by"],
  learning_areas: ["id", "tenant_id", "provenance_id", "created_at", "created_by"],
  rubric_descriptor_configs: ["id", "tenant_id", "created_at", "created_by"],
  cbe_assessments: ["id", "tenant_id", "class_id", "learning_area_id", "term_id", "created_at", "created_by"],
  cbe_results: ["id", "tenant_id", "cbe_assessment_id", "learner_id", "strand_id", "learning_outcome_id", "created_at"],
  learner_competency_ratings: ["id", "tenant_id", "term_id", "learner_id", "kind", "item", "created_at"],
  he_sections: ["id", "tenant_id", "course_id", "term_id", "label", "created_at", "created_by"],
  homework_items: ["id", "tenant_id", "term_id", "created_by", "created_at"],
  assessments: ["id", "tenant_id", "class_id", "subject_id", "term_id", "kind", "max_score", "created_by", "created_at"],
  online_exam_papers: ["id", "tenant_id", "class_id", "subject_id", "created_by", "created_at"],
  learning_materials: ["id", "tenant_id", "created_by", "created_at"],
};

describe("migration 009 grants and policies", () => {
  let ctx: Awaited<ReturnType<typeof createTestApp>>;

  beforeAll(async () => {
    ctx = await createTestApp();
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("UPDATE on the two grant tables is column-level, revocation columns only (review M-1)", async () => {
    const r = await ctx.pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.column_privileges
        WHERE grantee = 'figbloom_app' AND table_schema = 'public' AND privilege_type = 'UPDATE'
          AND table_name IN ('org_admin_school_delegations', 'staff_resource_grants')
        ORDER BY table_name, column_name`,
    );
    const by: Record<string, string[]> = {};
    for (const row of r.rows) (by[row.table_name] ??= []).push(row.column_name);
    expect(by).toEqual({
      org_admin_school_delegations: ["revoked_at", "revoked_by"],
      staff_resource_grants: ["revoke_reason", "revoked_at", "revoked_by"],
    });
  });

  it("finance tables and jobs: UPDATE is column-level and money, identity and provenance are never updatable (Stage 11)", async () => {
    for (const role of ["figbloom_app", "figbloom_worker"] as const) {
      const tables = Object.keys(EXPECTED_FINANCE_UPDATE_COLUMNS[role]);
      const r = await ctx.pool.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.column_privileges
          WHERE grantee = $1 AND table_schema = 'public' AND privilege_type = 'UPDATE'
            AND (table_name LIKE 'finance\\_%' OR table_name = 'jobs')
          ORDER BY table_name, column_name`,
        [role],
      );
      const by: Record<string, string[]> = {};
      for (const row of r.rows) (by[row.table_name] ??= []).push(row.column_name);
      expect(by, role).toEqual(EXPECTED_FINANCE_UPDATE_COLUMNS[role]);
      for (const t of tables) {
        const tbl = await ctx.pool.query<{ tbl: boolean }>(`SELECT has_table_privilege($1, $2, 'UPDATE') AS tbl`, [role, `public.${t}`]);
        expect(tbl.rows[0]?.tbl, `${role} ${t} table-level UPDATE`).toBe(false);
      }
      for (const [t, cols] of FINANCE_NEVER_UPDATABLE) {
        for (const col of cols) {
          const eff = await ctx.pool.query<{ upd: boolean }>(`SELECT has_column_privilege($1, $2, $3, 'UPDATE') AS upd`, [role, `public.${t}`, col]);
          expect(eff.rows[0]?.upd, `${role} ${t}.${col}`).toBe(false);
        }
      }
    }
    // neither runtime role may DELETE or TRUNCATE any finance table or jobs
    const del = await ctx.pool.query(
      `SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee IN ('figbloom_app', 'figbloom_worker') AND table_schema = 'public'
          AND (table_name LIKE 'finance\\_%' OR table_name = 'jobs') AND privilege_type IN ('DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')`,
    );
    expect(del.rows).toEqual([]);
  });

  it("communications announcements: UPDATE is column-level; identity and provenance are never updatable (Stage 12)", async () => {
    const tables = Object.keys(EXPECTED_COMMUNICATIONS_UPDATE_COLUMNS);
    const r = await ctx.pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.column_privileges
        WHERE grantee = 'figbloom_app' AND table_schema = 'public' AND privilege_type = 'UPDATE'
          AND table_name = ANY($1::text[])
        ORDER BY table_name, column_name`,
      [tables],
    );
    const by: Record<string, string[]> = {};
    for (const row of r.rows) (by[row.table_name] ??= []).push(row.column_name);
    expect(by).toEqual(EXPECTED_COMMUNICATIONS_UPDATE_COLUMNS);
    const forbiddenByTable: Record<string, string[]> = {
      communications_announcements: ["id", "tenant_id", "author_id", "created_at"],
      conversations: ["id", "tenant_id", "pair_key", "created_by", "created_at"],
      conversation_members: ["conversation_id", "tenant_id", "user_id"],
      medical_settings: ["tenant_id"],
      medical_notices: ["id", "tenant_id", "visit_id", "guardian_user_id", "learner_id", "outcome", "summary"],
      notification_preferences: ["user_id"],
      gate_visits: ["id", "tenant_id", "recorded_by", "arrived_at"],
      sick_bay_visits: ["id", "tenant_id", "learner_id", "logged_by", "time_in"],
    };
    for (const [table, columns] of Object.entries(EXPECTED_COMMUNICATIONS_UPDATE_COLUMNS)) {
      for (const column of forbiddenByTable[table] ?? ["id", "tenant_id"]) {
        if (columns.includes(column)) continue;
        const eff = await ctx.pool.query<{ upd: boolean }>(
          `SELECT has_column_privilege('figbloom_app', $1, $2, 'UPDATE') AS upd`,
          [`public.${table}`, column],
        );
        expect(eff.rows[0]?.upd, `${table}.${column}`).toBe(false);
      }
      const priv = await ctx.pool.query<{ tbl: boolean; any_col: boolean }>(
        `SELECT has_table_privilege('figbloom_app', $1, 'UPDATE') AS tbl,
                has_any_column_privilege('figbloom_app', $1, 'UPDATE') AS any_col`,
        [`public.${table}`],
      );
      expect(priv.rows[0]?.tbl, `${table} table-level UPDATE`).toBe(false);
      expect(priv.rows[0]?.any_col, `${table} any-column UPDATE`).toBe(true);
    }
    const worker = await ctx.pool.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'figbloom_worker' AND table_schema = 'public'
          AND table_name LIKE 'communications\\_%'
        ORDER BY table_name, privilege_type`,
    );
    const wBy: Record<string, string[]> = {};
    for (const row of worker.rows) (wBy[row.table_name] ??= []).push(row.privilege_type);
    expect(wBy).toEqual({
      communications_announcement_deliveries: ["INSERT", "SELECT"],
      communications_announcements: ["SELECT"],
    });
  });

  it("directory tables: UPDATE is column-level and names only the columns the modules write (P3-AUDIT-009)", async () => {
    const tables = Object.keys(EXPECTED_DIRECTORY_UPDATE_COLUMNS);
    const r = await ctx.pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.column_privileges
        WHERE grantee = 'figbloom_app' AND table_schema = 'public' AND privilege_type = 'UPDATE'
          AND table_name = ANY($1::text[])
        ORDER BY table_name, column_name`,
      [tables],
    );
    const by: Record<string, string[]> = {};
    for (const row of r.rows) (by[row.table_name] ??= []).push(row.column_name);
    expect(by).toEqual(EXPECTED_DIRECTORY_UPDATE_COLUMNS);

    // The point of the change: identity and provenance are not updatable at all, as PostgreSQL
    // itself computes it — not merely absent from the list above.
    for (const [table, columns] of Object.entries(EXPECTED_DIRECTORY_UPDATE_COLUMNS)) {
      const forbidden = ["id", "tenant_id", "created_at", "created_by"].filter(
        (c) => !columns.includes(c),
      );
      for (const column of forbidden) {
        const exists = await ctx.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
          [table, column],
        );
        if (exists.rows[0]!.n === 0) continue;
        const eff = await ctx.pool.query<{ upd: boolean }>(
          `SELECT has_column_privilege('figbloom_app', $1, $2, 'UPDATE') AS upd`,
          [`public.${table}`, column],
        );
        expect(eff.rows[0]?.upd, `${table}.${column} UPDATE`).toBe(false);
      }
      // Table-level UPDATE really is gone, and only the column-level privilege remains.
      const priv = await ctx.pool.query<{ tbl: boolean; any_col: boolean }>(
        `SELECT has_table_privilege('figbloom_app', $1, 'UPDATE') AS tbl,
                has_any_column_privilege('figbloom_app', $1, 'UPDATE') AS any_col`,
        [`public.${table}`],
      );
      expect(priv.rows[0]?.tbl, `${table} table-level UPDATE`).toBe(false);
      expect(priv.rows[0]?.any_col, `${table} any-column UPDATE`).toBe(true);
    }
  });

  it("academics CBC tables: UPDATE is column-level including migration 079 metadata/lifecycle columns", async () => {
    const tables = Object.keys(EXPECTED_ACADEMICS_079_UPDATE_COLUMNS);
    const r = await ctx.pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.column_privileges
        WHERE grantee = 'figbloom_app' AND table_schema = 'public' AND privilege_type = 'UPDATE'
          AND table_name = ANY($1::text[])
        ORDER BY table_name, column_name`,
      [tables],
    );
    const by: Record<string, string[]> = {};
    for (const row of r.rows) (by[row.table_name] ??= []).push(row.column_name);
    expect(by).toEqual(EXPECTED_ACADEMICS_079_UPDATE_COLUMNS);

    for (const [table, columns] of Object.entries(EXPECTED_ACADEMICS_079_UPDATE_COLUMNS)) {
      for (const column of ACADEMICS_079_NEVER_UPDATABLE[table] ?? ["id", "tenant_id"]) {
        if (columns.includes(column)) continue;
        const exists = await ctx.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
          [table, column],
        );
        if (exists.rows[0]!.n === 0) continue;
        const eff = await ctx.pool.query<{ upd: boolean }>(
          `SELECT has_column_privilege('figbloom_app', $1, $2, 'UPDATE') AS upd`,
          [`public.${table}`, column],
        );
        expect(eff.rows[0]?.upd, `${table}.${column} UPDATE`).toBe(false);
      }
      const priv = await ctx.pool.query<{ tbl: boolean; any_col: boolean }>(
        `SELECT has_table_privilege('figbloom_app', $1, 'UPDATE') AS tbl,
                has_any_column_privilege('figbloom_app', $1, 'UPDATE') AS any_col`,
        [`public.${table}`],
      );
      expect(priv.rows[0]?.tbl, `${table} table-level UPDATE`).toBe(false);
      expect(priv.rows[0]?.any_col, `${table} any-column UPDATE`).toBe(true);
    }
  });

  it("row locking still works under column-level grants, so read-modify-write stays serialised (P3-AUDIT-012)", async () => {
    // The lost-update fix depends on SELECT ... FOR UPDATE, which needs an UPDATE privilege.
    // PostgreSQL accepts a column-level one, but that is not obvious from the catalogue
    // (has_table_privilege says false), so it is proved by executing the lock.
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE figbloom_app");
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ctx.ids.tenantA]);
      for (const table of Object.keys(EXPECTED_DIRECTORY_UPDATE_COLUMNS)) {
        await client.query("SAVEPOINT sp_lock");
        await expect(
          client.query(`SELECT 1 FROM ${table} LIMIT 1 FOR UPDATE`),
          `${table} FOR UPDATE`,
        ).resolves.toBeDefined();
        await client.query("RELEASE SAVEPOINT sp_lock");
      }
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("matches the code-audit grant matrix", async () => {
    const grants = await ctx.pool.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type
       FROM information_schema.role_table_grants
       WHERE grantee = 'figbloom_app' AND table_schema = 'public'
       ORDER BY table_name, privilege_type`,
    );
    const actual: Record<string, string[]> = {};
    for (const row of grants.rows) {
      (actual[row.table_name] ??= []).push(row.privilege_type);
    }
    expect(actual).toEqual(EXPECTED);
    const excess = grants.rows.filter((r) =>
      ["TRUNCATE", "REFERENCES", "TRIGGER"].includes(r.privilege_type),
    );
    expect(excess).toEqual([]);
  });

  it("inventory item stock configuration uses only column-level UPDATE grants (migration 130)", async () => {
    const cols = await ctx.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE grantee = 'figbloom_app' AND table_schema = 'public'
          AND table_name = 'inventory_items' AND privilege_type = 'UPDATE'
        ORDER BY column_name`,
    );
    // Migration 054 already gave column-level UPDATE on the item's details; migration 130 adds the three stock columns (unit, consumable,
    // reorder_level). Nothing else is updatable (quantity moves through inventory_movements, id and tenant_id never change), and the
    // role has no table-level UPDATE.
    expect(cols.rows.map((r) => r.column_name)).toEqual([
      "asset_tag", "category", "condition", "consumable", "location", "name", "notes", "purchased_on", "quantity", "reorder_level",
      "retired_at", "tracking", "unit", "unit_cost_cents", "updated_at",
    ]);
    const priv = await ctx.pool.query<{ tbl: boolean }>(`SELECT has_table_privilege('figbloom_app', 'public.inventory_items', 'UPDATE') AS tbl`);
    expect(priv.rows[0]?.tbl).toBe(false);
  });

  it("users: no table-level privilege; password_hash is neither selectable nor updatable by the runtime role (migrations 011 and 013)", async () => {
    const cols = await ctx.pool.query<{ column_name: string; privilege_type: string }>(
      `SELECT column_name, privilege_type
         FROM information_schema.role_column_grants
        WHERE grantee = 'figbloom_app' AND table_schema = 'public' AND table_name = 'users'
        ORDER BY privilege_type, column_name`,
    );
    const sel = cols.rows.filter((r) => r.privilege_type === "SELECT").map((r) => r.column_name).sort();
    const upd = cols.rows.filter((r) => r.privilege_type === "UPDATE").map((r) => r.column_name).sort();
    expect(sel).toEqual(["created_at", "email", "full_name", "id", "must_change_password", "phone", "status", "updated_at"]);
    expect(sel).not.toContain("password_hash");
    expect(upd).toEqual([]);
    expect(cols.rows.filter((r) => !["SELECT", "UPDATE"].includes(r.privilege_type))).toEqual([]);
    // Effective privilege on the hash column, as PostgreSQL computes it.
    const eff = await ctx.pool.query<{ sel: boolean; upd: boolean; ins: boolean; tbl_sel: boolean }>(
      `SELECT has_column_privilege('figbloom_app', 'public.users', 'password_hash', 'SELECT') AS sel,
              has_column_privilege('figbloom_app', 'public.users', 'password_hash', 'UPDATE') AS upd,
              has_column_privilege('figbloom_app', 'public.users', 'password_hash', 'INSERT') AS ins,
              has_table_privilege('figbloom_app', 'public.users', 'SELECT') AS tbl_sel`,
    );
    expect(eff.rows[0]).toEqual({ sel: false, upd: false, ins: false, tbl_sel: false });
  });

  it("HR & Payroll hand-off (migration 117): platform_school_links UPDATE is the three HR-answer columns only; tenants stays SELECT-only", async () => {
    const cols = await ctx.pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.column_privileges
        WHERE grantee = 'figbloom_app' AND table_schema = 'public' AND privilege_type = 'UPDATE'
          AND table_name IN ('platform_school_links', 'tenants')
        ORDER BY table_name, column_name`,
    );
    expect(cols.rows).toEqual([
      { table_name: "platform_school_links", column_name: "hr_checked_at" },
      { table_name: "platform_school_links", column_name: "hr_enabled" },
      { table_name: "platform_school_links", column_name: "hr_reason" },
    ]);
    const eff = await ctx.pool.query<Record<string, boolean>>(
      `SELECT has_table_privilege('figbloom_app', 'public.platform_school_links', 'UPDATE') AS links_tbl,
              has_column_privilege('figbloom_app', 'public.platform_school_links', 'tenant_id', 'UPDATE') AS links_tenant,
              has_column_privilege('figbloom_app', 'public.platform_school_links', 'platform_tenant_id', 'UPDATE') AS links_platform_id,
              has_column_privilege('figbloom_app', 'public.platform_school_links', 'registered_at', 'UPDATE') AS links_registered,
              has_table_privilege('figbloom_app', 'public.platform_school_links', 'INSERT') AS links_ins,
              has_table_privilege('figbloom_app', 'public.platform_school_links', 'DELETE') AS links_del,
              has_any_column_privilege('figbloom_app', 'public.tenants', 'UPDATE') AS tenants_upd,
              has_column_privilege('figbloom_app', 'public.tenants', 'hr_requested_at', 'SELECT') AS tenants_hr_sel`,
    );
    expect(eff.rows[0]).toEqual({
      links_tbl: false,
      links_tenant: false,
      links_platform_id: false,
      links_registered: false,
      links_ins: false,
      links_del: false,
      tenants_upd: false,
      tenants_hr_sel: true,
    });
  });

  it("revokes CREATE on schema public and does not reference a mode GUC", async () => {
    const create = await ctx.pool.query<{ app: boolean; pub: number }>(
      `SELECT has_schema_privilege('figbloom_app', 'public', 'CREATE') AS app,
              (SELECT count(*)::int FROM pg_namespace n, aclexplode(n.nspacl) x
                WHERE n.nspname = 'public' AND x.grantee = 0 AND x.privilege_type = 'CREATE') AS pub`,
    );
    expect(create.rows[0]?.app).toBe(false);
    expect(create.rows[0]?.pub).toBe(0);

    const sql = readFileSync(join(process.cwd(), "migrations", "009_runtime_rls_hardening.sql"), "utf8");
    expect(sql).not.toMatch(/authz_mode/);
    const policies = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_policy
       WHERE pg_get_expr(polqual, polrelid) ILIKE '%authz_mode%'
          OR pg_get_expr(polwithcheck, polrelid) ILIKE '%authz_mode%'`,
    );
    expect(policies.rows[0]?.n).toBe(0);

    const owner = await ctx.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_policy WHERE polname LIKE '%_owner' AND pg_get_expr(polqual, polrelid) ILIKE '%relowner%'`,
    );
    expect(owner.rows[0]?.n).toBeGreaterThanOrEqual(8);
  });

  it("asserts TEMPORARY is revoked from figbloom_app (effective privilege)", async () => {
    const temp = await ctx.pool.query<{ app_temp: boolean; public_temp: boolean }>(
      `SELECT has_database_privilege('figbloom_app', current_database(), 'TEMPORARY') AS app_temp,
              has_database_privilege('public', current_database(), 'TEMPORARY') AS public_temp`,
    );
    expect(temp.rows[0]?.app_temp).toBe(false);
    expect(temp.rows[0]?.public_temp).toBe(false);
  });

  it("a probe role with SELECT is not the owner and sees zero learner rows", async () => {
    await ctx.pool.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'figbloom_probe') THEN
          REVOKE ALL ON TABLE public.learners FROM figbloom_probe;
          REVOKE ALL ON SCHEMA public FROM figbloom_probe;
          IF EXISTS (
            SELECT 1 FROM pg_auth_members m
            JOIN pg_roles granted ON granted.oid = m.roleid
            JOIN pg_roles member ON member.oid = m.member
            WHERE granted.rolname = 'figbloom_probe' AND member.rolname = current_user
          ) THEN
            REVOKE figbloom_probe FROM CURRENT_USER;
          END IF;
          DROP ROLE figbloom_probe;
        END IF;
      END $$
    `);
    await ctx.pool.query(`CREATE ROLE figbloom_probe NOLOGIN`);
    await ctx.pool.query(`GRANT figbloom_probe TO CURRENT_USER`);
    await ctx.pool.query(`GRANT USAGE ON SCHEMA public TO figbloom_probe`);
    await ctx.pool.query(`GRANT SELECT ON learners TO figbloom_probe`);
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE figbloom_probe");
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [ctx.ids.tenantA]);
      const rows = await client.query(`SELECT id FROM learners`);
      expect(rows.rowCount).toBe(0);
      await client.query("ROLLBACK");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      await ctx.pool.query(`REVOKE figbloom_probe FROM CURRENT_USER`);
      await ctx.pool.query(`REVOKE ALL ON TABLE public.learners FROM figbloom_probe`);
      await ctx.pool.query(`REVOKE ALL ON SCHEMA public FROM figbloom_probe`);
      await ctx.pool.query(`DROP ROLE figbloom_probe`);
    }
  });
});
