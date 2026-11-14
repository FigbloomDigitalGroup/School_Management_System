# Tenant isolation decision (D-3)

**Status (reconciled with accepted Stage C, 2026-11-14):** DECISION APPROVED · policies and migrations (004-007 as amended by 009) PRESENT · **runtime RLS enforcement IMPLEMENTED and TESTED through the real `figbloom_app` login; accepted by Ancel (Stage C, `c41e4db`); not independently verified as a whole programme and not claimed for production hosting.** Operational detail: `RUNTIME-DATABASE-SECURITY.md`. Tracking: **FIG-1605 / FIG-1619**.
The 2026-11-12 wording ("NOT ACTIVE and NOT VERIFIED", "the API never calls `setTenantContext`") described the pre-Stage-C state and is withdrawn.

## What is true today

| Layer | State | Evidence |
|---|---|---|
| 1. Application-layer tenant isolation | **Implemented and tested.** Still mandatory; RLS complements it | API suite: cross-tenant, header spoof, archived, suspended, org-of-other-org |
| 2. PostgreSQL RLS policies and migrations | **Present**: migrations 004-007 as amended by **009**; `ENABLE` + `FORCE` on the tenant tables (`staff_area_grants`, `school_roles`, `school_role_assignments`, `org_admin_school_delegations`, `learners`, `guardians`, `guardian_links`) and on `school_memberships` | Exercised over HTTP as a real `figbloom_app` login (`runtimeRls.http.test.ts`), plus live `pg_policies` and grants assertions; `SET ROLE` tests are supplementary only |
| 3. Runtime RLS enforcement | **Active in the tested runtime.** The API connects as `figbloom_app` (`DATABASE_URL`); startup refuses any other role; `app.user_id` then `app.tenant_id` are set once, transaction-locally, after the tenant is authorised; a pooled connection never carries context to the next request (pool-size-1 tests); missing or malformed context matches no rows. **Tested, not independently verified** | `runtimeIdentity.http.test.ts`, `runtimeRls.http.test.ts`, `stageC.*` suites, negative controls NC-1..NC-8 |

**Resolved by migration 009:** the former policies that accepted `app.authz_mode = 'bypass'` / `'owner'` (which the application role could set itself) are dropped. No policy reads a mode GUC; setting one as `figbloom_app` changes nothing (proved at runtime). The only non-tenant path is a positive owner policy (`current_user = pg_get_userbyid(relowner)`), not an application-controlled bypass. A migrator that also holds `BYPASSRLS` (the local `postgres` role does) bypasses `FORCE`; `figbloom_app` must not, and startup checks that. RLS still guards against a forgotten tenant filter, not against arbitrary malicious SQL that can call `set_config` (see the qualification below).

## Approved security model and threat-model qualification (Ancel, 2026-11-12)

RLS provides **defence in depth against accidentally omitted tenant filters and ordinary application mistakes**. It **complements** application-layer authorization and does **not** replace it.

**What RLS does not do:** it does not independently protect against arbitrary malicious SQL executed with credentials that can freely manipulate tenant context (the former `bypass` / `owner` settings were removed by migration 009; a statement that can still call `set_config('app.tenant_id', ...)` is the remaining case). That threat needs additional controls: least-privilege credentials, no raw SQL from untrusted input, query review, audit, and a separate bypass role or SECURITY DEFINER functions. No document may claim RLS covers it.

Requirements: (1) application authorization stays mandatory; (2) dedicated non-owner API role; (3) no `BYPASSRLS`; (4) tenant context set safely per applicable transaction; (5) context never trusted from client values; (6) pooling cannot leak context; (7) missing context fails closed; (8) `FORCE ROW LEVEL SECURITY` where appropriate; (9) explicit context policy for background jobs and administrative operations; (10) cross-tenant tests through the real application database role.

Acceptance is grouped on FIG-1605 as: A policy existence, B role privileges, C runtime context establishment, D pool isolation, E actual cross-tenant enforcement, F governance. Each group needs its own evidence.

