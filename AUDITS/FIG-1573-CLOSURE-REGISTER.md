# FIG-1573 Closure Register

**Programme:** Completely close all outstanding findings from P1-A Identity, Tenancy and RBAC Foundation.  
**Human task owner:** Ancel  
**Implementation owner:** Cursor  
**Branch / HEAD (verified 2026-11-12):** `ancel-feature` / `81532f1` — ahead 6 of `origin/ancel-feature`; nothing committed  
**Working tree:** ` M package-lock.json`, `?? apps/api/`, `?? AUDITS/` (+ gitignored `.personal-ai/` mirrors)  
**Fresh API suite:** **77/77** (R2-05 delegation) · openapi 14 paths / 16 ops · Playwright desktop 24/24 · phone 19/2-skip  
**Restrictions:** no commit, push, PR, merge, deploy, production DB, Linear Done, Phase 2.

**Canonical path (objective):** `AUDITS/FIG-1573-CLOSURE-REGISTER.md`  
**Mirror:** `.personal-ai/phase0-rebuild/AUDITS/FIG-1573-CLOSURE-REGISTER.md`  
**Decision card:** `AUDITS/FIG-1573-DECISION-GATES.md` (and personal-ai mirror)

Disposition vocabulary: `CLOSED AND VERIFIED` · `OPEN — BLOCKER` · `OPEN — TEAM APPROVAL` · `OPEN — USER APPROVAL` · `OPEN — EXTERNAL DEPENDENCY` · `ACCEPTED BOUNDARY` · `DEFERRED WITH OWNER`

---

## Source reports

| Report | Path |
|---|---|
| Session 1 | `.personal-ai/phase0-rebuild/AUDITS/FIG-1573-CLAUDE-AUDIT-AND-REMEDIATION.md` |
| Session 2 remediation | `.personal-ai/phase0-rebuild/AUDITS/FIG-1573-SESSION2-REMEDIATION.md` |
| Second review (reconstructed) | `.personal-ai/phase0-rebuild/AUDITS/FIG-1573-SECOND-INDEPENDENT-REVIEW.md` |
| Final review (reconstructed) | `.personal-ai/phase0-rebuild/AUDITS/FIG-1573-FINAL-INDEPENDENT-REVIEW.md` |
| Complete report | `AUDITS/FIG-1573-COMPLETE-CLOSURE-REPORT.md` |

---

## Finding detail (WS0 schema)

### AUD-01 — Trusted proxy and forwarded IP handling
- **Severity:** HIGH · **Class:** Confirmed defect (remediated)
- **Root cause:** Client IP / rate-limit buckets could be influenced by untrusted `X-Forwarded-For`.
- **Affected files:** `apps/api/src/http/ip.ts`, auth login path, env config for hops/CIDRs
- **Required correction:** Hop-count + CIDR trust; ignore forged leftmost entries; IPv4/IPv6 normalize
- **Dependencies:** none
- **Implementation status:** Done
- **Regression test:** `p1a.audit-hardening` AUD-01; `p1a.r2-remediation` R2-01/02; `p1a.closure` R3-02/03
- **Verification evidence:** API suite green; multi-XFF + untrusted peer cases
- **Final disposition:** **CLOSED AND VERIFIED**

### AUD-02 — Suspended-school authorization
- **Severity:** HIGH · **Class:** Confirmed defect (remediated)
- **Root cause:** Live suspension not enforced for org/school actors after session issue.
- **Affected files:** tenancy/authz middleware, select-tenant
- **Required correction:** Deny members/org admins on suspended schools; allow super_admin
- **Dependencies:** AUD-06 session auth
- **Implementation status:** Done
- **Regression test:** `p1a.audit-hardening` AUD-02; `p1a.r2-remediation` R2-08 select-tenant
- **Verification evidence:** API suite
- **Final disposition:** **CLOSED AND VERIFIED**

