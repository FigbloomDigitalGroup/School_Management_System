# Runtime database security

Status: implemented and tested on the API test database as `figbloom_app`. Not independently verified. Not a production provisioning record.

Two different database logins are required. They are not interchangeable.

| Connection | Environment variable | Role |
|---|---|---|
| API process | `DATABASE_URL` | `figbloom_app` (LOGIN only where the API runs) |
| Migrations | `MIGRATION_DATABASE_URL` | Migrator / table owner. Direct or session-mode. Never `figbloom_app`. |

`loadMigrationConfig()` does not fall back to `DATABASE_URL`. It refuses a URL whose user is the runtime role and refuses `pgbouncer=true` (transaction-mode pooling breaks the session advisory lock). The migrate command uses a pool of one connection named `figbloom-migrate`.

Migration 004 creates `figbloom_app` with `CREATE ROLE figbloom_app NOINHERIT`, only when the role does not exist. PostgreSQL's `CREATE ROLE` defaults every attribute not named to its negative form, so the role is created **`NOLOGIN`** (unlike `CREATE USER`), and also `NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`. This is verified, not assumed: `test/passwordSetter.test.ts` executes the statement from migration 004 verbatim under another name and asserts every attribute. Two limits of that migration are recorded and closed forward (migration 004 is applied history and cannot be edited, because its checksum is verified): it did not name `NOLOGIN` explicitly, and it never inspected a role that already existed. Migration 013 therefore **fails the migration, changing nothing,** if `figbloom_app` carries any of superuser, bypassrls, createrole, createdb, replication or inherit. It does not assert `LOGIN`, which operations enable out of band; a `LOGIN` role must have a password (`ALTER ROLE ... LOGIN PASSWORD`), never an empty one, and `assertRuntimeRole` checks the live role at every start. Migration 004 grants `figbloom_app` **to** the migrator. The reverse membership is forbidden. Startup calls `assertRuntimeRole` before `listen` and refuses to serve if the connected role is not exactly the configured `RUNTIME_ROLE` (default `figbloom_app`), if `current_user` differs from `session_user`, if the role is superuser / `BYPASSRLS` / `CREATEROLE` / `CREATEDB` / replication, if it owns anything in `public`, if it is a member of another role (including transitively, and including `pg_read_all_data` and the other predefined data roles), if it has `CREATE` on schema `public` or on the database, or if `SET ROLE postgres` or `SET SESSION AUTHORIZATION postgres` succeeds.

Tests turn `LOGIN` on with a random password for the life of the owner pool, then `ALTER ROLE figbloom_app NOLOGIN PASSWORD NULL` when that pool ends. The role is cluster-wide: only one suite may do this at a time (`fileParallelism` is false).

## Pool budget

`POOL_MAX` defaults to 10. Values above 20 are rejected. 20 is a safety ceiling, not a recommended production size.

```
pool_max <= floor((max_connections - reserved_superuser - migrator_sessions) / api_task_count)
```

Keep the sum of every API task’s `POOL_MAX`, plus migrator sessions and superuser reserve, under the server’s `max_connections`.

Cancellation side connections: when an HTTP client disconnects mid-request, the cancel (`pg_cancel_backend`) uses one short-lived, unpooled connection per aborted transaction (`application_name = figbloom-api-cancel`, 2 s connect timeout, closed straight after). Worst case that is up to `POOL_MAX` extra connections per instance during a mass disconnect, so the budget above should leave headroom: `pool_max + pool_max <= max_connections share`, or accept that mass-disconnect cancels may fail (best effort; the statement still ends at its own `STATEMENT_TIMEOUT_MS`).

### Limits: what bounds what

Four different bounds, deliberately not one blanket timeout:

| Bound | Applies to | Mechanism | Default |
|---|---|---|---|
| Connection acquisition | every path | `POOL_ACQUIRE_TIMEOUT_MS`, then 503 | 2000 ms |
| Tenant transaction limits | `withTenantTransaction`, `withIdentityUserScope` | `set_config(..., true)` after `BEGIN` (transaction-local, pooler-safe): `STATEMENT_TIMEOUT_MS` / `LOCK_TIMEOUT_MS` / `IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS` | 15000 / 5000 / 15000 ms |
| **Identity-path baseline** (login, rate limiting, session validation on every authenticated request, readiness) | every autocommit statement on a pooled connection | session-level `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout` installed once per **new** connection by the pool's `verify` hook (`IDENTITY_STATEMENT_TIMEOUT_MS`, `IDENTITY_LOCK_TIMEOUT_MS`, `IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS`). A failed install destroys the connection and fails the checkout, so a connection without limits is never used. A tenant transaction overrides them for its duration and the connection reverts to this baseline afterwards | 5000 / 2000 / 15000 ms |
| Client-side backstop | every query | pg `query_timeout` (`CLIENT_QUERY_TIMEOUT_MS`) for a stalled network, where no server-side timer can fire. Must exceed both statement timeouts (refused at startup otherwise). `/readyz` uses its own, shorter `READINESS_TIMEOUT_MS` | 20000 ms |