## Mandatory application-role restrictions (approved 2026-11-12; not yet enforced)

The application database role **must not be capable of bypassing RLS or assuming database-owner privileges**. Accepting a role that can is **not permitted and cannot be waived by risk acceptance**. Required: a dedicated non-owner role used only by the API; no `SUPERUSER`; no `BYPASSRLS`; no ownership of protected tables, functions, schemas or sequences; no direct or inherited membership in any privileged or owner role; no ability to assume a privileged role (`SET ROLE` / `SET SESSION AUTHORIZATION` must fail); safe transaction-scoped tenant context; connection-pool isolation; missing context fails closed; runtime cross-tenant tests using this actual role. API startup must refuse to run if any of these is false.

This is distinct from the former `app.authz_mode` question, which migration 009 removed. Role-level bypass or owner assumption is never acceptable. RLS still does not protect against arbitrary malicious SQL that can manipulate tenant context, and application authorization remains mandatory.

## Mandatory prerequisite before any Phase 3 learner / personal-data table (FIG-1605)

1. API connects as a non-owner role everywhere; startup refuses a superuser, owner or `BYPASSRLS` connection.
2. `SET LOCAL app.tenant_id` / `app.user_id` for every applicable transaction, derived from the verified session and membership, never from raw client input.
3. Pooled connections cannot leak context (tested across interleaved tenants, errors and rollbacks).
4. Missing context fails closed.
5. Cross-tenant tests run against the real application role through the real application.
6. `bypass` / `owner` modes unreachable from request-handling code and not settable by the app role. **Satisfied by removal (migration 009); supplementary pattern check plus runtime proof that setting the GUC changes nothing.**
7. Background jobs and administrative operations have explicitly defined tenant-context behaviour.
8. Every Phase 3 PII table ships with `ENABLE` + `FORCE` RLS and a runtime isolation test from its first migration.

Status against this list: items 1-5 and 8 (for the tables that exist) are implemented and tested through the real application role; item 6 is satisfied by removal of the modes; item 7 (jobs and administrative operations) remains a future design item (no worker role exists). RLS must still not be described as independently verified or production-hardened until that review and hosting evidence exist.

## Original decision (retained as the design target)

## Decision: hybrid

1. **Application-layer tenant scoping remains mandatory** for every tenant-owned query (existing P1-A pattern).
2. **PostgreSQL RLS + FORCE** applies to authorization tables (`staff_area_grants`, `school_roles`, `school_role_assignments`) for runtime role `figbloom_app`.
3. **Identity bootstrap tables** (`users`, `sessions`, `school_memberships`, org/platform tables) stay **application-filtered** because login and membership listing are cross-tenant by design.
4. **Phase 3 learner / PII tables must ship with RLS + FORCE from day one** under `figbloom_app`; no learner data without it.

## Context plumbing

- Per transaction: `app.user_id` first, then authorise the candidate tenant, then `app.tenant_id` once, all via `set_config(..., true)` (transaction-local) inside `withTenantTransaction`. There is no mode GUC.
- Never rely on session-level `SET` without `LOCAL` (pooled connection leakage).
- Missing tenant context ⇒ RLS default-deny for `figbloom_app` on protected tables (exercised through the running API as `figbloom_app`).

## Rejected alternatives (for this phase)

| Alternative | Why not alone |
|---|---|
| App-only forever | Insufficient before learner data |
| RLS on all tables including memberships/sessions | Breaks login and multi-school listing without complex bypass |
| Redis / external ACL | Out of approved architecture |

## Administrative exceptions

- Migrator / table owner (not `figbloom_app`) acts through the positive owner policy (`current_user = pg_get_userbyid(relowner)`), not through a mode GUC. A migrator that also holds `BYPASSRLS` bypasses `FORCE` regardless; `figbloom_app` must not (checked at startup).
- There is no `app.authz_mode` bypass. Background or administrative work needs a separately designed, audited role (none exists yet).