### AUD-03 — Rate limiter atomicity
- **Severity:** MED · **Class:** Missing/weak implementation (remediated)
- **Root cause:** Non-atomic / non-PG token bucket risk under concurrency.
- **Affected files:** `consume_rate_token` SQL (002+), rate-limit callers
- **Required correction:** PG atomic token bucket; capacity 5 / refill 2 per 5s; 429 + Retry-After
- **Dependencies:** none
- **Implementation status:** Done
- **Regression test:** `p1a.audit-hardening` AUD-03 (incl. 25-parallel)
- **Verification evidence:** API suite
- **Final disposition:** **CLOSED AND VERIFIED**

### AUD-04 — Decoy scrypt on unknown accounts
- **Severity:** MED · **Class:** Confirmed defect (remediated)
- **Root cause:** Timing oracle on unknown vs wrong password.
- **Affected files:** `apps/api/src/modules/auth/service.ts`
- **Required correction:** Decoy scrypt on unknown/disabled paths
- **Dependencies:** none
- **Implementation status:** Done
- **Regression test:** foundation + audit suite login paths
- **Verification evidence:** API suite
- **Final disposition:** **CLOSED AND VERIFIED**

### AUD-05 — Composite FK tenant integrity
- **Severity:** MED · **Class:** Confirmed defect (remediated)
- **Root cause:** Cross-tenant role/grant inserts possible.
- **Affected files:** migration `002_audit_hardening.sql`
- **Required correction:** Composite FKs tying roles/grants to tenant membership
- **Dependencies:** migration forward-only
- **Implementation status:** Done
- **Regression test:** `p1a.audit-hardening` AUD-05
- **Verification evidence:** API suite
- **Final disposition:** **CLOSED AND VERIFIED**

### AUD-06 — Tenantless authentication lifecycle endpoints
- **Severity:** HIGH · **Class:** Confirmed defect (remediated)
- **Root cause:** Archived/stale tenant context could lock out logout/membership/select flows.
- **Affected files:** `requireSessionAuth`, auth routes
- **Required correction:** Allowlisted tenantless lifecycle endpoints under session auth
- **Dependencies:** none
- **Implementation status:** Done
- **Regression test:** `p1a.audit-hardening` AUD-06
- **Verification evidence:** API suite
- **Final disposition:** **CLOSED AND VERIFIED**

### AUD-07 — Concurrent grants vs archive
- **Severity:** MED · **Class:** Confirmed defect (remediated)
- **Root cause:** Race could leave grants on archived membership.
- **Affected files:** grant paths + archive trigger (003/004)
- **Required correction:** FOR UPDATE + archive trigger revoke; deterministic lifecycle tests
- **Dependencies:** R2-06 / R3-01
- **Implementation status:** Done
- **Regression test:** `p1a.audit-hardening` AUD-07; `p1a.closure` R3-01/05
- **Verification evidence:** API suite
- **Final disposition:** **CLOSED AND VERIFIED**

### AUD-08 — Append-only audit log
- **Severity:** MED · **Class:** Confirmed defect → privilege residual closed in 004
- **Root cause:** Trigger alone insufficient if app role owns table / can bypass.
- **Affected files:** migration `004_closure_roles_lifecycle_identity.sql`, `DB-ROLES.md`
- **Required correction:** Non-owner `figbloom_app`; REVOKE UPDATE/DELETE/TRUNCATE; tests as non-owner
- **Dependencies:** R2-04, R3-07, WS8
- **Implementation status:** Done
- **Regression test:** `p1a.closure` R2-04/R3-07; audit-hardening AUD-08
- **Verification evidence:** SET ROLE figbloom_app denials
- **Final disposition:** **CLOSED AND VERIFIED**  
  Trust boundary: not tamper-proof vs PostgreSQL superuser (documented).

### AUD-09…AUD-15 (Session-1 residuals)
- **Severity:** LOW/MED · **Class:** Remediated in Session-1 suite
- **Root cause:** Error shape, input bounds, login_id bounds, acting-as, secret-free audit, etc.
- **Affected files:** HTTP error helpers, RBAC, OpenAPI annotations
- **Required correction:** As Session-1 remediation
- **Dependencies:** none
- **Implementation status:** Done
- **Regression test:** `p1a.audit-hardening` AUD-09/11/13/15 blocks
- **Verification evidence:** API suite
- **Final disposition:** **CLOSED AND VERIFIED**

