import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { createTestApp } from "./support.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>>;

const MIGRATIONS = join(process.cwd(), "migrations");

/** The pre-fix text of one function, taken from the historical migration file, not retyped. */
export function historicalFunction(file: string, name: string): string {
  const text = readFileSync(join(MIGRATIONS, file), "utf8");
  const m = new RegExp(`CREATE OR REPLACE FUNCTION ${name}\\([\\s\\S]*?\\n\\$\\$;`).exec(text);
  if (!m) throw new Error(`function ${name} not found in ${file}`);
  return m[0];
}

interface FnRow {
  signature: string;
  owner: string;
  secdef: boolean;
  config: string[] | null;
  grantees: string[];
}

/**
 * Stage D inventory. Read from the LIVE catalogue of a freshly migrated database,
 * not from the migration files. Extension-owned functions (pgcrypto, installed by
 * the platform image) are not ours and are excluded by pg_depend.
 *
 * Completeness: a function added by a later migration that is not listed here
 * fails this test, so a new definer (or any new function) cannot arrive without
 * a reviewer deciding its owner, search_path and EXECUTE grants.
 */
const EXPECTED: Record<string, { secdef: boolean; grantees: string[]; why: string }> = {
  // Migration 078 (residual closure)
  "worker_housekeeping(text)": { secdef: true, grantees: ["figbloom_worker"], why: "worker-only bounded retention cleanup; never touches money, reconciliation, audit or job rows" },
  // Migration 086: transport operations. Guard triggers are invokers; the two functions below are narrow definers.
  "trips_terminal_guard()": { secdef: false, grantees: [], why: "trigger; a completed or cancelled trip is final and its route is frozen once boarding events exist" },
  "trip_events_guard()": { secdef: false, grantees: [], why: "trigger; learner on route, boarded-before-dropped-off, exclusive no-show, stop on route, trip active" },
  "transport_my_children()": { secdef: true, grantees: ["figbloom_app"], why: "guardian_accounts is owner-only: resolves only the calling guardian account's linked, active learners in the current tenant" },
  // Migration 099: family reads (docs/FAMILY-READS.md)
  "family_my_children()": { secdef: true, grantees: ["figbloom_app"], why: "guardian_accounts is owner-only: the calling account's children in the current school (live link, active account, parent membership, active guardian record, live relationship, active learner); no argument, so no other account can be asked about" },
  // Migration 110: student accounts (docs/STUDENT-ACCOUNTS.md)
  "student_my_learner()": { secdef: true, grantees: ["figbloom_app"], why: "learner_accounts is owner-only: the calling account's own learner in the current school (live link, active account, student membership, active learner); no argument, so no other account can be asked about" },
  "student_account_actor_may_manage(uuid)": { secdef: true, grantees: [], why: "internal: is the GUC actor the school office of the tenant in context (super administrator, school administrator, or teacher/staff holding the People area)" },
  "student_account_create(uuid,uuid,text)": { secdef: true, grantees: ["figbloom_app"], why: "the school office makes a learner's login (Argon2id hash from the API, must_change_password, ST- number under the per-school login-id lock, one live login per learner); audited" },
  "student_account_reset_password(uuid,uuid,text)": { secdef: true, grantees: ["figbloom_app"], why: "the school office sets a new one-time password hash on a live learner login, forces a change and ends every session; audited" },
  "student_account_revoke(uuid,uuid,text)": { secdef: true, grantees: ["figbloom_app"], why: "the school office revokes a learner login (final): link closed, student membership archived, sessions ended; audited" },
  "student_account_status(uuid,uuid)": { secdef: true, grantees: ["figbloom_app"], why: "the school office reads whether a learner has a login (login id, forced-change flag, last sign-in); no password material" },
  "learner_accounts_on_membership_archive()": { secdef: true, grantees: [], why: "trigger; archiving a membership revokes the person's learner login link" },
  // Migration 105: org console (docs/ORG-CONSOLE.md)
  "org_my_audit_events(uuid,timestamp with time zone,uuid,integer)": { secdef: true, grantees: ["figbloom_app"], why: "security_audit_events has no SELECT grant: the CALLER's own events (actor from app.user_id, no actor argument) about one organisation they administer (re-checked in the database: org_admin of an active organisation); no ip column; at most 201 rows" },
  // Migration 106: the school's audit log (docs/SCHOOL-AUDIT.md)
  "school_audit_events(text,timestamp with time zone,text,timestamp with time zone,uuid,integer)": { secdef: true, grantees: ["figbloom_app"], why: "security_audit_events has no SELECT grant: the business events of the school of the request (tenant from app.tenant_id, no tenant argument; refused without a school and an account); sign-in, session, two-step, refusal, read and unlisted events are never returned, nor the detail and ip columns; at most 201 rows" },
  "transport_fanout_notifications(uuid)": { secdef: true, grantees: ["figbloom_app"], why: "tenant-bound fan-out of a trip event to linked guardian accounts (deduplicated); guardian_accounts is owner-only" },
  "worker_prune_vehicle_locations(integer)": { secdef: true, grantees: ["figbloom_worker"], why: "worker-only bounded privacy retention cleanup for expired GPS locations" },
  "auth_mfa_state(uuid,uuid,text[])": { secdef: true, grantees: ["figbloom_app"], why: "identity-level MFA decision (required / assured / enrolled) for one session; the one enforcement query" },
  "mfa_clear_own_assurance()": { secdef: true, grantees: ["figbloom_app"], why: "drops MFA assurance on the caller's own sessions when the factor is disabled" },
  "mfa_admin_reset(uuid,text)": { secdef: true, grantees: ["figbloom_app"], why: "audited lost-device reset by an authorised administrator; never self, never a peer administrator" },
  "auth_stamp_session_mfa(uuid)": { secdef: true, grantees: ["figbloom_app"], why: "stamps sessions.mfa_verified_at for app_current_user_id() only after MFA verification" },
  // Migrations 089-094 (notifications, S3 storage, exports, medication, curriculum catalogue, transport incidents)
  "device_tokens_revoke(uuid,text)": { secdef: true, grantees: ["figbloom_app"], why: "revokes own device token (bound to app_current_user_id()) with audit" },
  "device_tokens_mark_invalid(uuid,text)": { secdef: true, grantees: ["figbloom_worker"], why: "worker-only auto-revocation of expired/unregistered push tokens" },
  "notification_worker_active_devices(uuid[])": { secdef: true, grantees: ["figbloom_worker"], why: "worker-only lookup of non-revoked device tokens for active members of app_current_tenant_id()" },
  "notification_worker_resolve_recipients(uuid[])": { secdef: true, grantees: ["figbloom_worker"], why: "worker-only tenant-bound recipient validation and preference lookup" },
  "storage_objects_before_insert()": { secdef: false, grantees: [], why: "trigger; generates server-owned tenant-prefixed object_key" },
  "storage_objects_before_update()": { secdef: false, grantees: [], why: "trigger; keeps storage object identity and key immutable and prevents un-deleting" },
  "worker_cleanup_abandoned_uploads(integer)": { secdef: true, grantees: ["figbloom_worker"], why: "worker-only bounded cleanup of abandoned pending uploads and expired artifacts" },
  "worker_expire_export_jobs(integer)": { secdef: true, grantees: ["figbloom_worker"], why: "worker-only bounded expiry of completed export jobs past retention" },
  "medication_learner_guardian_users(uuid)": { secdef: true, grantees: ["figbloom_app"], why: "resolves active linked guardian user_ids for a learner in app_current_tenant_id()" },
  "medication_authorizations_guard()": { secdef: false, grantees: [], why: "trigger; enforces explicit guardian consent before medication authorization approval" },
  "medication_mar_guard()": { secdef: false, grantees: [], why: "trigger (095); MAR slot, date range, schedule/learner consistency, approved+consented authorization for given doses" },
  "medication_authorizations_stop_schedules()": { secdef: false, grantees: [], why: "trigger (095); stops schedules when consent is revoked or approval is lost" },
  "medication_incidents_guard()": { secdef: false, grantees: [], why: "trigger (095); incident links must belong to the same learner" },
  "medication_schedules_guard()": { secdef: false, grantees: [], why: "trigger; enforces approved+consented authorization and active learner for schedules" },
  "curriculum_catalogue_import_entry(uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,date,text)": { secdef: true, grantees: ["figbloom_app"], why: "tenant-bound deterministic import into SELECT-only curriculum_reference_entries" },
  "curriculum_catalogue_transition(uuid,text,text)": { secdef: true, grantees: ["figbloom_app"], why: "audited review/verify/reject transition; platform rows restricted to super_admin" },
  "curriculum_catalogue_supersede(uuid,text,text,text,text)": { secdef: true, grantees: ["figbloom_app"], why: "versioned supersession preserving history; platform rows restricted to super_admin" },
  "transport_event_recipients(uuid)": { secdef: true, grantees: ["figbloom_app"], why: "resolves tenant-bound guardian recipients for a transport event to bridge into central outbox" },
  "transport_trip_guardian_users(uuid)": { secdef: true, grantees: ["figbloom_app"], why: "resolves tenant-bound guardian user_ids on a trip route for explicit admin incident escalation notices" },
  "finance_assert_administer_actor(uuid)": { secdef: true, grantees: ["figbloom_app"], why: "M-9: re-verifies the acting administrator's live authority with row locks inside the settlement transaction" },
  // Migrations 068-072 (acceptance programme)
  "auth_session_recent(uuid,integer)": { secdef: true, grantees: ["figbloom_app"], why: "is the caller's session recently authenticated (own user only)" },
  "auth_mark_reauthenticated(uuid)": { secdef: true, grantees: ["figbloom_app"], why: "stamp the caller's own session after a verified password (audited)" },
  "finance_unmatched_evidence_key(text,integer,bigint,text)": { secdef: false, grantees: [], why: "pure fingerprint of provider evidence fields" },
  "finance_unmatched_require_operator()": { secdef: true, grantees: [], why: "internal: refuses anyone who is not a platform operator" },
  "finance_unmatched_severity(uuid)": { secdef: true, grantees: [], why: "internal: derived severity (provider success = high)" },
  "finance_unmatched_try_match(uuid,uuid,boolean)": { secdef: true, grantees: [], why: "internal: idempotent evidence handover to a matching payment; never settles" },
  "finance_ops_snapshot_base()": { secdef: true, grantees: [], why: "internal: worker/queue/reconciliation counters" },
  "finance_unmatched_list(text,uuid,boolean,integer,text,integer)": { secdef: true, grantees: ["figbloom_app"], why: "operator listing of unmatched-callback cases" },
  "finance_unmatched_get(uuid)": { secdef: true, grantees: ["figbloom_app"], why: "operator inspection: provider fields, masked phone, notes" },
  "finance_unmatched_assign(uuid,uuid)": { secdef: true, grantees: ["figbloom_app"], why: "operator ownership; owner must be an active operator" },
  "finance_unmatched_add_note(uuid,text)": { secdef: true, grantees: ["figbloom_app"], why: "append-only operator note" },
  "finance_unmatched_retry(uuid)": { secdef: true, grantees: ["figbloom_app"], why: "operator retry of matching" },
  "finance_unmatched_escalate(uuid,text)": { secdef: true, grantees: ["figbloom_app"], why: "operator escalation with reason" },
  "finance_unmatched_resolve(uuid,text,text,text)": { secdef: true, grantees: ["figbloom_app"], why: "operator resolution: reason and evidence mandatory; moves no money" },
  "finance_unmatched_reopen(uuid,text)": { secdef: true, grantees: ["figbloom_app"], why: "operator reopen with reason" },
  "finance_unmatched_sweep(text)": { secdef: true, grantees: ["figbloom_worker"], why: "worker-only re-evaluation and escalation of open cases" },
  "guardian_accept_invitation(text,text,boolean,text,text,uuid)": { secdef: true, grantees: ["figbloom_app"], why: "accept: token + contact echo + explicit confirmation; one live login per guardian record" },
  "guardian_accounts_on_membership_archive()": { secdef: true, grantees: [], why: "trigger; archiving a membership revokes the person's guardian links" },
  "guardian_actor_may_manage(uuid)": { secdef: true, grantees: ["figbloom_app"], why: "is the GUC actor a school administrator of the tenant in context (or super administrator)" },
  "guardian_create_invitation(uuid,uuid,uuid,text,text,timestamp with time zone)": { secdef: true, grantees: ["figbloom_app"], why: "issue an invitation bound to tenant, guardian and live learner relationship" },
  "guardian_list_invitations(uuid,text,integer)": { secdef: true, grantees: ["figbloom_app"], why: "staff listing, contact masked, no token material" },
  "guardian_my_links()": { secdef: true, grantees: ["figbloom_app"], why: "the signed-in person's own live links" },
  "guardian_preview_invitation(text)": { secdef: true, grantees: ["figbloom_app"], why: "public preview of a live token: school name and relationship only" },
  "guardian_record_delivery(uuid,uuid,text)": { secdef: true, grantees: ["figbloom_app"], why: "delivery outcome from the provider boundary; never accepts an invitation" },
  "guardian_revoke_account_link(uuid,uuid,text)": { secdef: true, grantees: ["figbloom_app"], why: "final, audited revocation of a live link" },
  "guardian_revoke_invitation(uuid,uuid)": { secdef: true, grantees: ["figbloom_app"], why: "revoke an open invitation" },
  "account_accept_invitation(text,text,text,uuid)": { secdef: true, grantees: ["figbloom_app"], why: "accept an invitation; token hash lookup, single use; links the one unlinked active staff record of that school with the invited e-mail (104)" },
  "account_actor_is_super()": { secdef: true, grantees: ["figbloom_app"], why: "is the GUC actor a super administrator" },
  "account_admin_issue_reset(uuid,uuid,text,timestamp with time zone)": { secdef: true, grantees: ["figbloom_app"], why: "administrator-issued password reset token" },
  "account_complete_password_reset(text,text)": { secdef: true, grantees: ["figbloom_app"], why: "consume reset token, set Argon2id hash, revoke sessions" },
  "account_create_invitation(uuid,text,text,text,text,timestamp with time zone)": { secdef: true, grantees: ["figbloom_app"], why: "issue an invitation token (hash only)" },
  "account_deactivate_membership(uuid,uuid)": { secdef: true, grantees: ["figbloom_app"], why: "archive membership and revoke sessions" },
  "account_request_password_reset(text,text,timestamp with time zone)": { secdef: true, grantees: ["figbloom_app"], why: "enumeration-safe reset request" },
  "account_revoke_invitation(uuid,uuid)": { secdef: true, grantees: ["figbloom_app"], why: "revoke an open invitation" },
  "auth_hash_format_ok(text)": { secdef: false, grantees: ["figbloom_app"], why: "pure format check for stored password hashes" },
  "auth_rehash_password(uuid,text,text)": { secdef: true, grantees: ["figbloom_app"], why: "compare-and-swap Argon2id upgrade, no downgrade" },
  "auth_session_idle_seconds(uuid)": { secdef: true, grantees: ["figbloom_app"], why: "idle timeout by role (15/30 minutes)" },
  "finance_ops_snapshot()": { secdef: true, grantees: ["figbloom_app"], why: "platform worker/queue/case counters, no PII" },
  "finance_reconciliation_sweep(text,integer)": { secdef: true, grantees: ["figbloom_worker"], why: "worker-only case raise/re-raise/escalate" },
  "platform_provision_school(uuid,text,text,text,text,text,text,timestamp with time zone)": { secdef: true, grantees: ["figbloom_app"], why: "super-administrator school provisioning" },
  "worker_heartbeat(text,text)": { secdef: true, grantees: ["figbloom_worker"], why: "worker liveness signal" },
  "app_current_tenant_id()": { secdef: false, grantees: ["figbloom_app", "figbloom_worker"], why: "RLS helper evaluated by tenant policies (API and worker)" },
  "app_current_user_id()": { secdef: false, grantees: ["figbloom_app"], why: "RLS helper evaluated by the self-read policy" },
  "consume_rate_token(text,numeric,numeric,numeric,integer)": { secdef: false, grantees: ["figbloom_app"], why: "called by the API for the PG token bucket" },
  "prune_rate_buckets(interval)": { secdef: false, grantees: [], why: "housekeeping; not an API call" },
  "guardian_links_active_learner_guard()": { secdef: true, grantees: [], why: "trigger; FOR SHARE on learners via SECURITY DEFINER (race-safe archived-learner guard)" },
  "directory_update_tenant_identity(text,text)": { secdef: true, grantees: ["figbloom_app"], why: "audited school name/timezone update; tenants remain SELECT-only for figbloom_app" },
  // Migrations 021-022 (Phase 3 remediation): invoker-rights trigger functions. NOT definers: they read
  // only through the caller's own tenant policy, so they widen nothing.
  "directory_documents_before_insert()": { secdef: false, grantees: [], why: "trigger; server-generated storage key + same-tenant subject guard (F-04)" },
  "school_profiles_before_insert()": { secdef: false, grantees: [], why: "trigger; discards any client-supplied logo_object_key, the INSERT half of P3-AUDIT-005 (audit A-04)" },
  "directory_documents_before_update()": { secdef: false, grantees: [], why: "trigger; document identity/storage fields immutable, archive one-way (F-04)" },
  "staff_members_check_user_link()": { secdef: false, grantees: [], why: "trigger; a staff record may only link a user with an active membership in the same school (S-01)" },
  "school_memberships_on_archive()": { secdef: true, grantees: [], why: "trigger; clears grants and writes the audit row when a membership is archived" },
  "security_audit_events_guard()": { secdef: true, grantees: [], why: "trigger; append-only guard for the audit table" },
  "schema_migration_checksum_audit_append_only()": { secdef: false, grantees: [], why: "runner-created trigger (ensureBootstrap), not a migration object" },
  // Migration 011: the only way the runtime role can reach users.password_hash (exact key, one account).
  // Migration 025 (FIG-1609 hardening, FIG-1614 Option D).
  "is_delegable_permission(text)": { secdef: false, grantees: ["figbloom_app"], why: "pure allowlist predicate; no table access" },
  "org_delegation_guard()": { secdef: true, grantees: [], why: "trigger; allowlist + FOR SHARE on tenants/users so a grant cannot race a suspension or a disabled recipient" },
  "staff_resource_grants_guard()": { secdef: true, grantees: [], why: "trigger; grantee must be an active teacher/staff member of the school (FOR SHARE)" },
  "staff_resource_grants_on_membership_change()": { secdef: true, grantees: [], why: "trigger; archive, role change or delete of a membership revokes its guardian grants so a restore cannot revive them" },
  // Migration 026 (delegation lifecycle): invalidation on user, membership and organization changes.
  "invalidate_org_delegations(uuid,uuid,text)": { secdef: true, grantees: [], why: "internal helper; revokes active delegations (final, audited) when the authorization relationship changes" },
  "invalidate_guardian_grants(uuid,uuid,text)": { secdef: true, grantees: [], why: "internal helper; revokes active explicit guardian grants (final, audited)" },
  "users_status_invalidates_grants()": { secdef: true, grantees: [], why: "trigger; a disabled user loses delegations and guardian grants for good" },
  "org_membership_invalidates_delegations()": { secdef: true, grantees: [], why: "trigger; removing, moving or changing an organization membership revokes its delegations" },
  "organizations_status_invalidates_delegations()": { secdef: true, grantees: [], why: "trigger; an organization leaving 'active' revokes every delegation in it" },
  "org_delegation_immutable_guard()": { secdef: false, grantees: [], why: "trigger; delegation identity/code/grantor immutable, revocation final (review M-1)" },
  "staff_resource_grants_immutable_guard()": { secdef: false, grantees: [], why: "trigger; grant identity/code/grantor immutable, revocation final (review M-1)" },
  "auth_credential_by_email(text)": { secdef: true, grantees: ["figbloom_app"], why: "login by e-mail; returns (user id, hash, status) for one e-mail" },
  "auth_credential_by_login_id(uuid,text)": { secdef: true, grantees: ["figbloom_app"], why: "login by login id; one account per (school, login id)" },
  "auth_password_credential(uuid)": { secdef: true, grantees: ["figbloom_app"], why: "password change; the caller's own user id" },
  // Migration 013 (WP-A1 review R-02, R-04).
  "auth_change_own_password(uuid,text,text,inet)": { secdef: true, grantees: ["figbloom_app"], why: "the only write path to users.password_hash; account derived from the session, compare-and-swap, audited" },
  "prune_idempotency_keys(interval,integer)": { secdef: false, grantees: [], why: "owner-run housekeeping; not an API call" },
  // Migration 014 (OD-1 / R-02 session mint containment).
  "auth_hmac_sha256_hex(bytea,bytea)": { secdef: false, grantees: [], why: "internal HMAC helper; not an API call" },
  "auth_hmac_hex_equals(text,text)": { secdef: false, grantees: [], why: "internal constant-time compare; not an API call" },
  "auth_active_session_hmac_secret()": { secdef: true, grantees: [], why: "reads owner-only secret; called only by other definers" },
  "auth_consume_session_proof(text,text,text,timestamp with time zone,text,interval)": {
    secdef: true,
    grantees: [],
    why: "proof verify + nonce consume; called only by other definers",
  },
  "auth_install_session_hmac_secret(text,text)": { secdef: true, grantees: [], why: "owner/migrator installs HMAC secret; never executable by figbloom_app" },
  // Migration 015 (provisioning safety, nonce housekeeping, tenant eligibility).
  "auth_session_hmac_matches(text,text)": { secdef: false, grantees: [], why: "internal verify against active keys; called only by definers" },
  "auth_rotate_session_hmac_secret(text,text)": { secdef: true, grantees: [], why: "owner-run rotation step 1 (adds a second active key)" },
  "auth_retire_session_hmac_secret(text)": { secdef: true, grantees: [], why: "owner-run rotation step 2 (retires a key; never the last one)" },
  "auth_session_hmac_status(text,text)": { secdef: true, grantees: ["figbloom_app"], why: "readiness self-test: ok / mismatch / no_secret; selftest payloads only, no key material" },
  "auth_purge_session_proof_nonces(integer)": { secdef: true, grantees: [], why: "owner-run bounded nonce housekeeping; not an API call" },
  "auth_session_tenant_eligible(uuid,uuid)": { secdef: false, grantees: [], why: "internal tenant eligibility rules; called only by auth_set_session_tenant" },
  "auth_mint_session(uuid,text,timestamp with time zone,uuid,uuid,text,inet,text,uuid,timestamp with time zone,text,text)": {
    secdef: true,
    grantees: ["figbloom_app"],
    why: "only INSERT path for sessions; HMAC proof required",
  },
  "auth_touch_session(text,double precision)": {
    secdef: true,
    grantees: ["figbloom_app"],
    why: "session validate + throttled last_seen write",
  },
  "auth_revoke_session(uuid,uuid,timestamp with time zone,text,text)": {
    secdef: true,
    grantees: ["figbloom_app"],
    why: "session revoke with HMAC proof",
  },
  "auth_revoke_all_user_sessions(uuid,uuid,uuid,timestamp with time zone,text,text)": {
    secdef: true,
    grantees: ["figbloom_app"],
    why: "bulk revoke with HMAC proof",
  },
  "auth_set_session_tenant(uuid,uuid,uuid,uuid,timestamp with time zone,text,text)": {
    secdef: true,
    grantees: ["figbloom_app"],
    why: "select-tenant write with HMAC proof",
  },
  // Migration 029: class membership year/learner guard. Trigger only.
  "class_memberships_integrity_guard()": {
    secdef: true,
    grantees: [],
    why: "trigger; class year and active-learner checks without widening the caller's grants",
  },
  // Migrations 030–031: storage keys for metadata-only rows. Invoker triggers.
  "learning_materials_before_insert()": {
    secdef: false,
    grantees: [],
    why: "trigger; discards a client storage key and forces metadata_only",
  },
  "evidence_assets_before_insert()": {
    secdef: false,
    grantees: [],
    why: "trigger; discards a client storage key and forces metadata_only",
  },
  // Migration 033: attendance register rules and the counting twin. Not definers.
  "attendance_afternoon_allowed()": {
    secdef: false,
    grantees: [],
    why: "trigger; refuses an afternoon insert while the school register is off (SQLSTATE 23514)",
  },
  "attendance_register_guard()": {
    secdef: false,
    grantees: [],
    why: "trigger; school-today and term window, newest marked_at wins, identical replay is a no-op",
  },
  "attendance_counted(uuid,uuid)": {
    secdef: false,
    grantees: ["figbloom_app"],
    why: "session/day counting twin; invoker so RLS still applies; live early sign-out drops afternoon absent/excused",
  },
  // Migration 034 (Stage 9/10 independent review): integrity triggers. Invokers, no grantees.
  "early_sign_outs_void_once()": {
    secdef: false,
    grantees: [],
    why: "trigger; an early sign-out goes live -> voided once, at the database clock (R10-3)",
  },
  "early_sign_out_collectors_guard()": {
    secdef: false,
    grantees: [],
    why: "trigger; collector details immutable, void reason set once and only on a voided sign-out (R10-3)",
  },
  "online_exam_attempts_forward_only()": {
    secdef: false,
    grantees: [],
    why: "trigger; a submitted attempt is final (A9-4)",
  },
  "mark_entries_version_step()": {
    secdef: false,
    grantees: [],
    why: "trigger; every mark UPDATE advances row_version by exactly one (A9-15)",
  },
  // Migration 035 (owner decisions): revision-gated changes, forward-only status, paged counting. Invokers.
  "mark_corrections_before_insert()": {
    secdef: false,
    grantees: [],
    why: "trigger; a mark correction must name the current score/grade and the next row_version (OD-1)",
  },
  "mark_entries_publication_lock()": {
    secdef: false,
    grantees: [],
    why: "trigger; a mark of a non-draft assessment changes only with its matching correction row (OD-1)",
  },
  "assessments_status_forward_only()": {
    secdef: false,
    grantees: [],
    why: "trigger; draft→published→closed only; published cannot return to draft; closed is final (OD-1 + migration 080)",
  },
  // Migration 079 (CBC engine): CBE assessment lifecycle forward-only. Invoker trigger.
  "cbe_assessments_status_forward_only()": {
    secdef: false,
    grantees: [],
    why: "trigger; CBE draft→published→closed only; closed cannot reopen; draft cannot skip to closed",
  },
  "cbe_result_revisions_before_insert()": {
    secdef: false,
    grantees: [],
    why: "trigger; a CBE revision must name the current result and the next row_version (OD-3)",
  },
  "cbe_results_revision_required()": {
    secdef: false,
    grantees: [],
    why: "trigger; a CBE result changes only with its matching revision row (OD-3)",
  },
  "cbe_results_first_version()": {
    secdef: false,
    grantees: [],
    why: "trigger; a new CBE result starts at row_version 1 (OD-3)",
  },
  "he_grade_revisions_before_insert()": {
    secdef: false,
    grantees: [],
    why: "trigger; an HE grade revision must name the current grade and the next row_version (OD-5)",
  },
  "he_grades_guard()": {
    secdef: false,
    grantees: [],
    why: "trigger; first grade only for an enrolled learner; later changes only with a revision row (OD-5)",
  },
  "attendance_counted_page(uuid,uuid,uuid,date,uuid,text,integer)": {
    secdef: false,
    grantees: ["figbloom_app"],
    why: "paged counting twin (OD-4); invoker so RLS still applies; same rules as attendance_counted",
  },
  // Migration 036 (job runtime, WORKER-ISOLATION-PROPOSAL.md).
  "jobs_identity_immutable()": { secdef: false, grantees: [], why: "trigger; a job's tenant, type, payload and key never change; a finished job is final" },
  "jobs_claim(text,integer,text[])": {
    secdef: true,
    grantees: ["figbloom_worker"],
    why: "the ONLY cross-tenant step of the worker: leases one due job (SKIP LOCKED, skips suspended schools), returns ids and no payload; not executable by the API role",
  },
  // Migration 061 (F8-A / M3-A worker lifecycle hardening).
  "jobs_load_leased(uuid,text,integer)": {
    secdef: true,
    grantees: ["figbloom_worker"],
    why: "N-2 (065): the worker cannot SELECT jobs.lease_token, so the leased job payload is read through this function, which demands the token",
  },
  "import_batches_expire_due(integer)": {
    secdef: true,
    grantees: ["figbloom_worker"],
    why: "N-8 (067): worker-only maintenance; redacts expired import previews one row at a time under SKIP LOCKED and audits each",
  },
  "jobs_assert_lease(uuid,text,integer)": {
    secdef: true,
    grantees: ["figbloom_worker"],
    why: "F8-A (061): locks the job row FOR UPDATE and proves the worker still holds an active, non-expired lease in the current tenant with matching fencing token",
  },
  "jobs_complete(uuid,text,integer)": {
    secdef: true,
    grantees: ["figbloom_worker"],
    why: "F8-A (061): transitions a currently held leased job to succeeded and writes job.succeeded; not executable by the API role",
  },
  "jobs_retry(uuid,text,integer,integer,text)": {
    secdef: true,
    grantees: ["figbloom_worker"],
    why: "F8-A (061): releases a currently held leased job back to queued with bounded backoff and writes job.retry_scheduled; not executable by the API role",
  },
  "jobs_dead(uuid,text,integer,text,text)": {
    secdef: true,
    grantees: ["figbloom_worker"],
    why: "F8-A (061): transitions a currently held leased job to dead and writes job.dead; not executable by the API role",
  },
  "jobs_extend_lease(uuid,text,integer,integer)": {
    secdef: true,
    grantees: ["figbloom_worker"],
    why: "M3-A (061): extends an active, non-expired worker lease by bounded seconds; not executable by the API role",
  },
  // Migrations 041-042 (remediation batch 1: worker conformance).
  "jobs_worker_transition_guard()": { secdef: false, grantees: [], why: "trigger; the worker role may only finish or release a job it has leased (no cancel, no fencing-token change)" },
  "security_audit_events_worker_scope()": { secdef: false, grantees: [], why: "trigger; the worker role may write only tenant-bound, system-attributed events of an allowlisted type, with database-assigned id and time" },
  "jobs_operator_cancel(uuid,uuid,text,inet)": {
    secdef: true,
    grantees: ["figbloom_app"],
    why: "the only way a queued settlement job is cancelled: tenant-scoped by the session, acting user must be the signed-in user, refused while the payment is pending, audited with the caller's IP; not executable by the worker role",
  },
  // Migration 045 (remediation batches 4-5).
  "finance_mpesa_quarantine_has_receipt(text,text)": {
    secdef: true,
    grantees: ["figbloom_app"],
    why: "answers only yes or no: does the owner-only unmatched-callback quarantine already hold this receipt for ANOTHER checkout id (an operator-typed receipt belonging to someone else's payment)",
  },
  "finance_worker_settle_payment(uuid,text,integer,uuid,text,text,text)": {
    secdef: true,
    grantees: ["figbloom_worker"],
    why: "F-8 (047): the only path by which the worker may change finance_payments status; lease-bound, tenant from the job row, success requires a stored authenticated callback receipt; not executable by the API role",
  },
  "finance_mpesa_events_source_guard()": { secdef: false, grantees: [], why: "trigger; the worker role may only record its own provider queries (never an authenticated callback or an operator act)" },
  // Migration 043 (remediation batch 2).
  "finance_payments_no_not_sent()": { secdef: false, grantees: [], why: "trigger; an unacknowledged prompt is never recorded as not sent (only the provider's own answer fails a prompt)" },
  // Migration 037 (finance core). All invoker functions: RLS applies.
  "finance_school_today(uuid)": { secdef: false, grantees: ["figbloom_app", "figbloom_worker"], why: "the school's local date for invoice status" },
  "finance_invoice_status(bigint,bigint,date,date)": { secdef: false, grantees: ["figbloom_app", "figbloom_worker"], why: "SQL twin of money.ts invoiceStatus (agreement tested)" },
  "finance_invoices_recompute()": { secdef: false, grantees: [], why: "trigger; derives an invoice's totals from lines, live charges, adjustments and successful payments" },
  "finance_touch_invoice()": { secdef: false, grantees: [], why: "trigger; a change to a source row recomputes its invoice" },
  "finance_invoice_lines_guard()": { secdef: false, grantees: [], why: "trigger; lines are fixed once an invoice has payments or is voided" },
  "finance_charges_guard()": { secdef: false, grantees: [], why: "trigger; void-only, never below what is paid; locks the invoice" },
  "finance_adjustments_guard()": { secdef: false, grantees: [], why: "trigger; recorded 'from' must be the current total; new total covers paid and charges" },
  "finance_payments_guard()": { secdef: false, grantees: [], why: "trigger; balance ceiling under the invoice lock, immutable once settled, single pending-to-final step" },
  "finance_fee_items_guard()": { secdef: false, grantees: [], why: "trigger; a fee item cannot move; archive is one-way" },
  // Migration 038 (M-Pesa, proofs, reconciliation).
  "finance_mpesa_tenant_for_checkout(text)": {
    secdef: true,
    grantees: ["figbloom_app"],
    why: "the callback's only cross-tenant step: maps a provider CheckoutRequestID to its school, returns a tenant id only, reachable after the callback secret is verified",
  },
  "finance_mpesa_record_unmatched(text,text,integer,bigint,text,text)": {
    secdef: true,
    grantees: ["figbloom_app"],
    why: "writes the operator-only quarantine of callbacks that match no prompt; no read path",
  },
  "finance_payment_proofs_guard()": { secdef: false, grantees: [], why: "trigger; proof starts pending, code appears in the message and is not already paid, reviewed proofs are final" },
  "finance_invoices_proof_void_guard()": { secdef: false, grantees: [], why: "trigger; an invoice with payment proofs cannot be voided" },
  "finance_payments_proof_guard()": { secdef: false, grantees: [], why: "trigger; a payment naming a proof must be for that proof's invoice and the proof must be pending" },
  "finance_reconciliation_findings_guard()": { secdef: false, grantees: [], why: "trigger; a finding is resolved once and never otherwise changes" },
  // Migration 048 (Stage 12 announcements).
  "communications_audience_reaches(uuid,jsonb,uuid)": {
    secdef: true,
    grantees: ["figbloom_app"],
    why: "audience membership for inbox visibility; reads school_memberships as owner with fixed search_path; class/form_level deferred until account linking",
  },
  "communications_announcements_guard()": {
    secdef: false,
    grantees: [],
    why: "trigger; identity immutable; published announcements are final",
  },
  // Migrations 050–051 (Stage 12 prefs, device tokens, gate visits).
  "device_tokens_register(uuid,text,text)": {
    secdef: true,
    grantees: ["figbloom_app"],
    why: "reclaims a globally unique device token for the signed-in user (app.user_id must match)",
  },
  "gate_visits_stamp()": {
    secdef: true,
    grantees: [],
    why: "trigger; stamps host/learner names, escalation and status timestamps without widening grants",
  },
  // Migration 052 (sick bay core).
  "medical_outcome_notifies(text,text)": {
    secdef: false,
    grantees: ["figbloom_app"],
    why: "pure SQL twin of notifiesGuardians(); no table access",
  },
  "sick_bay_visits_guard()": {
    secdef: true,
    grantees: [],
    why: "trigger (066/N-4): visit identity immutable; a discharged visit needs a fresh correction_reason in every statement, recorded in the append-only corrections table by this definer",
  },
  // Migration 053 (chat text).
  "may_talk(uuid,uuid,uuid)": {
    secdef: true,
    grantees: ["figbloom_app"],
    why: "pairing rule for chat/calls; staff↔staff and parent↔office now; parent↔child/teacher deferred",
  },
  "chat_pair_key(uuid,uuid)": {
    secdef: false,
    grantees: ["figbloom_app"],
    why: "deterministic conversation pair key",
  },
  // Migration 054 & 063 (inventory).
  "inventory_out_count(uuid)": {
    secdef: false,
    grantees: ["figbloom_app"],
    why: "SECURITY INVOKER (063 S13-11): counts open/lost/damaged issues for availability checks under RLS / trigger owner",
  },
  // Migration 063 (Stage 12 push preference eligibility count).
  "communications_announcement_push_eligible_count(uuid)": {
    secdef: true,
    grantees: ["figbloom_worker"],
    why: "S12-12 (063): worker-only count of active tenant members reached by an announcement who opted into general_notices",
  },
  "inventory_items_stamp()": {
    secdef: false,
    grantees: [],
    why: "trigger; trims fields and stamps updated_at",
  },
  "inventory_issues_guard()": {
    secdef: true,
    grantees: [],
    why: "trigger; availability under FOR UPDATE; closed issues final",
  },
  // Migration 055 (leave).
  "leave_requests_guard()": {
    secdef: false,
    grantees: [],
    why: "trigger; no self-review; reviewed leave final",
  },
  "leave_requests_no_overlap()": {
    secdef: true,
    grantees: [],
    why: "trigger; pending/approved leave ranges cannot overlap for one staff member",
  },
};

