# `@figbloom/api` — replacement modular monolith

Node.js + TypeScript service for the FigBloom replacement backend.

**Shipped slices**

- **P1-A / FIG-1573:** Identity, tenancy and RBAC foundation
- **VS-1:** Learner directory create/read (`POST/GET /v1/tenants/:tenantId/learners…`)

- Managed PostgreSQL (local isolated DB `figbloom_api`)
- Opaque sessions (token hash in Postgres — no Redis)
- Server-enforced tenancy and RBAC (default deny)
- Versioned REST under `/v1` + OpenAPI in `openapi/openapi.yaml`

Does **not** replace existing web/mobile or the Supabase stack. Client integration uses OpenAPI handoffs (see `docs/VS1-LEARNER-DIRECTORY-HANDOFF.md`).

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
