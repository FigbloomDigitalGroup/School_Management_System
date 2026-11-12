# `@figbloom/api` — replacement modular monolith (P1-A)

Node.js + TypeScript service implementing **FIG-1573 / P1-A: Identity, Tenancy and RBAC Foundation**.

- Managed PostgreSQL (local isolated DB `figbloom_api`)
- Opaque sessions (token hash in Postgres — no Redis)
- Server-enforced tenancy and RBAC (default deny)
- Versioned REST under `/v1` + OpenAPI in `openapi/openapi.yaml`

Does **not** replace existing web/mobile or the Supabase stack. Dual-run until Phase 9.

## Setup

1. Create an empty local database (example against local Supabase Postgres — **not** hosted prod data):

```bash
docker exec supabase_db_figbloom psql -U postgres -c "CREATE DATABASE figbloom_api"
```

2. Copy `env.example` → `.env` and set `DATABASE_URL` to that database.
3. Install and migrate:

```bash
npm install --workspace @figbloom/api
npm run migrate --workspace @figbloom/api
npm run dev --workspace @figbloom/api
```

## Scripts

| Script | Purpose |
|---|---|
| `migrate` | Apply forward-only SQL in `migrations/` |
| `dev` / `start` | Run the API |
| `typecheck` | `tsc --noEmit` |
| `test` | Vitest (unit + integration). **Resets the database**: refuses anything but a loopback `figbloom_api` |
| `openapi:check` | Validate OpenAPI structure, `$ref`s and authz annotations (route parity is a test) |

## Security

Run `sh scripts/security-scan.sh` before every build/lint/test/commit (see `.agents/SECURITY.md`).
