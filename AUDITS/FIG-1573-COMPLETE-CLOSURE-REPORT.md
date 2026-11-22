# FIG-1573 — Complete Closure Report

**Date:** 2026-11-12  
**Implementer:** Cursor (primary implementation agent)  
**Human task owner:** Ancel  
**Branch / HEAD:** `ancel-feature` / `81532f1` (unchanged; nothing committed)  
**Working tree:** ` M package-lock.json`, `?? apps/api/`, `?? AUDITS/` (+ gitignored `.personal-ai/` mirrors)

**Verdict:** **IMPLEMENTATION COMPLETE FOR ALL LOCALLY EXECUTABLE WORKSTREAMS** — **NOT self-accepted**. R2-05 **CLOSED AND VERIFIED** (Ancel-approved aggregate + explicit delegation; migration 005; API **77/77**). Remaining gates: **D-2** (team CI), **R3-08 shared baseUrl** (team). FIG-1573 **not** Done. Phase 1 **not** complete. Phase 2 **not** started.

---

## 1. Executive summary

The P1-A foundation (`apps/api`) was preserved and hardened through a 14-workstream closure programme. Migration `004_closure_roles_lifecycle_identity.sql` adds runtime role `figbloom_app`, auditable membership archival, external identity tables, hybrid RLS on authorization tables, and migration checksum columns. The migration runner now uses advisory locks and checksum verification. Password-change enforcement, proxy/IP/rate-limit hardening, OpenAPI live-sample checks, and deterministic archive lifecycle tests are in place.

**API verification (this machine):** `npm run typecheck --workspace @figbloom/api` PASS; `npm run test --workspace @figbloom/api` **76/76 PASS**; `npm run openapi:check` ok (12 paths); Deno edge **155 PASS**; root typecheck/lint/unit previously green.

---

## 2. Original acceptance criteria

See Session-1 report §3. No regression claimed against prior AC PASS items. Dual-run Supabase bridge remains foundation-only (D-14).

---

## 3–4. Consolidated finding register and resolutions

Authoritative live register: `AUDITS/FIG-1573-CLOSURE-REGISTER.md` (full WS0 schema). Decision card: `AUDITS/FIG-1573-DECISION-GATES.md`.

| ID | Final status | Evidence |
|---|---|---|
| AUD-01…AUD-15 (except residual notes) | CLOSED AND VERIFIED (prior + retained tests) | Session-1 + suite |
| AUD-08 privilege residual | CLOSED AND VERIFIED | 004 + non-owner tests |
| AUD-10 / D-12 / R3-06 | CLOSED AND VERIFIED (sample live required props) | `p1a.closure` OpenAPI samples |
| D-1 | CLOSED AND VERIFIED (documented + password-change buckets) | `RATE-LIMIT-POLICY.md` |
| D-2 | AWAITING TEAM APPROVAL | `TEAM-APPROVAL-D2-CI.md` + strengthened `ci-api-job.patch.yml` — **not** in `ci.yml` |
| D-3 | CLOSED AND VERIFIED | `TENANT-ISOLATION.md` + RLS tests |
| D-4/D-5 (password slice) | CLOSED AND VERIFIED | password-change endpoint + tests |
| D-7/D-9/D-16 | ACCEPTED BOUNDARY / INFO | prior |
| D-14 | CLOSED AND VERIFIED (local) · OPEN — EXTERNAL DEPENDENCY (hosted) | `EXTERNAL-IDENTITY-BRIDGE.md` |
| R2-01/02/03/06/08/10 | CLOSED AND VERIFIED | Session-2 + final review |
| R2-04 | CLOSED AND VERIFIED | non-owner role tests |
| R2-05 | CLOSED AND VERIFIED | migration 005 + delegation API + tests 77/77 |
| R2-07 | CLOSED AND VERIFIED | must_change + change endpoint |
| R2-09 | CLOSED AND VERIFIED | migrate advisory lock + checksum |
| R3-01/05 | CLOSED AND VERIFIED | deterministic lifecycle test |
| R3-02/03/04 | CLOSED AND VERIFIED | multi-XFF + mapped IPv6 + unknown bucket |
| R3-07 | CLOSED AND VERIFIED | non-owner EXECUTE + denials |
| R3-08 | AWAITING TEAM APPROVAL (shared) · API-local LOCALLY VERIFIED | `TEAM-APPROVAL-R3-08-TYPESCRIPT.md`; shared untouched |
| LOCK-1 | CLOSED AND VERIFIED | `npm ci --ignore-scripts --dry-run` exit 0; in-place unlink EPERM is process-lock only |
| GATE-1 | CLOSED AND VERIFIED (local) | API 76; root; Deno 155; lock dry-run; RLS integrity/audit/tenant_matrix PASS; Playwright flows desktop 24/24 + phone 19/2-skip on isolated :5174 |

