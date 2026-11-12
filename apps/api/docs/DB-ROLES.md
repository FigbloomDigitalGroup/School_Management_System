# Database roles and privileges (FIG-1573 closure)

**Status:** IMPLEMENTED (local) · VERIFIED via non-owner `SET ROLE` tests · production provisioning documented (not applied)

## Roles

| Role | Purpose |
|---|---|
| Migrator / table owner (`CURRENT_USER` at migrate time, typically `postgres` locally) | Owns tables, creates migrations, owns append-only trigger functions |
| `figbloom_app` | Runtime application role — **not** table owner |

## Trust boundary

- Append-only audit is enforced by trigger + **REVOKE UPDATE/DELETE/TRUNCATE** from `figbloom_app`.
- PostgreSQL **superusers** and the **table owner** can still disable triggers or truncate — **not claimed as superuser-proof**.
- Production must connect the API as `figbloom_app` (or an equivalent non-owner role with the same grants).

## Privileges (`figbloom_app`)

- `SELECT/INSERT/UPDATE/DELETE` on application tables (except audit: `SELECT/INSERT` only).
- `EXECUTE` on `consume_rate_token`, `prune_rate_buckets`, `app_current_tenant_id`, `app_current_user_id`.
- `SELECT` on `schema_migrations` only (no INSERT/UPDATE — cannot fake migration history).
- No ownership of `security_audit_events`; cannot drop the append-only trigger.

## Production provisioning (no production credentials used here)

```sql
-- As migrator / superuser after migrations:
CREATE ROLE figbloom_app LOGIN PASSWORD '...';  -- or use IAM / scram externally
GRANT figbloom_app TO /* optional break-glass role */;
-- Grants are applied by migration 004; re-run migrate on empty DBs.
-- Point API DATABASE_URL at figbloom_app, not the migrator.
```

## Tenant isolation (hybrid)

See `TENANT-ISOLATION.md`. Authorization tables use FORCE RLS for `figbloom_app` with `SET LOCAL app.tenant_id`.