### D-1 — Broader rate-limit policy
- **Severity:** MED · **Class:** Missing documentation/coverage (closed for approved scope)
- **Root cause:** Login-only coverage undocumented; password-change unprotected.
- **Affected files:** `RATE-LIMIT-POLICY.md`, password-change buckets
- **Required correction:** Documented policy + buckets on password-change; PG atomicity retained
- **Dependencies:** R2-07
- **Implementation status:** Done for approved endpoint scope
- **Regression test:** password-change rate cases in closure suite / auth tests
- **Verification evidence:** policy doc + API suite
- **Final disposition:** **CLOSED AND VERIFIED**

### D-2 — API CI integration
- **Severity:** MED · **Class:** Missing implementation in team CI
- **Root cause:** `apps/api` outside root typecheck/unit/`ci.yml`.
- **Affected files:** `apps/api/docs/TEAM-APPROVAL-D2-CI.md`, `ci-api-job.patch.yml` (strengthened: Postgres user/health, eslint, migrate, test, openapi); target `.github/workflows/ci.yml` (team-owned — **unchanged**)
- **Required correction:** Land API job; observe green remote run
- **Dependencies:** Team authorization
- **Implementation status:** Apply-ready proposal **IMPLEMENTED** locally as docs/patch only — **not** in `ci.yml`
- **Regression test:** N/A until remote job exists
- **Verification evidence:** local API **77/77** + eslint 0 ≠ CI closure
- **Final disposition:** **AWAITING TEAM APPROVAL** (do **not** mark CLOSED for patch alone)

### D-3 — Database tenant isolation strategy
- **Severity:** MED · **Class:** Architecture decision (implemented hybrid)
- **Root cause:** App-layer isolation only; learner data forthcoming.
- **Affected files:** migration 004 RLS policies, `TENANT-ISOLATION.md`, repositories
- **Required correction:** Explicit hybrid: app-layer + RLS on authz tables; non-owner tests
- **Dependencies:** WS6, WS8 roles
- **Implementation status:** Done
- **Regression test:** `p1a.closure` RLS cross-tenant hide; disposable integrity/audit/tenant_matrix
- **Verification evidence:** RLS 81 + audit 21 + tenant_matrix 1044; API non-owner RLS test
- **Final disposition:** **CLOSED AND VERIFIED**

### D-4 / D-5 — Password change / session revocation slice
- **Severity:** LOW · **Class:** Missing implementation (closed)
- **Root cause:** Flag returned but not enforced; no change endpoint.
- **Affected files:** `authContext.ts`, `auth/service.ts`, password routes, OpenAPI
- **Required correction:** Enforce `must_change_password`; `/v1/auth/password/change`; revoke other sessions
- **Dependencies:** R2-07
- **Implementation status:** Done
- **Regression test:** `p1a.closure` R2-07
- **Verification evidence:** API suite
- **Final disposition:** **CLOSED AND VERIFIED**

### D-6 — Rate-limit denial audit sampling
- **Severity:** LOW · **Class:** Documentation
- **Root cause:** Audit flood risk on 429s.
- **Affected files:** `RATE-LIMIT-POLICY.md`
- **Required correction:** Documented sampling strategy
- **Dependencies:** D-1
- **Implementation status:** Documented
- **Regression test:** N/A (policy)
- **Verification evidence:** policy doc
- **Final disposition:** **CLOSED AND VERIFIED**

### D-7 / D-9 / D-16 — Accepted boundaries
- **Severity:** INFO · **Class:** Architecture/operational boundary
- **Final disposition:** **ACCEPTED BOUNDARY** (prior Session-1)

### D-8 — Mutation resistance
- **Severity:** LOW · **Class:** Missing test
- **Root cause:** Security tests might not fail when checks removed.
- **Affected files:** `p1a.closure.test.ts` D-8 block
- **Required correction:** Assert fail-closed for permission/tenant checks
- **Dependencies:** none
- **Implementation status:** Done
- **Regression test:** `p1a.closure` D-8
- **Verification evidence:** API suite
- **Final disposition:** **CLOSED AND VERIFIED**