/** The only SECURITY DEFINER functions the runtime role may execute. */
const RUNTIME_EXECUTABLE_DEFINERS = [
  "finance_assert_administer_actor(uuid)",
  "auth_session_recent(uuid,integer)",
  "auth_mfa_state(uuid,uuid,text[])",
  "mfa_clear_own_assurance()",
  "mfa_admin_reset(uuid,text)",
  "auth_stamp_session_mfa(uuid)",
  "auth_mark_reauthenticated(uuid)",
  "finance_unmatched_list(text,uuid,boolean,integer,text,integer)",
  "finance_unmatched_get(uuid)",
  "finance_unmatched_assign(uuid,uuid)",
  "finance_unmatched_add_note(uuid,text)",
  "finance_unmatched_retry(uuid)",
  "finance_unmatched_escalate(uuid,text)",
  "finance_unmatched_resolve(uuid,text,text,text)",
  "finance_unmatched_reopen(uuid,text)",
  "guardian_accept_invitation(text,text,boolean,text,text,uuid)",
  "guardian_actor_may_manage(uuid)",
  "guardian_create_invitation(uuid,uuid,uuid,text,text,timestamp with time zone)",
  "guardian_list_invitations(uuid,text,integer)",
  "guardian_my_links()",
  "guardian_preview_invitation(text)",
  "guardian_record_delivery(uuid,uuid,text)",
  "guardian_revoke_account_link(uuid,uuid,text)",
  "guardian_revoke_invitation(uuid,uuid)",
  "account_accept_invitation(text,text,text,uuid)",
  "account_actor_is_super()",
  "account_admin_issue_reset(uuid,uuid,text,timestamp with time zone)",
  "account_complete_password_reset(text,text)",
  "account_create_invitation(uuid,text,text,text,text,timestamp with time zone)",
  "account_deactivate_membership(uuid,uuid)",
  "account_request_password_reset(text,text,timestamp with time zone)",
  "account_revoke_invitation(uuid,uuid)",
  "auth_rehash_password(uuid,text,text)",
  "auth_session_idle_seconds(uuid)",
  "finance_ops_snapshot()",
  "platform_provision_school(uuid,text,text,text,text,text,text,timestamp with time zone)",
  "transport_fanout_notifications(uuid)",
  "transport_my_children()",
  "family_my_children()",
  "student_my_learner()",
  "student_account_create(uuid,uuid,text)",
  "student_account_reset_password(uuid,uuid,text)",
  "student_account_revoke(uuid,uuid,text)",
  "student_account_status(uuid,uuid)",
  "org_my_audit_events(uuid,timestamp with time zone,uuid,integer)",
  "school_audit_events(text,timestamp with time zone,text,timestamp with time zone,uuid,integer)",
  "auth_credential_by_email(text)",
  "auth_credential_by_login_id(uuid,text)",
  "auth_password_credential(uuid)",
  "auth_change_own_password(uuid,text,text,inet)",
  "auth_mint_session(uuid,text,timestamp with time zone,uuid,uuid,text,inet,text,uuid,timestamp with time zone,text,text)",
  "auth_touch_session(text,double precision)",
  "auth_revoke_session(uuid,uuid,timestamp with time zone,text,text)",
  "auth_revoke_all_user_sessions(uuid,uuid,uuid,timestamp with time zone,text,text)",
  "auth_set_session_tenant(uuid,uuid,uuid,uuid,timestamp with time zone,text,text)",
  "auth_session_hmac_status(text,text)",
  "directory_update_tenant_identity(text,text)",
  "finance_mpesa_tenant_for_checkout(text)",
  "finance_mpesa_record_unmatched(text,text,integer,bigint,text,text)",
  "jobs_operator_cancel(uuid,uuid,text,inet)",
  "finance_mpesa_quarantine_has_receipt(text,text)",
  "communications_audience_reaches(uuid,jsonb,uuid)",
  "device_tokens_register(uuid,text,text)",
  "device_tokens_revoke(uuid,text)",
  "medication_learner_guardian_users(uuid)",
  "curriculum_catalogue_import_entry(uuid,uuid,text,text,text,text,text,text,text,text,text,text,text,text,date,text)",
  "curriculum_catalogue_transition(uuid,text,text)",
  "curriculum_catalogue_supersede(uuid,text,text,text,text)",
  "transport_event_recipients(uuid)",
  "transport_trip_guardian_users(uuid)",
  "may_talk(uuid,uuid,uuid)",
];

