# API operations (WP-A1 Stage E)

Status: written from the implemented and locally tested behaviour. No deployment exists; nothing here has run on hosted infrastructure.

## Run

```
npm run build --workspace @figbloom/api          # tsc -> dist (tests excluded)
npm run migrate --workspace @figbloom/api        # node dist/db/migrate.js, as the migrator
npm run start --workspace @figbloom/api          # node dist/index.js, as figbloom_app
```
Production never runs `tsx`. Two credentials, two entrypoints: the API reads `DATABASE_URL` only (role `figbloom_app`); migrate reads `MIGRATION_DATABASE_URL` only (direct or session-mode connection, never a transaction-mode pooler). See `README.md` and `RUNTIME-DATABASE-SECURITY.md`.

## Configuration reference (`env.example` has the template)

| Variable | Default | Notes |
|---|---|---|
| `APP_ENV` | `local` | `local|test|staging|production`. `NODE_ENV=production` without it is refused. In staging/production `.env` is never read |
| `DATABASE_URL` | required | user must equal `RUNTIME_ROLE`. Non-loopback in staging/production needs `sslmode=verify-full` (or `verify-ca`) |
| `MIGRATION_DATABASE_URL` | migrate only | refused in the API process in staging/production |
| `RUNTIME_ROLE` | `figbloom_app` | startup asserts the live role (not superuser, no BYPASSRLS, owns nothing, no inherited roles, cannot `SET ROLE`) |
| `IDEMPOTENCY_FINGERPRINT_KEY` | required in staging/production | 32+ characters, from the secret store; never logged |
| `IDEMPOTENCY_TTL_SECONDS` | 86400 | |
| `POOL_MAX` | 10 | refused above 20 |
| `POOL_ACQUIRE_TIMEOUT_MS` | 2000 | acquisition only; then 503 |
| `STATEMENT_TIMEOUT_MS`, `LOCK_TIMEOUT_MS`, `IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS` | 15000 / 5000 / 15000 | per transaction (`set_config(..., true)`), pooler-safe |
| `SESSION_TTL_SECONDS` | 43200 | |
| `SESSION_LAST_SEEN_INTERVAL_SECONDS` | 300 | 0 = write every request |
| `READINESS_CACHE_MS`, `READINESS_TIMEOUT_MS` | 1000 / 2000 | |
| `SHUTDOWN_DRAIN_DELAY_MS`, `SHUTDOWN_GRACE_MS`, `SHUTDOWN_HARD_TIMEOUT_MS` | 0 / 10000 / 15000 | hard must exceed grace + drain |
| `CORS_ALLOWED_ORIGINS`, `CORS_MAX_AGE_SECONDS`, `HSTS_ENABLED` | empty / 600 / false | |
| `SERVER_KEEP_ALIVE_TIMEOUT_MS`, `SERVER_HEADERS_TIMEOUT_MS`, `SERVER_REQUEST_TIMEOUT_MS` | 65000 / 66000 / 30000 | keep-alive above the load balancer idle timeout; headers above keep-alive |
| `API_HOST`, `API_PORT`, `AUTH_RATE_*`, `API_TRUST_PROXY_HOPS`, `API_TRUST_PROXY_CIDRS` | see template | proxy trust needs hops and CIDRs together |

Configuration errors name the variable, never a value. Secrets are never written to logs.

## Pool budget (no number is invented)

```
pool_max <= floor((max_connections - reserved_superuser - migrator_sessions) / api_task_count)
```
with a transaction-mode pooler in front, divide by the pooler's server-side pool size instead. Each request holds one connection for the whole tenant transaction, so there must be no external calls inside handlers. A saturated pool answers 503 within `POOL_ACQUIRE_TIMEOUT_MS`.

## Shutdown (SIGTERM / SIGINT)

1. `/readyz` flips to 503 `draining`; optional `SHUTDOWN_DRAIN_DELAY_MS` lets the load balancer stop routing.
2. The listener closes; in-flight requests get `SHUTDOWN_GRACE_MS`.
3. Idle connections close; past the grace period the remaining ones are force-closed and the exit code is 1.
4. The pool ends. `SHUTDOWN_HARD_TIMEOUT_MS` forces `exit(1)` if anything hangs. Repeated signals share one sequence. A listen failure still closes the pool. `unhandledRejection` / `uncaughtException` stop serving and exit 1.

On Windows, signals are not delivered like POSIX; the sequence is tested through the `shutdown()` API and not through OS signals on this machine.

## Migrations

Forward-only; the runner takes a session advisory lock with a bounded wait (`MIGRATION_LOCK_TIMEOUT_MS`, default 15 s, exit code 2). A changed already-applied migration is refused (checksum). Run it with a direct or session-mode connection as the migrator. `migrate:verify` is read-only. Rollback is by a new forward migration or a database restore, never an edited file. The runtime role cannot touch migration history.

## Troubleshooting

| Symptom | Check |
|---|---|
| API refuses to start with "Unsafe runtime role" | `DATABASE_URL` must connect as `figbloom_app` with no BYPASSRLS/superuser/owned objects/inherited roles |
| `Invalid API config: ... sslmode` | non-loopback database outside local/test needs `sslmode=verify-full` |
| `migrate` says `MIGRATION_DATABASE_URL is required` | it never falls back to `DATABASE_URL` |
| Browser calls blocked | add the exact origin to `CORS_ALLOWED_ORIGINS` |
| Every tenant query returns nothing | tenant context missing: the request did not go through `withTenantTransaction` |
| 503 with `Retry-After` | pool exhausted or a transient SQLSTATE (see API-CONVENTIONS.md); look for `request_failed` log lines with `sqlstate` |
| `/readyz` 503 but `/livez` 200 | database unreachable or the process is draining |

## Deployment prerequisites (not performed)

PostgreSQL with the migrator and `figbloom_app` roles provisioned out of band; secrets from a secret store; TLS to the database; a load balancer health check on `/readyz`; Node runtime matching `engines` (`>=20`; verified on 24.16.0 only); no Redis, queue, worker or scheduler is required or provided.
