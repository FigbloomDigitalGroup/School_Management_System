# Tenant isolation decision (D-3)

**Status:** APPROVED (programme recommendation) · IMPLEMENTED · VERIFIED (non-owner RLS tests)

## Decision: hybrid

1. **Application-layer tenant scoping remains mandatory** for every tenant-owned query (existing P1-A pattern).
2. **PostgreSQL RLS + FORCE** applies to authorization tables (`staff_area_grants`, `school_roles`, `school_role_assignments`) for runtime role `figbloom_app`.
3. **Identity bootstrap tables** (`users`, `sessions`, `school_memberships`, org/platform tables) stay **application-filtered** because login and membership listing are cross-tenant by design.
4. **Phase 3 learner / PII tables must ship with RLS + FORCE from day one** under `figbloom_app`; no learner data without it.

## Context plumbing

- Per transaction: `SET LOCAL app.tenant_id`, `app.user_id`, optional `app.authz_mode`.
- Never rely on session-level `SET` without `LOCAL` (pooled connection leakage).
- Missing tenant context ⇒ RLS default-deny for `figbloom_app` on protected tables.

## Rejected alternatives (for this phase)

| Alternative | Why not alone |
|---|---|
| App-only forever | Insufficient before learner data |
| RLS on all tables including memberships/sessions | Breaks login and multi-school listing without complex bypass |
| Redis / external ACL | Out of approved architecture |

## Administrative exceptions

- Migrator / table owner (not `figbloom_app`) retains bypass via role-targeted policies.
- Explicit `app.authz_mode=bypass` only for carefully gated admin jobs (not exposed to HTTP clients).