Session-level settings, not startup parameters: a pooler that rejects unknown startup parameters still works, and every client of one pool receives identical values. If a transaction-mode pooler shares server connections between *different applications*, give this application its own pooler pool.

A connection is **destroyed, never reused** (`src/db/clientHealth.ts`) when a query failed at the client level (read timeout, reset, closed socket, SQLSTATE class 08 or 57P) or still has a query in flight when its owner finishes (for example an abandoned `Promise.race`). A tenant transaction whose connection stalled does not queue a `ROLLBACK` behind the stuck statement: it destroys the connection, and closing the socket ends the transaction on the server. An ordinary database error, including a server-side timeout or our own cancel (57014), leaves the connection clean and it returns to the pool. There is no automatic retry anywhere, and a readiness probe is single-flight and cached, so an outage cannot multiply reconnection attempts.

SQLSTATEs `55P03`, `57014`, `25P03`, `40001`, `40P01`, `08000`, `08001`, `08003`, `08006`, `53300`, `57P01`, and `57P03` map to the same 503, and so does a connection-level failure (refused, reset, closed, client-side read timeout): the database being unreachable or too slow is `503 service_unavailable` with `Retry-After`, never a 500. The client body does not include the driver text. Nested transactions and a second tenant assignment are refused in the application and become an opaque 500; the transaction is rolled back.

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

Identity access (`withIdentityAccess`, `withIdentityUserScope`) never sets a tenant. `withIdentityUserScope` sets `app.user_id` alone for membership self-read. Login by login id sets **no** context at all (migration 011, below). Rate-limit updates and failed-login rows are autocommit, so they survive a later rollback.

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

### Credential access (migrations 011 and 013; closes F-C1, F-C2 and review R-02)

`figbloom_app` has **no** table-level privilege on `users`, **no** `SELECT` on `users.password_hash`, and (since migration 013) **no `UPDATE` privilege of any kind on `users`**: it holds column-level `SELECT` on the eight non-secret columns and nothing else. No statement can read the hash, and no statement can write it. A column added to `users` later is neither readable nor writable by the runtime role until a migration grants it.

History, because the migration text alone is easy to misread: migration 009 granted table-level `SELECT, UPDATE ON users`; migration 011 revoked that and granted column-level `SELECT` on eight columns and `UPDATE` on `password_hash`, `must_change_password` and `updated_at`; migration 013 revoked those `UPDATE` privileges. The effective state, asserted from PostgreSQL's own privilege functions in `test/grants.matrix.test.ts` and `test/passwordSetter.test.ts`, is the last one. (A review found the `UPDATE (password_hash)` grant to be a write primitive: `users` has no RLS, so arbitrary SQL as the runtime role could overwrite any account's hash, a super admin's included, silently.)

**The only write path** is `public.auth_change_own_password(session_id, expected_hash, new_hash, ip)` (migration 013): `SECURITY DEFINER`, owner the migrator, `search_path = pg_catalog, pg_temp`, schema-qualified, `EXECUTE` for `figbloom_app` only. It takes a **session**, not a user: the account is read from that session row (unrevoked, unexpired, user active), so a caller cannot name a victim. It is a compare-and-swap on the current hash the API just verified (a stale or concurrent change fails), accepts only a well-formed `scrypt$...` hash, and in the same transaction revokes the user's other sessions and writes the `auth.password.changed` audit row (no hash in it). It returns `false` and changes nothing for every refusal. Hashing is unchanged (scrypt, in Node); only the write moved into the database.

**Residual, stated plainly.** The database does not defend against arbitrary SQL running as `figbloom_app` (the approved model). User ids (including the super-admin id via `platform_roles`) are readable. The runtime role can `INSERT` into `sessions` for an arbitrary user — that alone is impersonation, including of super admin, with no password change. The setter chain is therefore optional for takeover. When the setter is used, the audit row names the **victim** as actor and carries a caller-supplied IP; it does not identify the initiating attacker. Migration 013 removed the silent bulk hash-overwrite primitive; it did not contain session minting. Full detail, containment options (OD-1) and the production-data restriction: `R-02-RESIDUAL-RISK.md`.

The hash is reachable (read) only through three `SECURITY DEFINER` functions (owner: the migrator; `search_path = pg_catalog, pg_temp`; schema-qualified; `EXECUTE` for `figbloom_app` only), each taking an exact key and returning `(user id, hash, status)` for at most that key:

