# API CI job: proposal and team-approval request (FIG-1606, D-2)

**Status: PREPARED. BLOCKED: EXTERNAL APPROVAL REQUIRED.** `.github/workflows/ci.yml` is team-owned and has **not** been modified. Nothing here is an active merge gate. Supersedes the 2026-11-12 proposal (Node 20, owner-role runtime, no build or audit gate).

The job is in [`ci-api-job.patch.yml`](./ci-api-job.patch.yml) (YAML-validated locally: one additive job `api`, 11 steps, `needs: security-scan`).

## What the team is asked to approve

| Item | Detail |
|---|---|
| Workflow file | `.github/workflows/ci.yml` only: one additive job `api` under `jobs:`. No existing job, trigger or permission changes |
| Checks (each fails the job on a genuine error) | lockfile integrity (`npm ci --ignore-scripts`); dependency audit of the API workspace incl. dev dependencies, **any** finding fails; typecheck; production build; compiled migrations: apply, verify, second run is a no-op; OpenAPI validation; the whole API suite, which includes RLS and tenant isolation through the real `figbloom_app` login, runtime-role assertions, `SECURITY DEFINER` inventory and shadowing attacks, credential access, idempotency, cancellation over a real socket, headers/CORS, logging redaction, the architecture rules and a compiled-build smoke test |
| Not in this job | root lint and unit tests (existing `checks` job); the team security scan (existing job, and `needs: security-scan` here); Deno and Playwright (existing jobs) |
| Permissions | inherits the workflow's `contents: read`; no new permission, no `GITHUB_TOKEN` write, no `id-token` |
| Secrets | none. The Postgres service credentials (`postgres/postgres`) belong to a throwaway container. The `figbloom_app` login password is generated per test run inside the suite and reset afterwards |
| Actions | the same SHA-pinned actions the workflow already uses (checkout v4.4.0, setup-node v4.4.0); Node 22 like the other jobs |
| Database | `postgres:15` service container (matches the 15.x used locally; PostgreSQL 16 behaviour of role membership options has not been exercised) |
| Expected cost | about 3-6 minutes of one `ubuntu-latest` runner per pull request and push to `main`, in parallel with the other jobs (local full API run: about 100 s). `timeout-minutes: 25` |
| Deployment impact | none: no deploy step, no environment, no artifact upload, no release trigger |
| Branch protection | **the job does not become a merge gate by being added**. Making it required needs a repository-admin ruleset change (not requested here and not performed). Until that exists and is verified, no document may call this a merge gate |

## Known limits (stated, not hidden)

- **No remote proof.** Verifying the job on GitHub needs a push or a pull request; neither is authorised. What exists is local evidence: each gate was run against deliberately broken input and exited non-zero (type error: typecheck exit 2; edited historical migration: `migrate:verify` exit 1; duplicated OpenAPI operation id: `openapi:check` exit 1; the pre-Zod lockfile: `npm audit` exit 1 naming zod/vitest/mocker findings).
- **Whole-repository audit is not gated here.** `npm audit` over all workspaces reports 35 findings (29 in `apps/mobile`'s tree, 6 in the root `typescript-eslint` chain) that decision D-T2 and a typescript-estree release must resolve. The API-workspace gate is 0 findings. A repository-wide gate must not be narrowed to hide them.
- Node 26 (AD-7 / OD-5): a portable local binary (v26.12.1) ran typecheck, build and the full API suite successfully on 2026-11-16; **`engines` and this CI proposal still pin Node 22** until team confirmation. The job uses Node 22 like its siblings.

## How to apply (after approval)

Paste the job from `ci-api-job.patch.yml` under `jobs:` in `.github/workflows/ci.yml` in its own commit, open a pull request, and record the first green remote run. Only then can FIG-1606 move beyond "implementation complete locally / pending external validation".
