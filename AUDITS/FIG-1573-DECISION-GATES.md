# FIG-1573 — Decision gates

**Date:** 2026-11-12  
**Do not invent approval.**

---

## Gate A — R2-05 Organization-admin policy (HIGH) · Owner: Ancel

**Status:** **CLOSED AND VERIFIED**

Ancel approved aggregate-only org access with explicit school delegation (not legacy full school-acting). Implemented in:

- `apps/api/migrations/005_org_admin_delegation.sql`
- `apps/api/src/modules/rbac/{authorize,delegations}.ts`
- `apps/api/src/http/routes/{rbac,org}.ts`
- `apps/api/docs/ORG-ADMIN-POLICY.md`
- Regression: API suite **77/77**

---

## Gate B — D-2 API CI job (MED) · Owner: team (workflow maintainers)

**Handoff:** `apps/api/docs/TEAM-APPROVAL-D2-CI.md` + `ci-api-job.patch.yml` (Postgres service, eslint, migrate, test, openapi).  
**Also:** `AUDITS/FIG-1573-FINAL-TEAM-APPROVAL-PACKAGE.md`  
**Workspace ready:** `apps/*` + lockfile; clean worktree `npm ci --ignore-scripts` exit 0.  
**Not done:** landing the job in `.github/workflows/ci.yml`, or green remote run.  
**Confirmed absent:** no `api` job in current `ci.yml`.

D-2 closes only after merge **and** a green remote `API (figbloom_api)` run. Local **77/77** is not a substitute.

---

## Gate C — R3-08 shared `baseUrl` (INFO / shared config) · Owner: team

**Handoff:** `apps/api/docs/TEAM-APPROVAL-R3-08-TYPESCRIPT.md` (Option B recommended).  
**Done locally:** API local `baseUrl` removed; API typecheck PASS; standalone tsc without baseUrl/paths PASS.  
**Blocked:** shared `tsconfig.base.json` still declares `baseUrl` (+ `paths` / `ignoreDeprecations: "5.0"`).  
Do **not** edit shared config without authorization. Do **not** raise `ignoreDeprecations` to silence TS 7.

---

## Already verified (no gate)

| Gate | Evidence |
|---|---|
| API suite | **77/77** |
| OpenAPI | 14 paths / 16 operations |
| Root typecheck / lint / unit | PASS / 0 err / 1744 (prior) |
| Deno edge | 155 (prior) |
| Lockfile | `npm ci --ignore-scripts --dry-run` exit 0 |
| Disposable RLS | integrity 81, audit_log 21, tenant_matrix 1044 |
| Playwright flows (isolated `:5174`) | desktop 24/24; phone 19 + 2 intentional `isMobile` skips |

---

## After remaining gates

1. Fresh Claude independent audit of migration 004–005 + closure surface.  
2. Separate read-only Claude verification of register/report vs tree.  
3. **Commit/push/PR (2026-11-12):** Ancel authorized proceeding without waiting for D-2 / R3-08. Those gates remain open and must be stated accurately on the PR; they are not closed by local verification alone.
