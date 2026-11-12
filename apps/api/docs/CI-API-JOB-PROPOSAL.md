# Proposed CI job for `@figbloom/api` (D-2)

**Status:** PREPARED · OPEN — TEAM APPROVAL (`.github/workflows/ci.yml` is team-owned)  
**Authoritative handoff:** [`TEAM-APPROVAL-D2-CI.md`](./TEAM-APPROVAL-D2-CI.md) + [`ci-api-job.patch.yml`](./ci-api-job.patch.yml)  
**Do not merge without authorization. Do not push merely to test the pipeline. A patch file alone does not close D-2.**

## Proposed job (additive)

```yaml
  api:
    name: API (figbloom_api)
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: figbloom_api
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U postgres"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
    env:
      DATABASE_URL: postgresql://postgres:postgres@127.0.0.1:5432/figbloom_api
      AUTH_RATE_CAPACITY: "1000"
      AUTH_RATE_REFILL: "1000"
      API_TRUST_PROXY_HOPS: "0"
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npm
      - name: Security scan
        run: sh scripts/security-scan.sh
      - name: Install
        run: npm ci --ignore-scripts
      - name: API typecheck
        run: npm run typecheck --workspace @figbloom/api
      - name: API migrate
        run: npm run migrate --workspace @figbloom/api
      - name: API tests
        run: npm run test --workspace @figbloom/api
      - name: OpenAPI check
        run: npm run openapi:check --workspace @figbloom/api
```

## Workspace / lockfile readiness (verified 2026-11-12)

- Root `package.json` workspaces already include `apps/*` → `@figbloom/api` resolves.
- `package-lock.json` contains `"apps/api"` and `node_modules/@figbloom/api` → `resolved: apps/api`.
- `npm ls --workspace @figbloom/api --depth=0` lists fastify/pg/zod/vitest.
- No workspace-array edit is required for the CI job to resolve the package.

## Approval required

- Land the job from `ci-api-job.patch.yml` into `.github/workflows/ci.yml` after team review (do not invent merge/push).
- Closure of D-2 requires a **green remote run** of this job on CI, not only a local proposal or local `76/76`.