---

## 5. Architectural decisions

| Decision | Status |
|---|---|
| Modular monolith Node/TS + PG; no Redis; no microservices | APPROVED · IMPLEMENTED · VERIFIED |
| Hybrid tenant isolation (app-layer + RLS on authz tables) | APPROVED (programme) · IMPLEMENTED · VERIFIED |
| Runtime role `figbloom_app` non-owner | APPROVED · IMPLEMENTED · VERIFIED |
| Org-admin = aggregate + explicit school delegation (Ancel-approved) | APPROVED · IMPLEMENTED · VERIFIED |
| External identity link table for dual-run | IMPLEMENTED · hosted mapping EXTERNAL |
| MFA still design-only | DEFERRED WITH OWNER (D-6 / Phase 10) |

---

## 6. Database migrations

| Migration | Purpose |
|---|---|
| 001 | Identity/tenancy/RBAC foundation (unchanged body) |
| 002 | Audit hardening / rate fn / FKs (unchanged body) |
| 003 | R2 remediation (unchanged body) |
| **004** | Roles, audit privileges, archive audit, external identities, RLS hybrid, checksum columns |
| **005** | R2-05 org-admin school delegations + RBAC permission seeds |

Forward-only. No production DB modified.

---

## 7–15. Security / identity / RBAC / audit / rate-limit / isolation / roles / tests

Covered in `apps/api/docs/{DB-ROLES,TENANT-ISOLATION,ORG-ADMIN-POLICY,RATE-LIMIT-POLICY,EXTERNAL-IDENTITY-BRIDGE,AUTHZ-CONVENTIONS}.md` and tests in `test/p1a.*.test.ts`.

---

## 16. CI integration

Proposal only: `apps/api/docs/CI-API-JOB-PROPOSAL.md`. **D-2 not closed.**

---

## 17. TypeScript configuration

API-local `baseUrl` removed and typecheck PASS. Shared `tsconfig.base.json` still has `baseUrl` + `paths` + `ignoreDeprecations` — **team approval required**.

---

## 18. Verification evidence

| Command | Result |
|---|---|
| Signature grep on `*.config.*` for `_0x` / `app-vscode-eval` / `verify-human` | no matches; `.gitignore` retains `.env` rules |
| `npm run typecheck --workspace @figbloom/api` | PASS |
| `npm run test --workspace @figbloom/api` | **77/77 PASS** (R2-05 delegation suite) |
| `npm run openapi:check --workspace @figbloom/api` | ok: 14 paths, 16 operations |
| Root typecheck | PASS |
| Root lint | 0 errors, 2 pre-existing warnings |
| Root `test:unit` | **1744 passed** / 21 skipped |
| Deno edge | **155 PASS** |
| Lock | `npm ci --ignore-scripts --dry-run` exit **0** (in-place `npm ci` EPERM = running Node locks rollup `.node`, not lockfile defect) |
| Disposable RLS | integrity **81**, audit_log **21**, tenant_matrix **1044** PASS |
| Playwright `e2e/flows.spec.ts` (isolated Vite `:5174`, `r7iso/pw.isolated.config.ts`) | desktop **24/24 PASS**; phone **19 PASS / 2 skip** (`test.skip(isMobile)` Manage dialog) · logs `%TEMP%\fig1513_env\fig1573_closure_flows_{desktop,phone}.out` |

---

## 19. Remaining limitations

1. Production must provision `figbloom_app` and point `DATABASE_URL` at it.
2. Hosted Supabase subject mapping not performed.
3. CI does not yet run API tests.
4. Shared TS `baseUrl` warning may remain in editors.
5. Remote CI API job (D-2) not landed — local CI-equivalent including Playwright is verified.
6. Shared `tsconfig.base.json` `baseUrl` still needs team approval (R3-08).

---

## 20. Deployment prerequisites

- Apply migrations 001–004 on isolated managed Postgres.
- Create/login role `figbloom_app`; never run API as table owner in production.
- Configure `API_TRUST_PROXY_HOPS` + `API_TRUST_PROXY_CIDRS` only behind real proxies.
- Do not deploy until independent review + Ancel acceptance + authorized commit/push/PR path.

---

## 21. Independent review requirements

1. Fresh Claude audit of migration 004, migrate runner, password-change allowlist, RLS policies, and privilege tests.
2. Separate read-only verification of this report against the working tree.
3. Confirm no secret files read; no production changes.

---

## 22. Final acceptance recommendation

**Do not mark FIG-1573 Done.** Recommend: team approves CI job (D-2) + shared tsconfig plan (R3-08); Claude independent audit of migrations 004–005; then authorize commit.

**Next stage:** fresh Claude audit + read-only verification (as instructed).
