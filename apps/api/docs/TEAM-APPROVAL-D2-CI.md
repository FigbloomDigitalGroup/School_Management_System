# TEAM APPROVAL — D-2: Integrate `@figbloom/api` into CI

**Status:** APPLY-READY PROPOSAL · **OPEN — TEAM APPROVAL** · Not landed in `.github/workflows/ci.yml`  
**Issue:** FIG-1573 / finding D-2  
**Owner for merge:** team workflow maintainers  
**Do not push or merge without authorization.**

---

## 1. Current CI gap

| Job today | Covers `@figbloom/api`? |
|---|---|
| `security-scan` | Reads tracked files (includes future `apps/api` once committed) |
| `checks` (typecheck / lint / unit) | **No** — root `typecheck` omits API; root `test:unit` is web/shared vitest, not API |
| `edge-functions` | No |
| `database-and-browser` | Legacy Supabase RLS + Playwright only |

Result: API security regressions (RBAC, rate-limit, migrations 001–005) are **not** gated on PRs.

## 2. Proposed CI architecture

Add one job `api` that:

1. `needs: security-scan` (same gate as every other job).
2. Starts a **Postgres 16 service container** named database `figbloom_api`.
3. Runs `npm ci --ignore-scripts` from the committed lockfile.
4. Typechecks `@figbloom/api`.
5. Lints `apps/api` with the **root** eslint flat config.
6. Runs the **real** migration runner (`npm run migrate --workspace @figbloom/api`) against the service DB.
7. Runs the API vitest suite (foundation + audit + R2 + closure — these are the API’s unit/integration tests).
8. Runs `openapi:check`.

No hosted credentials. `DATABASE_URL` is only the job-local service.

## 3. Exact patch

Canonical file: [`ci-api-job.patch.yml`](./ci-api-job.patch.yml)  
Insert the `api:` job into `.github/workflows/ci.yml` as a sibling of `checks`.

Pinned SHAs match existing jobs (`actions/checkout@11d5960a…`, `actions/setup-node@49933ea5…`).

## 4. Files affected (when approved)

| File | Change |
|---|---|
| `.github/workflows/ci.yml` | Add `api` job (team-owned — **approval required**) |
| `apps/api/docs/ci-api-job.patch.yml` | Already prepared (this programme) |
| `package-lock.json` / `apps/api/**` | Must be committed with the API for the job to resolve the workspace |

No new GitHub Actions secrets.

## 5. Required secrets / environment variables

| Name | Source | Notes |
|---|---|---|
| `DATABASE_URL` | Job `env` → service Postgres | Not a repository secret |
| `AUTH_RATE_CAPACITY` / `AUTH_RATE_REFILL` | Job `env` | Raised so login tests are not starved |
| `API_TRUST_PROXY_HOPS` | `0` | Proxy trust off in CI |

## 6. Security implications

- Continues to block install/build until `security-scan` passes.
- Uses `--ignore-scripts` (same as `checks`).
- Isolated disposable Postgres — no production / hosted project.
- Does not weaken `.gitignore` or load root hosted `.env`.
- Failure of migrate/test/openapi fails the job (and thus the PR check once required).

## 7. Expected time / resources

| Estimate | Value |
|---|---|
| Wall clock | ~3–8 minutes (npm ci + migrate + ~80 tests) |
| Timeout | 20 minutes (patch) |
| Runners | `ubuntu-latest` + Postgres service |

## 8. Local validation evidence (this machine)

Commands (signature scan first per `.agents/SECURITY.md`):

```text
git ls-files '*.config.*' | … signature grep → clean
npm run typecheck --workspace @figbloom/api → PASS
npx eslint "apps/api/src/**/*.ts" "apps/api/test/**/*.ts" → (run in verification pass)
npm run migrate --workspace @figbloom/api → applied via test harness / migrate
npm run test --workspace @figbloom/api → 77/77 PASS
npm run openapi:check --workspace @figbloom/api → ok: 14 paths, 16 operations
```

Workspace readiness: root `workspaces: ["apps/*"]`; lockfile contains `apps/api` / `node_modules/@figbloom/api`.

## 9. Exact approval and merge requirements

1. Team reviews and approves inserting the `api` job into `ci.yml`.
2. Authorized commit includes `apps/api` + lockfile + the `ci.yml` edit (or sequential commits).
3. Push / PR per normal branch protection.
4. Observe a **green** `API (figbloom_api)` check on CI.
5. Only then mark D-2 **CLOSED AND VERIFIED** in the closure register.

**Until step 4, D-2 remains OPEN — TEAM APPROVAL.** A local green suite is not a substitute.
