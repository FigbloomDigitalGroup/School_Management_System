# Runtime database security

Status: implemented and tested on the API test database as `figbloom_app`. Not independently verified. Not a production provisioning record.

Two different database logins are required. They are not interchangeable.

| Connection | Environment variable | Role |
|---|---|---|
| API process | `DATABASE_URL` | `figbloom_app` (LOGIN only where the API runs) |
| Migrations | `MIGRATION_DATABASE_URL` | Migrator / table owner. Direct or session-mode. Never `figbloom_app`. |

`loadMigrationConfig()` does not fall back to `DATABASE_URL`. It refuses a URL whose user is the runtime role and refuses `pgbouncer=true` (transaction-mode pooling breaks the session advisory lock). The migrate command uses a pool of one connection named `figbloom-migrate`.

`figbloom_app` is created `NOLOGIN NOINHERIT` by migration 004. Migration 004 grants `figbloom_app` **to** the migrator. The reverse membership is forbidden. Startup calls `assertRuntimeRole` before `listen` and refuses to serve if the connected role is not exactly the configured `RUNTIME_ROLE` (default `figbloom_app`), if `current_user` differs from `session_user`, if the role is superuser / `BYPASSRLS` / `CREATEROLE` / `CREATEDB` / replication, if it owns anything in `public`, if it is a member of another role (including transitively, and including `pg_read_all_data` and the other predefined data roles), if it has `CREATE` on schema `public` or on the database, or if `SET ROLE postgres` or `SET SESSION AUTHORIZATION postgres` succeeds.

Tests turn `LOGIN` on with a random password for the life of the owner pool, then `ALTER ROLE figbloom_app NOLOGIN PASSWORD NULL` when that pool ends. The role is cluster-wide: only one suite may do this at a time (`fileParallelism` is false).

## Pool budget

`POOL_MAX` defaults to 10. Values above 20 are rejected. 20 is a safety ceiling, not a recommended production size.

```
pool_max <= floor((max_connections - reserved_superuser - migrator_sessions) / api_task_count)
```

Keep the sum of every API task’s `POOL_MAX`, plus migrator sessions and superuser reserve, under the server’s `max_connections`.

Checkout waits at most `POOL_ACQUIRE_TIMEOUT_MS` (default 2s) and then returns HTTP 503 `service_unavailable` with `Retry-After: 1`. Statement, lock, and idle-in-transaction limits are set with `set_config(..., true)` inside the transaction (not pool startup parameters):

| Setting | Default |
|---|---|
| `STATEMENT_TIMEOUT_MS` | 15000 |
| `LOCK_TIMEOUT_MS` | 5000 |
| `IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS` | 15000 |

SQLSTATEs `55P03`, `57014`, `25P03`, `40001`, `40P01`, `08000`, `08001`, `08003`, `08006`, `53300`, `57P01`, and `57P03` map to the same 503. The client body does not include the driver text. Nested transactions and a second tenant assignment are refused in the application and become an opaque 500; the transaction is rolled back.

## Transactions

There is one tenant transaction primitive, `withTenantTransaction`:

1. Acquire a client (bounded).
2. `BEGIN`, then set the local timeouts.
3. Set `app.user_id` only.
4. Authorise the candidate tenant (session tenant or `X-Tenant-Id`).
5. Set `app.tenant_id` once.
6. Run permission checks and the business write on a query-only handle. `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, and `set_config` of `app.tenant_id` or `app.user_id` are refused.
7. `COMMIT`. On any error, roll back. A failed rollback is reported with the original error; it does not replace it.

The HTTP reply is sent only after that commit. Sending inside the callback races the commit.

Denial audits (`rbac.permission.denied`) are written after the client is released, on the identity autocommit path, so they survive the rollback and do not deadlock a pool of one. A failed audit write is logged and still returns 403. It does not turn a denial into a success. Business audit rows (`directory.learner.created`, `rbac.staff_areas.changed`, and the other directory and delegation events) stay inside the tenant transaction and roll back with the effect.

Identity access (`withIdentityAccess`) never sets a general tenant. It sets `app.user_id` alone for membership self-read, or, for login-by-login-id only, sets the request tenant UUID as a scoping key. That key is not an authorisation claim. The password still decides. Rate-limit updates and failed-login rows are autocommit, so they survive a later rollback.

## Row level security

Migration `009_runtime_rls_hardening.sql` is forward-only. Migrations 001–008 are not edited.

Policies do not read an application mode GUC. A client that sets one changes nothing. Missing, empty, and malformed tenant or user values become NULL inside `app_current_tenant_id()` / `app_current_user_id()` and match no tenant policy.

For each tenant table the policies are:

- `*_tenant` — `FOR ALL TO figbloom_app`, `tenant_id = app_current_tenant_id()`.
- `*_owner` — `FOR ALL TO PUBLIC`, `current_user` is `pg_get_userbyid(relowner)` for that table. This is the table owner, not a name check against `figbloom_app`. `FORCE ROW LEVEL SECURITY` stays on, so the owner is constrained by this policy unless the role also has `BYPASSRLS` (the migrator on the test cluster does; `figbloom_app` must not).

`school_memberships` is `SELECT` only:

- Tenant policy: same tenant, `archived_at IS NULL`. A staff request in an authorised tenant can read other members of that tenant. It cannot read another tenant.
- Self-read `SELECT`: `user_id = app_current_user_id()` and the tenant GUC is NULL and the row is not archived. Used for “my memberships”, `/auth/me`, and select-tenant. A tenant-scoped request does not also expose the caller’s memberships in other schools.
- Writes are permission denied.

Archived memberships are hidden from `figbloom_app`. The owner can still archive and restore them.

Login-by-login-id residual: during that short scoped transaction the tenant policy can see every non-archived membership in the request tenant. The statement filters `login_id`.

`users.password_hash` remains readable by `figbloom_app` because login verifies the password in the application. There is no definer wrapper for that in this stage.

`SELECT … FOR UPDATE` on `school_memberships` needs `UPDATE`, which is not granted. Staff-area edits take `pg_advisory_xact_lock(hashtextextended('staff-areas:' || tenant || ':' || user, 0))` instead.

`security_audit_events` is `INSERT` only. There is no `SELECT` grant and no RLS policy, because the API has no read path. The append-only trigger still rejects `UPDATE` and `DELETE`.

## Grants

`REVOKE ALL` on tables and sequences from `PUBLIC` and from `figbloom_app`, then the minimum grants the code uses. No `TRUNCATE`, `REFERENCES`, or `TRIGGER`. `CREATE` on schema `public` is revoked from `PUBLIC` and from `figbloom_app`. `USAGE` on the schema is granted to `figbloom_app`.

`EXECUTE` is granted on `consume_rate_token(text, numeric, numeric, numeric, integer)`, `app_current_tenant_id()`, and `app_current_user_id()`. `prune_rate_buckets` is revoked; the API does not call it.

`REVOKE TEMPORARY ON DATABASE` is attempted and ignored when the migrator lacks the privilege. Tests do not depend on it. `CREATE` on the database is not granted to `figbloom_app`.

Foreign keys are checked by PostgreSQL as the table owner and are not an RLS bypass the application can choose. `guardian_links_active_learner_guard` stays `SECURITY DEFINER` (migration 008). Stage D is the definer inventory; it is not part of this change.

## Migrations

The runner takes session advisory lock `157301` with `pg_try_advisory_lock`, retrying for `MIGRATION_LOCK_TIMEOUT_MS` (default 15s, then exit code 2). It refuses to run as `figbloom_app`.

A NULL checksum is not backfilled during `--verify`. Apply writes one audit row with reason `null-checksum-backfill` and `old_checksum` text `(null)`, then stores the canonical hash. That reason is not the legacy CRLF reason `legacy-crlf-reconciliation`.

## What application code may import

`pg` may be imported only under `apps/api/src/db`. ESLint `no-restricted-imports` and `test/architecture.pg-import.test.ts` enforce that. A SQL injection that still reached `set_config` would be outside this boundary; application SQL stays parameterised.
