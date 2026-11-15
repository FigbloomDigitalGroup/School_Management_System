# `@figbloom/api` — replacement modular monolith

Node.js + TypeScript service for the FigBloom replacement backend.

**Shipped slices**

- **P1-A / FIG-1573:** Identity, tenancy and RBAC foundation
- **VS-1:** Learner directory create/read (`POST/GET /v1/tenants/:tenantId/learners…`)
- **VS-2:** Guardian directory create/read and learner links (`POST/GET /v1/tenants/:tenantId/guardians…`, `GET …/learners/:learnerId/guardians`)

- Managed PostgreSQL (local isolated DB `figbloom_api`)
- Opaque sessions (token hash in Postgres — no Redis)
- Server-enforced tenancy and RBAC (default deny)
- Versioned REST under `/v1` + OpenAPI in `openapi/openapi.yaml`

Does **not** replace existing web/mobile or the Supabase stack. Client integration uses OpenAPI handoffs (see `docs/VS1-LEARNER-DIRECTORY-HANDOFF.md`, `docs/VS2-GUARDIAN-DIRECTORY-HANDOFF.md`).

## Setup

1. Create an empty local database (example against local Supabase Postgres — **not** hosted prod data):

```bash
docker exec supabase_db_figbloom psql -U postgres -c "CREATE DATABASE figbloom_api"
```

2. Copy `env.example` → `.env` (gitignored; never commit it) and set **two different** connection strings. They are not interchangeable:

| Variable | Used by | Login role | Notes |
|---|---|---|---|
| `MIGRATION_DATABASE_URL` | `npm run migrate`, `migrate:verify` | Migrator / table owner (for example the local `postgres` role) | Direct or session-mode connection only. Never `figbloom_app`. Never a transaction-mode pooler (`pgbouncer=true` is refused). |
| `DATABASE_URL` | the API process | `figbloom_app` | Created `NOLOGIN` by migration 004. After the first migration give it a secret with `ALTER ROLE figbloom_app LOGIN PASSWORD '...'` run as the migrator, and put that password only in your untracked `.env`. |

   Each entrypoint reads only its own variable and fails closed when it is absent or wrong: `migrate` stops with `MIGRATION_DATABASE_URL is required` (it does **not** fall back to `DATABASE_URL`) or when that URL connects as the runtime role; the API refuses to start unless `DATABASE_URL` connects as `RUNTIME_ROLE` and the live role passes the startup assertions (`docs/RUNTIME-DATABASE-SECURITY.md`). `figbloom_app` is a cluster-wide role: the test suite enables `LOGIN` with a random password and resets it afterwards, so do not run two suites against one cluster at once.
3. Install, build, migrate (as the migrator), provision the runtime login, then run the API:

```bash
npm install --workspace @figbloom/api
npm run build --workspace @figbloom/api
npm run migrate --workspace @figbloom/api
# one-time, as the migrator: ALTER ROLE figbloom_app LOGIN PASSWORD '<your local secret>'
npm run dev --workspace @figbloom/api
```

## Scripts

| Script | Purpose |
|---|---|
| `build` | Compile `src/` to `dist/` (`tsconfig.build.json`, tests excluded). Production runs this output, never `tsx`. |
| `start` | `node dist/index.js` (run `build` first) |
| `migrate` / `migrate:verify` | `node dist/db/migrate.js` / `--verify`: apply or verify forward-only SQL in `migrations/` from the compiled output (run `build` first) |
| `dev` / `migrate:dev` / `migrate:verify:dev` | Development only: the same programs through `tsx` without a build |
| `typecheck` | `tsc --noEmit` |
| `test` | Vitest (unit + integration). **Resets the database**: refuses anything but a loopback `figbloom_api` |
| `openapi:check` | Validate OpenAPI structure, `$ref`s and authz annotations (route parity is a test) |

## Security

Run `sh scripts/security-scan.sh` before every build/lint/test/commit (see `.agents/SECURITY.md`).
