# FIG-1573 — Final team approval package

**Date:** 2026-11-12  
**Branch / HEAD:** `ancel-feature` / `81532f1` (ahead 6 of `origin/ancel-feature`; **nothing committed** for this programme)  
**Working tree:** ` M package-lock.json`, `?? AUDITS/`, `?? apps/api/`  
**Human task owner:** Ancel  
**Implementation owner (this package):** Cursor  
**Restrictions honored:** no commit / push / PR / merge / deploy / Linear Done / Phase 2

---

## 1. Executive status

P1-A (`apps/api`) is **locally complete** for implementable FIG-1573 closure workstreams, including Ancel-approved **R2-05** org-admin aggregate + school delegation (migration 005).

Two **team-owned** dependencies remain **open** and are **not** closed by this package:

| ID | Status | Blocking artefact |
|---|---|---|
| **D-2** | **AWAITING TEAM APPROVAL** | Land API CI job — see §3 |
| **R3-08** | **AWAITING TEAM APPROVAL (shared)** | Edit `tsconfig.base.json` — see §4 |

API-local `baseUrl` removal and the CI patch file are **prepared**, not applied to team-owned shared files.

**Do not mark FIG-1573 Done** until D-2 has a green remote CI run (and R3-08 is either applied+verified or explicitly deferred by the team with acceptance).

---

## 2. Completed findings (summary)

Authoritative detail: `AUDITS/FIG-1573-CLOSURE-REGISTER.md`.

| Bucket | Disposition |
|---|---|
| AUD-01…AUD-15 | **CLOSED AND VERIFIED** (local) |
| D-1, D-3, D-4/5, D-6, D-8, D-12/R3-06, D-15, D-17 | **CLOSED AND VERIFIED** (local) |
| D-14 | **CLOSED AND VERIFIED (local)** / **AWAITING EXTERNAL DEPENDENCY (hosted Supabase mapping)** |
| R2-01…R2-10 including **R2-05** | **CLOSED AND VERIFIED** (local) |
| R3-01…R3-07 | **CLOSED AND VERIFIED** (local) |
| R3-08 API-local | **IMPLEMENTED + LOCALLY VERIFIED**; shared config still **AWAITING TEAM APPROVAL** |
| D-2 | **AWAITING TEAM APPROVAL** (patch ready; not in `ci.yml`) |
| LOCK-1 | **LOCALLY VERIFIED** — clean worktree `npm ci --ignore-scripts` exit **0**; in-place EPERM = file locks from running Node, not lockfile corruption |
| GATE-1 local | **LOCALLY VERIFIED** (see §6) |

No Critical/High finding remains **undispositioned**. High **R2-05** is closed with Ancel approval + tests.

---

## 3. D-2 proposal (CI)

**Read:** `apps/api/docs/TEAM-APPROVAL-D2-CI.md`  
**Patch:** `apps/api/docs/ci-api-job.patch.yml`

### What to approve

Insert the `api` job into `.github/workflows/ci.yml` (sibling of `checks`):

- `needs: security-scan`
- Postgres 16 service → `figbloom_api`
- `npm ci --ignore-scripts`
- API typecheck, eslint on `apps/api`, real `migrate`, vitest suite, `openapi:check`
- No repository secrets; `DATABASE_URL` is the service only
- Pinned action SHAs match existing CI

### Closure criterion for D-2

Green remote check named **API (figbloom_api)** on an authorized PR/push. Local 77/77 is **not** sufficient.

---

## 4. R3-08 proposal (TypeScript)

**Read:** `apps/api/docs/TEAM-APPROVAL-R3-08-TYPESCRIPT.md`

### What to approve

**Option B (recommended):** remove `baseUrl` + `paths` from `tsconfig.base.json`; add `@figbloom/shared` package `exports`/`types`; verify root typecheck.  
**Do not** raise `ignoreDeprecations` to silence TS 7.

API already removed its local `baseUrl` and typechecks. Shared inheritance still injects `baseUrl` (`tsc --showConfig`).

### Closure criterion for R3-08

Approved shared edit merged + green root typecheck (and CI `checks`). Until then: **OPEN — TEAM APPROVAL (shared)**.