### D-10 — Performance
- **Severity:** INFO · **Class:** Deferred
- **Final disposition:** **DEFERRED WITH OWNER**

### D-11 — Dependency advisory (zod)
- **Severity:** INFO · **Class:** Operational follow-up
- **Affected files:** `NPM-AUDIT-API.md`
- **Required correction:** Track advisory; upgrade only with deliberate compatibility pass (no force upgrade in this programme)
- **Final disposition:** **DEFERRED WITH OWNER** (INFO; recorded in `NPM-AUDIT-API.md`)

### D-12 / R3-06 — Live OpenAPI contract validation
- **Severity:** LOW · **Class:** Missing test depth
- **Root cause:** Route presence only; responses not schema-checked.
- **Affected files:** `contractAssert.ts`, `p1a.closure` R3-06
- **Required correction:** Live status/body/error/429 samples vs OpenAPI
- **Dependencies:** none
- **Implementation status:** Done
- **Regression test:** `p1a.closure` R3-06
- **Verification evidence:** API suite + `openapi:check`
- **Final disposition:** **CLOSED AND VERIFIED**

### D-14 — Supabase identity mapping
- **Severity:** MED · **Class:** Missing implementation (local foundation) + external hosted
- **Root cause:** No external IdP subject mapping; email≠identity.
- **Affected files:** migration 004 `external_identities`, link API, `EXTERNAL-IDENTITY-BRIDGE.md`
- **Required correction:** Provider+subject unique links; collision/takeover policy; dual-run bridge contract
- **Dependencies:** Hosted Supabase credentials for production mapping
- **Implementation status:** Local model + tests done; hosted mapping not performed
- **Regression test:** `p1a.closure` D-14
- **Verification evidence:** API suite; bridge doc
- **Final disposition:** **CLOSED AND VERIFIED (local)** / **OPEN — EXTERNAL DEPENDENCY (hosted)**

### D-15 — AC3 RBAC matrix documentation
- **Severity:** LOW · **Class:** Documentation gap (partial)
- **Affected files:** `AC3-RBAC-MATRIX-NOTE.md`
- **Final disposition:** **CLOSED AND VERIFIED (documented partial)**

### D-17 — Multi-process rate-limit assumptions
- **Severity:** INFO · **Class:** Documentation
- **Affected files:** `RATE-LIMIT-MULTIPROCESS.md`
- **Final disposition:** **CLOSED AND VERIFIED (accepted)**

### R2-01 / R2-02 / R2-03 / R2-08 / R2-10
- **Class:** Session-2 defects (remediated)
- **Implementation status:** Done (proxy reject legacy flags; IP-first rate order; select-tenant 404; EXECUTE grant; OpenAPI 404/learner)
- **Regression test:** `p1a.r2-remediation.test.ts`
- **Final disposition:** **CLOSED AND VERIFIED**

### R2-04 — Genuine append-only via non-owner role
- **Severity:** HIGH · **Class:** Confirmed residual (closed in 004)
- **Root cause:** Same as AUD-08 privilege gap
- **Affected files:** 004 roles, privilege tests
- **Required correction:** See AUD-08
- **Dependencies:** WS1/WS8
- **Regression test:** `p1a.closure` non-owner denials
- **Final disposition:** **CLOSED AND VERIFIED**

### R2-05 — Organization admin RBAC policy
- **Severity:** HIGH · **Class:** Architecture decision (approved + implemented)
- **Root cause:** Org admins inherited full school-admin rights including staff-area grants; not reconciled with aggregate-only model.
- **Affected files:** migration `005_org_admin_delegation.sql`, `authorize.ts`, `delegations.ts`, `http/routes/rbac.ts`, `http/routes/org.ts`, OpenAPI, `ORG-ADMIN-POLICY.md`, `AUTHZ-CONVENTIONS.md`, `p1a.closure` / audit-hardening tests
- **Required correction:** Ancel-approved policy — aggregate org access; no automatic school-admin; explicit granular school-scoped revocable auditable delegation; acting context on privileged actions.
- **Dependencies:** none (decision received 2026-11-12)
- **Implementation status:** Done
- **Regression test:** `p1a.closure` R2-05 (aggregate deny + grant/revoke/escalation); `p1a.audit-hardening` AUD-11 updated
- **Verification evidence:** `npm run test --workspace @figbloom/api` **77/77**; typecheck; openapi 14 paths / 16 ops
- **Final disposition:** **CLOSED AND VERIFIED**