| Function | Used by |
|---|---|
| `auth_credential_by_email(email)` | login by e-mail |
| `auth_credential_by_login_id(tenant, login_id)` | login by login id |
| `auth_password_credential(user_id)` | password change (the caller's own id from the session) |

**Login by login id no longer sets any tenant context.** The Stage C window (the request tenant UUID as `app.tenant_id` while one statement filtered `school_memberships` by login id) is gone: the function joins memberships as the table owner (the positive owner policy), and the tenant is only an argument, not an authorisation claim. Authentication semantics are unchanged: uniform invalid-credentials responses, decoy scrypt on unknown paths, rate limits, status check, archived memberships excluded.

**Accepted residual.** Arbitrary SQL executing as `figbloom_app` can still call these functions with a *known* e-mail, a known (school, login id) or a known user id and obtain that one account's scrypt hash. That equals what the login endpoint already gives an attacker for a guess; there is no argument that matches many accounts, so bulk exfiltration is no longer possible. Failed-login audit detail never contains the hash, and no API response returns it. There is still no `INSERT` grant on `users`.

`SELECT … FOR UPDATE` on `school_memberships` needs `UPDATE`, which is not granted. Staff-area edits take `pg_advisory_xact_lock(hashtextextended('staff-areas:' || tenant || ':' || user, 0))` instead.

`security_audit_events` is `INSERT` only. There is no `SELECT` grant and no RLS policy, because the API has no read path. The append-only trigger still rejects `UPDATE` and `DELETE`.

## Grants

`REVOKE ALL` on tables and sequences from `PUBLIC` and from `figbloom_app`, then the minimum grants the code uses. No `TRUNCATE`, `REFERENCES`, or `TRIGGER`. `CREATE` on schema `public` is revoked from `PUBLIC` and from `figbloom_app`. `USAGE` on the schema is granted to `figbloom_app`.

`EXECUTE` is granted to `figbloom_app` only on `consume_rate_token(text, numeric, numeric, numeric, integer)`, `app_current_tenant_id()`, `app_current_user_id()`, the three credential read functions and `auth_change_own_password` above; `PUBLIC` has `EXECUTE` on none of them (migrations 010, 011 and 013). `prune_rate_buckets`, `prune_idempotency_keys` and every trigger function are not executable by the runtime role.

Definer ownership requirement (review R-10): the definers run with their **owner's** privileges. Locally and in CI that owner is the `postgres` superuser, which is acceptable only for synthetic data. Before any environment holds real data, the migrator must be a **dedicated non-superuser** that owns the application schema objects and has no `BYPASSRLS` beyond what the owner policies need; a superuser-owned definer turns any future definer bug into a full-database primitive. This is a staging security sign-off item (FIG-1605), not enforced by code. Functions the migrator creates later are not `PUBLIC`-executable by default (`ALTER DEFAULT PRIVILEGES`, migration 010).

`REVOKE TEMPORARY ON DATABASE` is attempted for `PUBLIC` and `figbloom_app`. When the migrator lacks the privilege, migration 009 raises a notice and continues. The grants-matrix and Stage C ownership suites **assert** the effective privilege with `has_database_privilege(..., 'TEMPORARY')` and a failed `CREATE TEMP TABLE` as `figbloom_app`. If those assertions fail on a managed host, the residual risk is temporary-table creation by the runtime role inside its own session (not an RLS bypass of permanent tenant tables); record the host limitation rather than deleting the assertion. `CREATE` on the database is not granted to `figbloom_app`.

Foreign keys are checked by PostgreSQL as the table owner and are not an RLS bypass the application can choose. `guardian_links_active_learner_guard` stays `SECURITY DEFINER` (migration 008), hardened by migration 010 together with the other definers: `search_path = pg_catalog, pg_temp` (pg_temp explicitly last, `public` deliberately absent), schema-qualified references, migrator ownership, no `PUBLIC` `EXECUTE`. The complete function inventory and the temp-table shadowing evidence are in `SECURITY-DEFINER-INVENTORY.md`.

## Migrations

The runner takes session advisory lock `157301` with `pg_try_advisory_lock`, retrying for `MIGRATION_LOCK_TIMEOUT_MS` (default 15s, then exit code 2). It refuses to run as `figbloom_app`.

A NULL checksum is not backfilled during `--verify`. Apply writes one audit row with reason `null-checksum-backfill` and `old_checksum` text `(null)`, then stores the canonical hash. That reason is not the legacy CRLF reason `legacy-crlf-reconciliation`.

## What application code may import

`pg` may be imported only under `apps/api/src/db`. ESLint `no-restricted-imports` and `test/architecture.pg-import.test.ts` enforce that. A SQL injection that still reached `set_config` would be outside this boundary; application SQL stays parameterised.