---

## 5. Required team decisions (checklist)

- [ ] **D-2:** Approve inserting `ci-api-job.patch.yml` into `ci.yml`
- [ ] Commit/push `apps/api` + lockfile with (or before) the CI change under normal authorization
- [ ] Confirm green `API (figbloom_api)` on CI
- [ ] **R3-08:** Approve Option B (or record explicit deferral / alternate)
- [ ] Apply shared tsconfig change; confirm green root typecheck / CI `checks`
- [ ] Fresh independent Claude audit of migrations **004–005** + closure surface
- [ ] Ancel acceptance before Linear Done / Phase 1 complete

---

## 6. Local verification evidence (this session)

Security: config signature grep clean (`_0x` / `app-vscode-eval` / `verify-human`); `.gitignore` retains `.env`.

| Command | Result |
|---|---|
| Clean worktree `npm ci --ignore-scripts` (`%TEMP%\fig1573_npmci_wt`) | **exit 0** (1266 packages) |
| In-place `npm ci` | Historically **EPERM** on rollup `.node` while Node/Vite hold locks — environmental, not lockfile |
| `npm run typecheck --workspace @figbloom/api` | PASS |
| `npx eslint "apps/api/src/**/*.ts" "apps/api/test/**/*.ts"` | **exit 0** |
| `npm run test --workspace @figbloom/api` | **77/77 PASS** |
| `npm run openapi:check --workspace @figbloom/api` | ok **14 paths / 16 operations** |
| `npm run typecheck` (root) | PASS |
| `npm run lint` | **0 errors**, 2 pre-existing web warnings |
| `npm run test:unit` | **1744 passed** / 21 skipped |
| `npm run test:edge` | **155 passed** |
| API standalone tsc (no `baseUrl`/`paths`) | PASS |
| Playwright flows (prior programme evidence, isolated `:5174`) | desktop 24/24; phone 19 + 2 intentional skips |
| Disposable RLS (prior) | integrity 81, audit_log 21, tenant_matrix 1044 |

### Outstanding verification (explicit)

| Item | Why outstanding |
|---|---|
| Remote CI `api` job | Needs team merge of D-2 |
| Shared `baseUrl` removal on all packages | Needs team merge of R3-08 |
| Hosted Supabase identity mapping (D-14) | External dependency |
| Independent Claude audit | Next stage after this package |
| Re-run Playwright in *this* turn | Prior evidence retained; not re-executed in this approval-package turn |

---

## 7. Exact affected files (for reviewers)

### Already in working tree (uncommitted)

- `apps/api/**` (implementation, migrations 001–005, docs, tests, openapi)
- `package-lock.json`
- `AUDITS/FIG-1573-*.md` (register, reports, this package)

### Team-owned — change **only after approval**

- `.github/workflows/ci.yml` (D-2)
- `tsconfig.base.json` (+ optional `packages/shared/package.json` exports) (R3-08)

### Approval docs

- `apps/api/docs/TEAM-APPROVAL-D2-CI.md`
- `apps/api/docs/ci-api-job.patch.yml`
- `apps/api/docs/TEAM-APPROVAL-R3-08-TYPESCRIPT.md`
- `AUDITS/FIG-1573-FINAL-TEAM-APPROVAL-PACKAGE.md` (this file)

---

## 8. Remaining acceptance conditions

1. D-2 green on CI.  
2. R3-08 shared resolution or documented team deferral.  
3. Independent review of 004–005 + R2-05 delegation.  
4. Authorized commit/push/PR path.  
5. No Phase 1 complete / Phase 2 start without Ancel + programme gates.

---

## 9. Instructions for the team

1. Read §3 and the D-2 patch file; approve or request edits.  
2. Read §4 and approve Option B (or alternative).  
3. Do **not** treat this markdown package as merged CI or fixed TS 7 warnings.  
4. After landing approved changes, update the closure register dispositions for D-2 / R3-08 to **CLOSED AND VERIFIED** with the CI/typecheck URLs or log paths.  
5. Hand to Claude for fresh independent audit when ready.
