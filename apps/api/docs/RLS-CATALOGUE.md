# RLS catalogue: protected tables and policies (FIG-1605)

Maintained by hand, enforced by `test/fig1605.policyCatalogue.test.ts`: every table that has row security
in the live catalogue must appear here (in backticks), be `FORCE`d, and carry no policy that lets the
runtime role `figbloom_app` (directly or through `PUBLIC`) in without a predicate. A new table with RLS
that is not listed here fails the suite.

Policy shape (migration 009 onward): one `FOR ALL TO figbloom_app` policy whose `USING` and `WITH CHECK`
are `tenant_id = app_current_tenant_id()`, plus one `FOR ALL TO PUBLIC` **owner-only** policy
(`current_user = pg_get_userbyid(relowner)`), which is what lets the migrator work under `FORCE`. There is
no mode GUC and no application-settable bypass.

| Table | Kind | Runtime policy (figbloom_app) | Created / hardened in | Runtime isolation test |
|---|---|---|---|---|
| `staff_area_grants` | tenant | `tenant_id = app_current_tenant_id()` | 004, 009 | `runtimeRls.http`, `stageC.*` |
| `school_role_assignments` | tenant | same | 004, 009 | same |
| `school_roles` | tenant | same | 004, 009 | same |
| `org_admin_school_delegations` | tenant | same | 005, 009 | same; FIG-1609 suites |
| `learners` | tenant, personal data | same | 006, 009 | `phase3.runtimeIsolation`, `vs1.learners` |
| `guardians` | tenant, personal data | same | 007, 009 | `phase3.runtimeIsolation`, `vs2.guardians` |
| `guardian_links` | tenant, personal data | same | 007, 009 | same |
| `school_profiles` | tenant | same | 016 | `phase3.runtimeIsolation` |
| `staff_members` | tenant, personal data | same | 018 | `phase3.runtimeIsolation` |
| `directory_documents` | tenant, personal data | same | 020 | `phase3.runtimeIsolation` |
| `staff_resource_grants` | tenant, access grants (guardian read/write, FIG-1614) | same | 025 | `phase3.runtimeIsolation`, `fig1614.guardianAccess` |
| `idempotency_keys` | tenant | tenant policy | 012 | `idempotency` |
| `school_memberships` | identity plane | tenant policy (active rows only) plus a SELECT-only self-read policy (`user_id = app_current_user_id()` while no tenant is set) so login and `/auth/me` work before a tenant is chosen | 009 | `runtimeRls.http`, `stageC.rlsOwnership` |
| `academic_years` | tenant | `tenant_id = app_current_tenant_id()` | 029 | `stage9.academics` |
| `academic_terms` | tenant | same | 029 | `stage9.academics` |
| `subjects` | tenant | same | 029 | `stage9.academics` |
| `classes` | tenant | same | 029 | `stage9.academics` |
| `class_memberships` | tenant | same | 029 | `stage9.academics` |
| `teaching_assignments` | tenant | same | 029 | `stage9.academics` |
| `timetable_slots` | tenant | same | 029 | `stage9.academics` |
| `assessments` | tenant | same | 030 | `stage9.academics` |
| `assessment_components` | tenant | same | 030 | `stage9.academics` |
| `mark_entries` | tenant | same | 030 | `stage9.academics` |
| `homework_items` | tenant | same | 030 | `stage9.academics` |
| `learning_materials` | tenant, metadata only | same | 030 | `stage9.academics` |
| `report_card_publications` | tenant | same | 030 | `stage9.academics` |
| `grading_schemes` | tenant | same | 030 | `stage9.academics` |
| `curriculum_provenance` | tenant (platform rows have a null tenant and are invisible to the runtime role) | same | 031 | `stage9.academics` |
| `learning_areas` | tenant | same | 031 | `stage9.academics` |
| `strands` | tenant | same | 031 | `stage9.academics` |
| `sub_strands` | tenant | same | 031 | `stage9.academics` |
| `learning_outcomes` | tenant | same | 031 | `stage9.academics` |
| `rubric_descriptor_configs` | tenant | same | 031 | `stage9.academics` |
| `cbe_assessments` | tenant | same | 031 | `stage9.academics` |
| `cbe_results` | tenant | same | 031 | `stage9.academics` |
| `evidence_assets` | tenant, metadata only | same | 031 | `stage9.academics` |
| `learner_competency_ratings` | tenant | `tenant_id = app_current_tenant_id()` | 079 | `stage9.academics` |
| `learner_competency_rating_revisions` | tenant | `tenant_id = app_current_tenant_id()` | 081 | `stage9.academics` |
| `vehicle_locations` | tenant | `tenant_id = app_current_tenant_id()` | 082 | `stage13.transport` |
| `attendance_coverage` | tenant | `tenant_id = app_current_tenant_id()` | 083 | `stage10.attendance` |
| `timetable_publications` | tenant | `tenant_id = app_current_tenant_id()` | 084 | `stage9.academics` |
| `mfa_factors` | user | `user_id = app_current_user_id()` | 085 | `auth.mfa` |
| `mfa_recovery_codes` | user | `user_id = app_current_user_id()` | 085 | `auth.mfa` |
| `curriculum_reference_entries` | platform + optional school rows (`tenant_id` nullable); `figbloom_app` SELECT-only via `curriculum_reference_entries_read`; migrator/owner writes | `tenant_id IS NULL OR tenant_id = app_current_tenant_id()` | 079 | `stage910.rlsCatalogue` / FIG-1605 |
| `he_courses` | tenant | same | 032 | `stage9.academics` |
| `he_sections` | tenant (`SELECT, INSERT` + column-level `UPDATE (instructor_staff_id)`; the instructor is a staff record of the same school by a composite foreign key) | same | 032, 107 | `stage9.academics`, `he.sectionInstructor` |
| `he_enrolments` | tenant | same | 032 | `stage9.academics` |
| `he_grades` | tenant | same | 032 | `stage9.academics` |
| `online_exam_papers` | tenant | same | 032 | `stage9.academics` |
| `online_exam_attempts` | tenant | same | 032 | `stage9.academics` |
| `attempt_marks` | tenant | same | 032 | `stage9.academics` |
| `attendance_settings` | tenant | same | 033 | `stage10.attendance` |
| `attendance` | tenant | same | 033 | `stage10.attendance` |
| `attendance_afternoon` | tenant | same | 033 | `stage10.attendance` |
| `early_sign_outs` | tenant | same | 033 | `stage10.attendance` |
| `early_sign_out_collectors` | tenant, collector PII | same | 033 | `stage10.attendance` |
| `mark_corrections` | tenant, append-only (SELECT + INSERT) | same | 035 | `stage910.ownerDecisions` |
| `cbe_result_revisions` | tenant, append-only (SELECT + INSERT) | same | 035 | `stage910.ownerDecisions` |
| `he_grade_revisions` | tenant, append-only (SELECT + INSERT) | same | 035 | `stage910.ownerDecisions` |
| `jobs` | tenant (`figbloom_app`: enqueue/read; `figbloom_worker`: SELECT only — all lifecycle updates go through `jobs_claim`, `jobs_complete`, `jobs_retry`, `jobs_dead`, `jobs_extend_lease` DEFINERs per 061) | `jobs_worker` mirrors the tenant predicate | 036, 061 | `stage11.finance`, `stage11.f8.settlementAuthority` |
| `finance_fee_items` | tenant | same (+ worker read) | 037 | `stage11.finance` |
| `finance_invoices` | tenant; money columns derived by trigger, not writable | same (+ worker read) | 037 | `stage11.finance` |
| `finance_invoice_lines` | tenant, append-only | same (+ worker read) | 037 | `stage11.finance` |
| `finance_charges` | tenant; void-only, never deleted | same (+ worker read) | 037 | `stage11.finance` |
| `finance_invoice_adjustments` | tenant, append-only | same (+ worker read) | 037 | `stage11.finance` |
| `finance_payments` | tenant; settled payments immutable | same (+ worker settles pending prompts) | 037 | `stage11.finance` |
| `finance_mpesa_events` | tenant, append-only provider log (masked phone) | same (+ worker insert) | 038 | `stage11.finance` |
| `finance_mpesa_unmatched_callbacks` | none: operator-only quarantine, no runtime privilege; written through a SECURITY DEFINER function | owner policy only | 038 | `stage910.rlsCatalogue` |
| `finance_payment_proofs` | tenant; reviewed proofs final, never deleted; file metadata only | same (+ worker read) | 038 | `stage11.finance` |
| `finance_reconciliation_runs` | tenant, append-only | same | 038 | `stage11.finance` |
| `finance_reconciliation_findings` | tenant; resolve-once | same | 038 | `stage11.finance` |
| `finance_ai_helper_settings` | tenant; billing held off by CHECK | same | 039 | `stage11.finance` |
| `finance_ai_helper_optins` | tenant | same | 039 | `stage11.finance` |
| `finance_ai_helper_optin_log` | tenant, append-only | same | 039 | `stage11.finance` |
| `communications_announcements` | tenant | same | 048 | `stage12.announcements` |
| `communications_announcement_reads` | tenant + user-scoped (`AS RESTRICTIVE` `user_id = app_current_user_id()` + audience check) | tenant + restrictive own-user policy | 048, 063 | `stage12.announcements`, `stage12.adversarial` |
| `communications_announcement_deliveries` | tenant | same (+ worker insert/select) | 048 | `stage12.announcements` |
| `notification_preferences` | user-scoped (`user_id = app_current_user_id()`) | own-row | 050 | `stage12.visitsPrefs` |
| `device_tokens` | user-scoped (`user_id = app_current_user_id()`) | own-row | 050 | `stage12.visitsPrefs` |
| `gate_visits` | tenant (operational status/timestamp column-scoped `UPDATE`) | same | 051, 063 | `stage12.visitsPrefs`, `stage12.adversarial` |
| `medical_settings` | tenant | same | 052 | `stage12.sickBay` |
| `sick_bay_visits` | tenant (a discharged visit needs a fresh `correction_reason` in every correcting statement; the guard consumes it into the corrections history and clears the column) | same | 052, 063, 066 | `stage12.sickBay`, `postAudit.boundaries` |
| `sick_bay_visit_corrections` | tenant `SELECT` only for the app; append-only (written by the definer guard with `corrected_by = app_current_user_id()`) | tenant | 066 | `postAudit.boundaries` |
| `medical_notices` | tenant + `AS RESTRICTIVE`: guardian `SELECT`/`UPDATE (read_at)` only their own (`guardian_user_id = app_current_user_id()`); `INSERT` only by a staff member of the tenant for a parent member of the tenant | tenant + restrictive guardian/staff policies | 052, 063, 066 | `stage12.sickBay`, `postAudit.boundaries` |
| `conversations` | tenant + user-scoped (`AS RESTRICTIVE` `user_a_id = app_current_user_id() OR user_b_id = app_current_user_id()`) | tenant + restrictive participant policy | 053, 063 | `stage12.chat`, `stage12.adversarial` |
| `conversation_members` | tenant + user-scoped (`AS RESTRICTIVE` participant check via `conversations`) | tenant + restrictive participant policy | 053, 063 | `stage12.chat`, `stage12.adversarial` |
| `chat_messages` | tenant + user-scoped (`AS RESTRICTIVE` participant `SELECT`, `sender_id = app_current_user_id()` `INSERT`) | tenant + restrictive participant/sender policy | 053, 063 | `stage12.chat`, `stage12.adversarial` |
| `inventory_items` | tenant | same | 054, 064 | `stage13.inventory`, `stage13.adversarial` |
| `inventory_issues` | tenant | same | 054, 064 | `stage13.inventory`, `stage13.adversarial` |
| `behaviour_settings` | tenant; the app may `SELECT`, `INSERT` and `UPDATE` the setting columns, never `DELETE` (`BEHAVIOUR.md`) | same | 118 | `behaviour` |
| `behaviour_categories` | tenant; `UPDATE` only of name, points, severity, order and `archived_at`: a category is archived, never deleted. Same-school entries through the composite key `(category_id, tenant_id)` | same | 118 | `behaviour` |
| `behaviour_entries` | tenant; `SELECT`, `INSERT`, and `UPDATE` of the void and incident columns only. `behaviour_entries_guard` (invoker trigger) refuses every other change, so an entry is only ever voided or followed up; no `DELETE`. Same-school learner, category, class and subject through composite keys | same | 118 | `behaviour` |
| `behaviour_staff_notes` | tenant; `SELECT` and `INSERT` only (a staff-only note never changes). Same-school entry through `(entry_id, tenant_id)` | same | 118 | `behaviour` |
| `inventory_movements` | tenant; `SELECT` and `INSERT` only for the app (a stock movement is never rewritten or removed; the `inventory_movements_apply` trigger refuses any `UPDATE`, the owner's too). Same-school item through the composite key `(item_id, tenant_id)` (`INVENTORY-STOCK.md`) | same | 115 | `inventory.stock` |
| `leave_requests` | tenant | same | 055, 064 | `stage13.leave`, `stage13.adversarial` |
| `activities` | tenant | same | 056 | `stage13.activities` |
| `activity_patrons` | tenant | same | 056 | `stage13.activities` |
| `activity_members` | tenant | same | 056 | `stage13.activities` |
| `vehicles` | tenant | same | 057 | `stage13.transport` |
| `transport_routes` | tenant | same | 057 | `stage13.transport` |
| `route_stops` | tenant | same | 057, 064 | `stage13.transport`, `stage13.adversarial` |
| `vehicle_assignments` | tenant | same | 057 | `stage13.transport` |
| `learner_transport` | tenant | same | 057, 064 | `stage13.transport`, `stage13.adversarial` |
| `trips` | tenant | same | 057, 064 | `stage13.transport`, `stage13.adversarial` |
| `trip_events` | tenant (append-only: `SELECT, INSERT` only) | same | 086 | `transport.operations` |
| `transport_notifications` | tenant + user-scoped (`AS RESTRICTIVE` recipient `SELECT`/`UPDATE (in_app_read_at)`; rows inserted only by a definer function) | tenant + restrictive recipient policy | 086 | `transport.operations` |
| `notification_outbox` | tenant (`SELECT, INSERT` for app; worker updates status/attempts) | tenant + worker | 089 | `notifications.engine` |
| `notifications` | tenant + user-scoped (`AS RESTRICTIVE` `recipient_user_id = app_current_user_id()`; `SELECT` + `UPDATE (read_at)` for app; worker inserts) | tenant + restrictive own-recipient + worker | 089 | `notifications.engine` |
| `notification_delivery_attempts` | tenant (`SELECT` for app; `SELECT, INSERT` for worker) | tenant + worker | 089 | `notifications.engine` |
| `storage_objects` | tenant (server-generated key trigger; immutable identity; worker cleans abandoned uploads) | tenant + worker | 090 | `storage.s3` |
| `export_jobs` | tenant (`SELECT, INSERT` for app; worker updates status/artifact) | tenant + worker | 091 | `exports.ooxml` |
| `learner_health_profiles` | tenant (restricted to `resource.medication.read/write`) | same | 092 | `health.medication` |
| `medication_authorizations` | tenant (trigger enforces explicit guardian consent before approval) | same | 092 | `health.medication` |
| `medication_schedules` | tenant (trigger enforces approved + consented authorization & active learner) | same | 092 | `health.medication` |
| `medication_administration_records` | tenant (append-only MAR; `SELECT, INSERT` only; unique per schedule+slot) | same | 092 | `health.medication` |
| `medication_administration_corrections` | tenant (append-only auditable MAR corrections; `SELECT, INSERT` only) | same | 092 | `health.medication` |
| `medication_incidents` | tenant (incident acknowledgement and resolution) | same | 092 | `health.medication` |
| `curriculum_import_batches` | tenant (import batch provenance and validation error reports) | same | 093 | `curriculum.catalogue` |
| `transport_incidents` | tenant (incident acknowledge/escalate/resolve lifecycle) | same | 094 | `stage78.transportAndBloom` |
| `import_batches` | tenant (`UPDATE (status, applied_at, preview_json)` for post-apply PII redaction) | same | 059, 062 | `stage16.importLearners`, `stage16.importLearners.adversarial` |
| `account_tokens` | **owner-only** (no runtime privilege; reached only through the `account_*` SECURITY DEFINER functions; stores token SHA-256 only) | same | 072 | `accounts.lifecycle` |
| `worker_heartbeats` | **owner-only** (written by `worker_heartbeat()`; read by `finance_ops_snapshot()`) | same | 071 | `finance.reconciliationCases` |
| `guardian_invitations` | **owner-only** (token hash only; reached only through the `guardian_*` SECURITY DEFINER functions) | same | 073 | `guardian.invitations` |
| `guardian_accounts` | **owner-only** (live guardian-record to login links; own links via `guardian_my_links()`; a parent's children in the current school via `family_my_children()`, 099) | same | 073 | `guardian.invitations`, `family.reads` |
| `learner_accounts` | **owner-only** (live login-to-learner links; the caller's own learner via `student_my_learner()`; made, reset, revoked and read by the school office only through the `student_account_*` SECURITY DEFINER functions) | same | 110 | `student.accounts` |
| `finance_unmatched_cases` | **owner-only** (platform operators reach it only through the `finance_unmatched_*` SECURITY DEFINER functions; no school owns an unmatched callback) | same | 074 | `finance.unmatchedCallbacks` |
| `finance_unmatched_case_notes` | **owner-only** (append-only operator notes) | same | 074 | `finance.unmatchedCallbacks` |
| `plan_pricing` | **owner-only** (Figbloom plan prices; read and written only through `platform_billing_*` SECURITY DEFINER functions) | same | 122 | `platform.billing` |
| `platform_subscriptions` | **owner-only** (school subscription terms; read and written only through `platform_billing_*` SECURITY DEFINER functions) | same | 122 | `platform.billing` |
| `finance_bank_statements` | tenant (`SELECT, INSERT` + column-level `UPDATE (matched_count, unmatched_count, status)`) | same | 097 | `bankReconciliation.unit` |
| `finance_bank_statement_lines` | tenant (`SELECT, INSERT` + column-level `UPDATE (match_status, matched_payment_id, matched_invoice_id, matched_by, matched_at, match_note)`) | same | 097 | `bankReconciliation.unit` |
| `teacher_reports` | tenant (`SELECT, INSERT` + column-level `UPDATE` on editable/review fields) | same | 098 | `teacherReports.unit` |
| `platform_school_links` | tenant; `SELECT` plus column-level `UPDATE (hr_enabled, hr_reason, hr_checked_at)` for the app (117: the HR & Payroll hand-off records the platform's last answer about HR for its own school); an operator adds, removes and re-points rows (and sets `platform_tenant_id`) as the migrator | same | 108, 117 | `myHr`, `hrHandoff` |

Not in this table on purpose: `security_audit_events` carries `tenant_id` for attribution but is an
append-only log; the runtime role holds `INSERT` only (asserted in `phase3.runtimeIsolation`). Identity-plane
tables (`users`, `sessions`, organisation and platform tables) are application-filtered by design
(`TENANT-ISOLATION.md`, decision D-3) and reached through narrow `SECURITY DEFINER` functions where they
hold secrets.

Teacher reads (migration 103, `TEACHER-READS.md`) add no table, policy or grant: `/me/teaching/*`, the widened
academic-year and term reads and the chat names read `classes`, `class_memberships`, `learners`, `staff_members`,
`teaching_assignments`, `academic_years`, `academic_terms` and `school_memberships` under the policies above, plus the
granted `users` columns (`full_name`, `status`). The per-class filter is application code (`teachingClassIds`).

Teacher reads part 2 (`TEACHER-READS.md`, no migration) read `homework_items`, `learning_materials` and `online_exam_papers`
for the classes the caller teaches, and `inventory_issues` joined to `inventory_items` for the caller's own open issues
(`GET /me/inventory/issues`), under the same policies; nothing is added or widened.

The school audit log (migration 106, `SCHOOL-AUDIT.md`) adds no table, policy or grant. `security_audit_events` keeps no
`SELECT` grant for the runtime role; the one read is the `SECURITY DEFINER` function `school_audit_events`, which takes the school
from `app_current_tenant_id()` and returns only business events, never the `detail` or `ip` columns.

Teacher reads part 3 (migration 107, `TEACHER-READS.md`) adds one nullable column, `he_sections.instructor_staff_id`, with the
foreign key `(instructor_staff_id, tenant_id)` to `staff_members (id, tenant_id)` (`ON DELETE RESTRICT`) and a column-level
`UPDATE` grant to `figbloom_app` on that column only. No table, policy or definer function is added. `GET /me/teaching/he-sections`
and its `/enrolments` roster read `he_sections`, `he_courses`, `academic_terms`, `he_enrolments`, `learners` and `staff_members`
under the policies above; "the caller is the instructor" is the join to the caller's own active, linked staff record.

My HR (`MY-HR.md`, migration 108) adds the one table above and no function or definer. `/me/hr/*` read it under the tenant policy; every call to Figbloom HR happens after that transaction has committed.

The HR & Payroll hand-off (`HR-HANDOFF.md`, slice H1, migration 117) adds no table and no policy. It adds the nullable column
`platform_school_links.platform_tenant_id` (operator-written) and the column-level `UPDATE` grant above; the update runs under
the same tenant policy, so a school can only record an answer about itself. It adds `tenants.hr_requested_at` and
`hr_requested_by` (`tenants` is an identity table, still `SELECT`-only for the runtime role); their one write path is the
`SECURITY DEFINER` function `hr_record_request()`, which takes the school and the person from `app_current_tenant_id()` and
`app_current_user_id()`. Every call to the platform happens between two short tenant transactions, with no connection held.

## Updating this file

Add the row in the same commit as the migration that creates the table. The test above fails otherwise.
