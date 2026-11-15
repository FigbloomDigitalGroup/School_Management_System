# Database roles and privileges (FIG-1573 closure)

**Status (reconciled with accepted Stage C, 2026-11-14):** the API process connects as `figbloom_app` (`DATABASE_URL`); migrations use `MIGRATION_DATABASE_URL` and refuse the runtime role; startup `assertRuntimeRole` refuses any other role; tenant context is set inside one transaction after authorisation. Implemented and tested through the real `figbloom_app` login; accepted by Ancel (Stage C, `c41e4db`); **not independently verified as a whole programme** and not a production provisioning record. Operational detail: `RUNTIME-DATABASE-SECURITY.md`; policy and grants: migration `009_runtime_rls_hardening.sql`. Tracking: FIG-1605 / FIG-1619.

Earlier wording (2026-11-12) that the API still connected as the table owner and set no tenant context described the pre-Stage-C state and is withdrawn.

## Roles

| Role | Purpose |
|---|---|
| Migrator / table owner (`CURRENT_USER` at migrate time, typically `postgres` locally) | Owns tables, creates migrations, owns append-only trigger functions |
| `figbloom_app` | Runtime application role — **not** table owner |

## Trust boundary

- Append-only audit is enforced by trigger + **REVOKE UPDATE/DELETE/TRUNCATE** from `figbloom_app`.
- PostgreSQL **superusers** and the **table owner** can still disable triggers or truncate — **not claimed as superuser-proof**.
- The API connects as `figbloom_app` (or an equivalent non-owner role with the same grants). The tenant-context plumbing exists (`withTenantTransaction`); with FORCE RLS and no tenant context every RLS-protected query returns no rows, which is the intended fail-closed behaviour.
- Tests enable `LOGIN` with a random per-run password and reset the role to `NOLOGIN` afterwards. The role is cluster-wide. Production provisioning of a durable `LOGIN` secret (`ALTER ROLE`, not `CREATE ROLE`) is an operations step, not a migration.

## Required properties of the runtime role (approved 2026-11-12, FIG-1605; enforced at startup since Stage C)

Dedicated non-owner role used only by the API; **no `SUPERUSER`, no `BYPASSRLS`, no ownership of protected objects, no direct or inherited membership in any privileged or owner role, and no ability to assume one (`SET ROLE` / `SET SESSION AUTHORIZATION` must fail)**. This is a hard prohibition that **cannot be waived by risk acceptance** (approved 2026-11-12). API startup refuses to run as a role that fails any of these (`assertRuntimeRole`; purpose-built-role matrix in `test/roleAssert.test.ts`). (Migration 004 grants `figbloom_app` **to** the migrator, the safe direction; verify there is no reverse membership.) A separate, audited role (not the HTTP-serving one) is needed for any bypass or background/administrative work.

## Privileges (`figbloom_app`)

Exact matrix: migration 009, asserted by `test/grants.matrix.test.ts`. Summary:

- Per-table minimum DML derived from the code audit (e.g. `school_memberships`, `school_roles`, `school_role_assignments`: `SELECT` only; `learners`, `guardians`, `guardian_links`: `SELECT, INSERT`). No `TRUNCATE`, `REFERENCES` or `TRIGGER` anywhere.
- `users`: **no table-level privilege**; column-level `SELECT` on the eight non-secret columns and **no `UPDATE` of any kind** (migration 013). `password_hash` cannot be read by any statement; it is reachable only through three exact-key `SECURITY DEFINER` read functions (migration 011) and written only through `auth_change_own_password` (migration 013), which derives the account from a valid session, compare-and-swaps the verified current hash and writes the audit row. See `RUNTIME-DATABASE-SECURITY.md`. (Migration 009's table-level `SELECT, UPDATE` and migration 011's column `UPDATE` are superseded; the effective state is what the grants-matrix test reads from PostgreSQL.)
- `security_audit_events`: `INSERT` only (no `SELECT`; the API has no read path).
- `schema_migrations` and `schema_migration_checksum_audit`: no grant (the earlier `SELECT` on `schema_migrations` is revoked).
- `EXECUTE` on `consume_rate_token`, `app_current_tenant_id`, `app_current_user_id`; `prune_rate_buckets` is revoked.
- `CREATE` on schema `public`: revoked from `PUBLIC` and from `figbloom_app`.
- No ownership of `security_audit_events`; cannot drop the append-only trigger.

## Production provisioning (no production credentials used here)

```sql
-- As migrator / superuser after migrations:
-- figbloom_app already exists. Migration 004 runs `CREATE ROLE figbloom_app NOINHERIT`, which PostgreSQL
-- creates NOLOGIN (and NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION); migration 013 refuses
-- to continue if the role has any privileged attribute. LOGIN is enabled only by the ALTER ROLE below.
-- Give it a login secret out of band (never in a migration or a tracked file):
ALTER ROLE figbloom_app LOGIN PASSWORD '...';  -- or IAM / SCRAM provisioning externally
-- Grants and policies are applied by migrations 004 and 009.
-- DATABASE_URL = figbloom_app (the API). MIGRATION_DATABASE_URL = the migrator/owner.
```

## Tenant isolation (hybrid)

See `TENANT-ISOLATION.md`. Tenant tables have `FORCE` RLS with an explicit `figbloom_app` policy on `app_current_tenant_id()`; the API sets `app.user_id` and then `app.tenant_id` with `set_config(..., true)` inside `withTenantTransaction`. There is no application mode GUC in any policy.