async function inventory(pool: pg.Pool): Promise<FnRow[]> {
  const r = await pool.query<FnRow>(
    `SELECT p.oid::regprocedure::text AS signature,
            pg_get_userbyid(p.proowner) AS owner,
            p.prosecdef AS secdef,
            p.proconfig AS config,
            COALESCE(
              (SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END
                                ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END)
                 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                WHERE a.grantee <> p.proowner AND a.privilege_type = 'EXECUTE'),
              ARRAY[]::text[]) AS grantees
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
      ORDER BY 1`,
  );
  return r.rows;
}

describe("Stage D: SECURITY DEFINER and function inventory (live catalogue)", () => {
  let ctx: Ctx;
  let migrator: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    migrator = (await ctx.pool.query<{ u: string }>("SELECT current_user AS u")).rows[0]!.u;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  it("lists exactly the expected application functions (completeness)", async () => {
    const rows = await inventory(ctx.pool);
    expect(rows.map((r) => r.signature).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it("every function: owned by the migrator, pg_temp-last fixed search_path, no PUBLIC EXECUTE, only expected grantees", async () => {
    for (const row of await inventory(ctx.pool)) {
      const want = EXPECTED[row.signature]!;
      expect(row.owner, `${row.signature} owner`).toBe(migrator);
      expect(row.owner, `${row.signature} owner`).not.toBe("figbloom_app");
      expect(row.secdef, `${row.signature} secdef`).toBe(want.secdef);
      expect(row.config, `${row.signature} search_path`).toEqual(["search_path=pg_catalog, pg_temp"]);
      expect(row.grantees, `${row.signature} EXECUTE grantees`).toEqual(want.grantees);
      expect(row.grantees, `${row.signature} PUBLIC`).not.toContain("PUBLIC");
    }
  });

  it("each SECURITY DEFINER trigger function is owned by the owner of the table it guards", async () => {
    const r = await ctx.pool.query<{ fn: string; fn_owner: string; table_owner: string }>(
      `SELECT p.oid::regprocedure::text AS fn,
              pg_get_userbyid(p.proowner) AS fn_owner,
              pg_get_userbyid(c.relowner) AS table_owner
         FROM pg_trigger t
         JOIN pg_proc p ON p.oid = t.tgfoid
         JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND p.prosecdef`,
    );
    // 3 before migration 025, plus org_delegation_guard, staff_resource_grants_guard and the
    // membership-change function, which is attached twice (UPDATE and DELETE). Migration 026 adds
    // four: users (status), organizations (status) and organization_memberships (UPDATE and DELETE).
    // Migration 029 adds class_memberships_integrity_guard. Later attendance triggers are invokers.
    // Migration 110 adds learner_accounts_on_membership_archive (school_memberships).
    expect(r.rows.length).toBe(18);
    for (const row of r.rows) expect(row.fn_owner, row.fn).toBe(row.table_owner);
  });

  it("the runtime role owns no function and can execute only the allowlisted definers (no trigger function)", async () => {
    const owned = await ctx.pool.query(
      `SELECT 1 FROM pg_proc p WHERE pg_get_userbyid(p.proowner) = 'figbloom_app'`,
    );
    expect(owned.rowCount).toBe(0);
    const exec = await ctx.pool.query<{ sig: string }>(
      `SELECT p.oid::regprocedure::text AS sig
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef
          AND has_function_privilege('figbloom_app', p.oid, 'EXECUTE')`,
    );
    expect(exec.rows.map((r) => r.sig).sort()).toEqual([...RUNTIME_EXECUTABLE_DEFINERS].sort());
  });

  it("a function created later by the migrator is not executable by PUBLIC by default", async () => {
    const c = await ctx.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`CREATE FUNCTION public.zz_default_acl_probe() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
      const r = await c.query<{ public_exec: boolean }>(
        `SELECT has_function_privilege('public.zz_default_acl_probe()'::regprocedure, 'EXECUTE')
                AND EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a WHERE a.grantee = 0)
                AS public_exec
           FROM pg_proc p WHERE p.oid = 'public.zz_default_acl_probe()'::regprocedure`,
      );
      expect(r.rows[0]!.public_exec).toBe(false);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("a definer or helper added without being listed would fail the completeness check (negative control)", async () => {
    const c = await ctx.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        `CREATE FUNCTION public.zz_unlisted_definer() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`,
      );
      const names = (await inventory(c as unknown as pg.Pool)).map((r) => r.signature);
      expect(names).toContain("zz_unlisted_definer()");
      expect(Object.keys(EXPECTED)).not.toContain("zz_unlisted_definer()");
      const unlisted = (await inventory(c as unknown as pg.Pool)).filter((r) => !(r.signature in EXPECTED));
      expect(unlisted.map((r) => r.signature)).toEqual(["zz_unlisted_definer()"]);
      // ...and it would also fail the search_path rule.
      expect(unlisted[0]!.config).toBeNull();
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
});

describe("Stage D: temp-table and search_path shadowing attacks", () => {
  let ctx: Ctx;
  let membershipId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    const m = await ctx.pool.query<{ id: string }>(
      `SELECT id FROM school_memberships WHERE user_id = $1 AND tenant_id = $2`,
      [ctx.ids.teacherA, ctx.ids.tenantA],
    );
    membershipId = m.rows[0]!.id;
  }, 120_000);

  afterAll(async () => {
    await ctx.app.close();
    await ctx.pool.end();
  });

  /**
   * The attacker is a purpose-built role that, unlike figbloom_app, may archive a
   * membership (a permissive policy models any future role or policy that can).
   * It creates TEMP tables with the names the trigger function uses and puts
   * pg_temp first in its search_path, then archives the membership.
   * Everything runs in one owner transaction that is rolled back, so no role,
   * policy, grant or function change survives. It does NOT rely on
   * REVOKE TEMPORARY: TEMPORARY is granted to the attacker explicitly.
   */
  async function archiveWithShadowTables(opts: { preFixFunction?: string }) {
    const c = await ctx.pool.connect();
    try {
      await c.query("BEGIN");
      if (opts.preFixFunction) await c.query(opts.preFixFunction);
      await c.query(`CREATE ROLE probe_attacker NOLOGIN`);
      await c.query(`GRANT probe_attacker TO CURRENT_USER`); // allow SET ROLE inside this rolled-back transaction
      await c.query(`GRANT TEMPORARY ON DATABASE ${(await c.query("SELECT current_database() AS d")).rows[0].d} TO probe_attacker`);
      await c.query(`GRANT USAGE ON SCHEMA public TO probe_attacker`);
      await c.query(`GRANT SELECT, UPDATE ON school_memberships TO probe_attacker`);
      await c.query(`CREATE POLICY probe_all ON school_memberships FOR ALL TO probe_attacker USING (true) WITH CHECK (true)`);

      // Real state: one grant and one audit baseline.
      await c.query(
        `INSERT INTO staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'attendance')`,
        [ctx.ids.tenantA, ctx.ids.teacherA],
      );
      const before = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM security_audit_events WHERE event_type = 'membership.archived.authz_revoked'`,
      );

      await c.query(`SET LOCAL ROLE probe_attacker`);
      await c.query(`SET search_path = pg_temp, public`);
      await c.query(`CREATE TEMP TABLE staff_area_grants (tenant_id uuid, user_id uuid, area text, granted_by uuid, granted_at timestamptz)`);
      await c.query(`CREATE TEMP TABLE school_role_assignments (tenant_id uuid, user_id uuid, role_id uuid)`);
      await c.query(
        `CREATE TEMP TABLE security_audit_events (id uuid DEFAULT gen_random_uuid(), occurred_at timestamptz DEFAULT now(), actor_user_id uuid, tenant_id uuid, event_type text, detail jsonb DEFAULT '{}', ip inet)`,
      );
      await c.query(`INSERT INTO pg_temp.staff_area_grants (tenant_id, user_id, area) VALUES ($1, $2, 'decoy')`, [
        ctx.ids.tenantA,
        ctx.ids.teacherA,
      ]);
      await c.query(`UPDATE public.school_memberships SET archived_at = now() WHERE id = $1`, [membershipId]);
      const tempGrants = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_temp.staff_area_grants`);
      const tempAudit = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_temp.security_audit_events`);
      await c.query(`RESET ROLE`);
      await c.query(`RESET search_path`);

      const realGrants = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.staff_area_grants WHERE user_id = $1 AND tenant_id = $2`,
        [ctx.ids.teacherA, ctx.ids.tenantA],
      );
      const after = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.security_audit_events WHERE event_type = 'membership.archived.authz_revoked'`,
      );
      return {
        realGrants: Number(realGrants.rows[0]!.n),
        realAuditAdded: Number(after.rows[0]!.n) - Number(before.rows[0]!.n),
        tempGrantsLeft: Number(tempGrants.rows[0]!.n),
        tempAuditRows: Number(tempAudit.rows[0]!.n),
      };
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  }

  it("NC-D1 negative control: against the migration-004 definition the same attack neutralises the revocation and hides the audit row", async () => {
    const pre = historicalFunction("004_closure_roles_lifecycle_identity.sql", "school_memberships_on_archive");
    expect(pre).toContain("SET search_path = public");
    const r = await archiveWithShadowTables({ preFixFunction: pre });
    // The DELETE hit the attacker's temp table: the real grant survives, and the
    // audit row went into the attacker's temp table instead of the real audit log.
    expect(r.realGrants).toBe(1);
    expect(r.realAuditAdded).toBe(0);
    expect(r.tempAuditRows).toBe(1);
    expect(r.tempGrantsLeft).toBe(0);
  });

  it("hardened school_memberships_on_archive: real grants are cleared, the real audit row is written, shadow tables are untouched", async () => {
    const r = await archiveWithShadowTables({});
    expect(r.realGrants).toBe(0);
    expect(r.realAuditAdded).toBe(1);
    expect(r.tempAuditRows).toBe(0);
    expect(r.tempGrantsLeft).toBe(1); // the decoy row was not deleted
  });

  async function rateBucketShadow(opts: { preFixFunction?: string }) {
    const c = await ctx.pool.connect();
    try {
      await c.query("BEGIN");
      if (opts.preFixFunction) await c.query(opts.preFixFunction);
      const db = (await c.query("SELECT current_database() AS d")).rows[0].d as string;
      await c.query(`GRANT TEMPORARY ON DATABASE ${db} TO figbloom_app`);
      await c.query(`SET LOCAL ROLE figbloom_app`);
      await c.query(`SET search_path = pg_temp, public`);
      await c.query(
        `CREATE TEMP TABLE auth_rate_buckets (bucket_key text PRIMARY KEY, tokens numeric NOT NULL, last_refill timestamptz NOT NULL DEFAULT now())`,
      );
      await c.query(`SELECT * FROM consume_rate_token('zz-shadow-key', 1, 5, 2, 5000)`);
      const temp = await c.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_temp.auth_rate_buckets`);
      await c.query(`RESET ROLE`);
      await c.query(`RESET search_path`);
      const real = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM public.auth_rate_buckets WHERE bucket_key = 'zz-shadow-key'`,
      );
      return { temp: Number(temp.rows[0]!.n), real: Number(real.rows[0]!.n) };
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  }

  it("NC-D2 negative control: the migration-003 consume_rate_token is hijacked by a temp table", async () => {
    const pre = historicalFunction("003_r2_remediation.sql", "consume_rate_token");
    const r = await rateBucketShadow({ preFixFunction: pre });
    expect(r).toEqual({ temp: 1, real: 0 });
  });

  it("hardened consume_rate_token always uses the real bucket table", async () => {
    const r = await rateBucketShadow({});
    expect(r).toEqual({ temp: 0, real: 1 });
  });

  it("an unqualified reference fails loudly instead of resolving through the caller's path", async () => {
    const c = await ctx.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        `CREATE FUNCTION public.zz_unqualified() RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
           SET search_path = pg_catalog, pg_temp AS $$ BEGIN RETURN (SELECT count(*) FROM learners); END $$`,
      );
      await expect(c.query(`SELECT public.zz_unqualified()`)).rejects.toThrow(/relation "learners" does not exist/);
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });

  it("guardian_links_active_learner_guard still refuses an archived learner while temp 'learners' shadows exist", async () => {
    const owner = ctx.pool;
    const db = (await owner.query("SELECT current_database() AS d")).rows[0].d as string;
    const learnerId = (
      await owner.query<{ id: string }>(
        `INSERT INTO learners (tenant_id, admission_no, full_name, gender, active, archived_at)
         VALUES ($1, 'ZZ-SHADOW', 'Shadow Archived', 'female', false, now()) RETURNING id`,
        [ctx.ids.tenantA],
      )
    ).rows[0]!.id;
    const guardianId = (
      await owner.query<{ id: string }>(
        `INSERT INTO guardians (tenant_id, full_name) VALUES ($1, 'Shadow Guardian') RETURNING id`,
        [ctx.ids.tenantA],
      )
    ).rows[0]!.id;
    await owner.query(`GRANT TEMPORARY ON DATABASE ${db} TO figbloom_app`);
    const c = await ctx.runtimePool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [ctx.ids.tenantA]);
      await c.query(`SET LOCAL search_path = pg_temp, public`);
      await c.query(
        `CREATE TEMP TABLE learners (id uuid, tenant_id uuid, active boolean DEFAULT true)`,
      );
      await c.query(`INSERT INTO pg_temp.learners (id, tenant_id, active) VALUES ($1, $2, true)`, [learnerId, ctx.ids.tenantA]);
      await expect(
        c.query(
          `INSERT INTO public.guardian_links (tenant_id, guardian_id, learner_id, relationship) VALUES ($1, $2, $3, 'mother')`,
          [ctx.ids.tenantA, guardianId, learnerId],
        ),
      ).rejects.toMatchObject({ code: "P0002" });
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
      await owner.query(`REVOKE TEMPORARY ON DATABASE ${db} FROM figbloom_app`);
      await owner.query(`DELETE FROM guardians WHERE id = $1`, [guardianId]);
      await owner.query(`DELETE FROM learners WHERE id = $1`, [learnerId]);
    }
  });
});