### R2-06 / R3-01 / R3-05 — Membership archive lifecycle
- **Severity:** (R3 HIGH residual → closed)
- **Root cause:** Archive deleted grants without audit; restore silently lacked grants but race test weak.
- **Affected files:** 004 archive trigger + audit event; `p1a.closure` lifecycle
- **Required correction:** Auditable revoke; restore without silent re-grant; deterministic tests
- **Dependencies:** WS1
- **Implementation status:** Done
- **Regression test:** `p1a.closure` R3-01/05
- **Final disposition:** **CLOSED AND VERIFIED**

### R2-07 — must_change_password enforcement
- **Severity:** MED · **Class:** Missing implementation (closed)
- **Root cause:** Flag returned; not enforced; no change endpoint.
- **Affected files:** `authContext.ts` allowlist, password-change route/service, OpenAPI
- **Required correction:** Block protected routes; change endpoint; clear flag; revoke other sessions; audit without secrets
- **Dependencies:** D-4/D-5
- **Implementation status:** Done
- **Regression test:** `p1a.closure` R2-07
- **Final disposition:** **CLOSED AND VERIFIED**

### R2-09 — Migration runner hardening
- **Severity:** MED · **Class:** Missing hardening (closed)
- **Root cause:** No advisory lock / checksum / edit detection.
- **Affected files:** `apps/api/src/db/migrate.ts`, 004 checksum columns
- **Required correction:** Advisory lock; checksums; detect edited applied migrations; forward-only policy
- **Dependencies:** none
- **Implementation status:** Done
- **Regression test:** `p1a.closure` R2-09
- **Final disposition:** **CLOSED AND VERIFIED**

### R3-02 / R3-03 / R3-04 — Proxy chain / IPv4-mapped / unknown IP bucket
- **Severity:** INFO · **Class:** Missing tests/docs (closed)
- **Affected files:** `ip.ts`, `rateLimitBuckets.ts`, rate policy docs
- **Required correction:** Multi-XFF tests; `::ffff:` normalize; deliberate shared `unknown` bucket (no bypass, no unbounded buckets)
- **Dependencies:** AUD-01
- **Implementation status:** Done
- **Regression test:** `p1a.closure` + `p1a.r2-remediation` R3-02/03
- **Final disposition:** **CLOSED AND VERIFIED**

### R3-07 — Runtime role EXECUTE / privilege tests
- **Severity:** INFO · **Class:** Test deficiency (closed)
- **Root cause:** Privileges tested as DB owner.
- **Affected files:** 004 `figbloom_app`, closure non-owner tests, `DB-ROLES.md`
- **Required correction:** Genuine non-owner role tests
- **Dependencies:** WS8
- **Implementation status:** Done
- **Regression test:** `p1a.closure` R2-04/R3-07
- **Final disposition:** **CLOSED AND VERIFIED**

### R3-08 — TypeScript `baseUrl` deprecation
- **Severity:** INFO · **Class:** Shared config team-owned
- **Root cause:** Shared `tsconfig.base.json` declares `baseUrl` + `paths` (+ existing `ignoreDeprecations: "5.0"`). API inherits it.
- **Affected files:** `apps/api/tsconfig.json` (local `baseUrl` removed); `tsconfig.base.json` (**untouched**); `TEAM-APPROVAL-R3-08-TYPESCRIPT.md`
- **Required correction:** Team Option B — remove shared `baseUrl`/`paths`, add `@figbloom/shared` exports; **not** raise `ignoreDeprecations`
- **Dependencies:** Team approval; green root typecheck after apply
- **Implementation status:** API-local **IMPLEMENTED + LOCALLY VERIFIED**; shared **proposal only**
- **Verification evidence:** API typecheck PASS; standalone tsc without baseUrl/paths PASS; `--showConfig` still shows inherited `baseUrl`
- **Final disposition:** **AWAITING TEAM APPROVAL (shared)** / API-local **LOCALLY VERIFIED** (not full CLOSED until shared lands)

