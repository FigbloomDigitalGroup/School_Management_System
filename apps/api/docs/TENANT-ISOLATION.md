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

## Mandatory application-role restrictions (approved 2026-11-12; ENFORCED at runtime since WP-A1 Stage C)

> **Status correction (Stage 8 completion, 2026-11-18).** This section's heading read "not yet
> enforced" long after the enforcement landed. It is enforced: `src/index.ts` calls
> `assertRuntimeRole` at startup before the server listens; `src/config.ts` defaults
> `RUNTIME_ROLE` to `figbloom_app` and refuses a `DATABASE_URL` whose username is not that role;
> `src/db/roleAssert.ts` refuses superuser, `BYPASSRLS`, `CREATEROLE`, membership in a privileged
> role, ownership of protected objects and any successful `SET ROLE`. Every directory table ships
> `ENABLE` + `FORCE ROW LEVEL SECURITY`, and `test/phase3.runtimeIsolation.test.ts` and
> `test/stageC.rlsOwnership.test.ts` exercise all of it through the real `figbloom_app` login.
> What remains open is hosted provisioning and the worker/admin tenant-context policy
> (`WORKER-ISOLATION-PROPOSAL.md`, still design-only), not the role restrictions below.

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

---

## Standing rule for every new personal-data table (FIG-1605 criterion 15; binding)

Written 2026-11-17. This rule applies to every table added after this date, in any module, without needing a new decision.

1. A table that holds personal data, or any data owned by a school, ships in the **same migration** with `tenant_id uuid NOT NULL`, `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, one `FOR ALL TO figbloom_app` policy using `tenant_id = app_current_tenant_id()` in both `USING` and `WITH CHECK`, and the owner-only `PUBLIC` policy. No table is created first and protected later.
2. Grants to `figbloom_app` are the minimum the module needs. No `DELETE`, `TRUNCATE` or ownership unless a documented rule requires it.
3. The same pull request adds the table to `RLS-CATALOGUE.md` and to the runtime-isolation inventory in `test/phase3.runtimeIsolation.test.ts` (seed rows in two schools, an unfiltered `SELECT` returns only the current school, a write naming another school is refused, missing or malformed context sees nothing). Tests must run **as the `figbloom_app` login**, not as the owner and not with `SET ROLE` alone.
4. Application authorization stays mandatory. RLS is defence in depth against an omitted filter, not a substitute for a permission check.
5. Applied migrations are never edited; a correction is a new migration.
6. `test/fig1605.policyCatalogue.test.ts` and `phase3.runtimeIsolation.test.ts` enforce points 1 and 3 automatically; a reviewer must reject a table that bypasses them.

## Criterion 14: background jobs and administrative workers (approved design = binding prerequisite; NOT built)

**Owner decision, 2026-11-17: worker isolation is an architectural prerequisite for any future background processing of tenant data. It is not an instruction to build workers.** The approved architecture is `WORKER-ISOLATION-PROPOSAL.md`: a separate `figbloom_worker` service identity and database role, the tenant taken from a stored job row, one transaction per attempt with transaction-local context, authorization at enqueue and re-validation at execution, least privilege, audited, and no cross-tenant execution; suspension, disablement and invalidation behaviours are defined there.

**Release gate (binding):** no background job, scheduled task, import, report or administrative tool may touch tenant data until an implementation satisfies that design and has passed its own security verification (the checklist in section 8 of the proposal, through the real `figbloom_worker` login).

State today: no worker role, job runner or administrative tenant-context mechanism exists and none was invented. There is therefore **no sanctioned way** for non-request code to read or write tenant data under `figbloom_app`; the migrator/owner role is the only other actor and it is not a runtime role. Criterion 14 is met as a documented, approved prerequisite; **worker isolation is not implemented and not verified.** Keep this separate from the verified API request path (criteria 1 to 13).

## Criterion 16: hosted CI evidence

Hosted evidence comes only from a remote run of the `api` job (FIG-1606). It has **not been produced**: the job exists in `.github/workflows/ci.yml` locally and nothing was pushed, and the job has not run on Node 22 or on GitHub. **Owner decision (2026-11-17): hosted CI is not a blocker for Execution Batch 01**; local CI-equivalent verification (every job step run locally in CI order, including a run without `apps/api/.env`) is sufficient for this batch. Local runs are still not hosted evidence, and this criterion is recorded as not performed, not as passed.

### Criterion 14 investigation (2026-11-17)

A search of `apps/api/src` for workers, queues, schedulers, timers and cron finds none: the only non-request database consumers are the migration runner (owner role, offline) and two owner-run housekeeping functions (`prune_idempotency_keys`, `prune_rate_buckets`) that no process calls. There is no code that acquires tenant context outside a request, no job table and no worker role, so nothing can be verified against a worker that does not exist. The concrete design, the open technical questions and the verification checklist are in `WORKER-ISOLATION-PROPOSAL.md`.