### LOCK-1 — package-lock clean install
- **Class:** Verification
- **Evidence:** Clean detached worktree at `%TEMP%\fig1573_npmci_wt` with copied `apps/api` + lockfile: `npm ci --ignore-scripts` **exit 0** (1266 packages). In-place `npm ci` EPERM on rollup `.node` while Node/Vite processes hold files = **environmental locking**, not lockfile inconsistency. Dry-run also exit 0 historically.
- **Final disposition:** **CLOSED AND VERIFIED** (lockfile); in-place EPERM documented as environment

### GATE-1 — Local CI-equivalent gate
- **Class:** Verification
- **Evidence (2026-11-12 re-run before commit):** security-scan PASS; `npm ci --ignore-scripts` exit 0 (1266 packages); root typecheck PASS; API typecheck PASS; root lint 0 errors / 2 pre-existing web warnings; API eslint 0; root unit **1744** passed / 21 skipped; API **77/77**; Deno edge **155**; OpenAPI 14 paths / 16 ops; `supabase db reset` applied migration sequence; RLS integrity 81 / audit_log 21 / tenant_isolation 25 / tenant_matrix 1044 / full suite PASS; Playwright `e2e/flows.spec.ts` **43 passed / 2 skipped** (desktop+phone).
- **Final disposition:** **CLOSED AND VERIFIED (local)** — remote D-2 still **AWAITING TEAM APPROVAL** (no `api` job in `ci.yml`)

### DOC-1 / REP-1
- **Final disposition:** **CLOSED AND VERIFIED** (architecture/GRAPH/roadmap/handoff + complete report)

---

## Decisions still required (team)

1. **D-2:** Land `ci-api-job.patch.yml` into `.github/workflows/ci.yml` + green remote run.
2. **R3-08:** Shared `tsconfig.base.json` TS-7 path strategy.

R2-05 is closed (Ancel-approved aggregate + delegation).

---

## Summary board

| Status | IDs |
|---|---|
| CLOSED AND VERIFIED | AUD-01…15, D-1, D-3, D-4/5, D-6, D-8, D-12/R3-06, D-15, D-17, R2-01…**05**…10, R3-01…05/07, LOCK-1, GATE-1 local, DOC-1, REP-1; D-14 local |
| LOCALLY VERIFIED (not full close) | R3-08 API-local `baseUrl` removal |
| AWAITING TEAM APPROVAL | **D-2**, **R3-08 shared** |
| Final package | `AUDITS/FIG-1573-FINAL-TEAM-APPROVAL-PACKAGE.md` |
| OPEN — EXTERNAL DEPENDENCY | **D-14 hosted** |
| ACCEPTED / DEFERRED | D-7/9/16; D-10; D-11 (INFO zod advisory) |

---

## Progress log

| When | What |
|---|---|
| 2026-11-12 | Implementation WS0–WS14; API 76; Deno 155; CI patch; Playwright GATE-1 |
| 2026-11-12 | Expanded register to full WS0 schema; placed at objective path `AUDITS/` |
| 2026-11-12 | **R2-05 CLOSED AND VERIFIED** — Ancel-approved aggregate + delegation; migration 005; API **77/77** |
| 2026-11-12 | Final team-approval package: D-2/R3-08 handoffs; worktree `npm ci` 0; root typecheck/lint/unit + Deno 155; D-2/R3-08 remain AWAITING TEAM APPROVAL |
| 2026-11-12 | Ancel authorized commit/push/PR of FIG-1573 without waiting for D-2/R3-08; full local CI-equivalent gate re-run PASS; D-2/R3-08 remain AWAITING TEAM APPROVAL and must be documented on the PR; D-14 remains EXTERNAL |
