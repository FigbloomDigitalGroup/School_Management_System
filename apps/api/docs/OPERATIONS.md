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
| `APP_ENV` | `local` | `local|test|staging|production`. `NODE_ENV=production` without it is refused. In staging/production `.env` is never read. **If both `APP_ENV` and `NODE_ENV` are unset the process runs as `local`: it reads `.env` and the strict checks are off. By design, but deployment manifests must set `APP_ENV` explicitly** (review R-12) |
| `DATABASE_URL` | required | user must equal `RUNTIME_ROLE`. Non-loopback in staging/production needs `sslmode=verify-full` (or `verify-ca`) |
| `MIGRATION_DATABASE_URL` | migrate only | refused in the API process in staging/production |
| `RUNTIME_ROLE` | `figbloom_app` | startup asserts the live role (not superuser, no BYPASSRLS, owns nothing, no inherited roles, cannot `SET ROLE`) |
| `IDEMPOTENCY_FINGERPRINT_KEY` | required in staging/production | 32+ characters, from the secret store; never logged |
| `IDEMPOTENCY_TTL_SECONDS` | 86400 | |
| `POOL_MAX` | 10 | refused above 20 |
| `POOL_ACQUIRE_TIMEOUT_MS` | 2000 | acquisition only; then 503 |
| `STATEMENT_TIMEOUT_MS`, `LOCK_TIMEOUT_MS`, `IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS` | 15000 / 5000 / 15000 | per tenant transaction (`set_config(..., true)`), pooler-safe |
| `IDENTITY_STATEMENT_TIMEOUT_MS`, `IDENTITY_LOCK_TIMEOUT_MS` | 5000 / 2000 | baseline of every pooled connection for the autocommit identity path (login, rate limiting, session validation, readiness); idle-in-transaction uses the value above. Installed when each connection is created |
| `CLIENT_QUERY_TIMEOUT_MS` | 20000 | client-side per-query backstop for a stalled network; must exceed both statement timeouts (startup refuses otherwise). A connection that hits it is destroyed, not reused |
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

### What "no 5xx in a controlled restart" means (FIG-1617, review R-05)

It is a precise guarantee, not "nothing can ever fail". Tested over a real socket in `test/lifecycle.restart.test.ts`:

| Situation | Behaviour |
|---|---|
| request admitted before shutdown, finishes within `SHUTDOWN_GRACE_MS` | its normal response; a database write it made is durable |
| request during the drain delay | served normally (the listener is still open). The only 503 is `/readyz` `{"status":"draining"}` with `Retry-After: 5` |
| new connection after the listener closed | refused at TCP level (connection refused). Not an HTTP status; a load balancer that has stopped routing never sees it |
| request that outlives the grace period | the connection is cut (no response); its transaction is rolled back, so there is **no partial write**; no backend of the process keeps running; exit code 1 |
| request on an already-open keep-alive connection while the listener is closing | dropped at the socket, or answered `503` with `Connection: close` by the HTTP framework before any handler runs (its body is Fastify's, not the standard error shape). Never a 500, never a partial effect. Retry on another instance |
| database stalls during shutdown | stalled connections are destroyed by the client-side read timeout, so the pool still ends; exit code 1; `SHUTDOWN_HARD_TIMEOUT_MS` is the last resort |
| unplanned database outage while serving | `503 service_unavailable` with `Retry-After: 1` (never 500) |
| unexpected defect | the opaque 500 `internal_error`, logged by class and SQLSTATE only |

**Drain delay.** The default `SHUTDOWN_DRAIN_DELAY_MS=0` closes the listener at once. A load balancer that polls `/readyz` every N seconds then routes new requests to a closing instance for up to N seconds, and those get connection errors. **For a rolling deploy set `SHUTDOWN_DRAIN_DELAY_MS` to at least the balancer's health-check interval times its unhealthy threshold**, and keep `SHUTDOWN_HARD_TIMEOUT_MS` above grace plus drain (startup refuses otherwise). Nothing in this repository configures a balancer; the value belongs in the deployment manifest.

## Connection budget: cancellation side connections

Cancelling a request whose client disconnected opens one short-lived, unpooled connection per aborted transaction (`figbloom-api-cancel`). In a mass disconnect that is up to `POOL_MAX` extra connections per instance for about a second. Leave that headroom in the database `max_connections` budget (review R-06); if the cancel connection cannot be opened the cancel is skipped and the statement ends at its own statement timeout.

## Housekeeping (run by an operator, as the migrator)

Not run by the API, not required for correctness. Idempotency rows older than their 24 h validity are ignored at lookup and replaced by the claim, but they accumulate:

```sql
SELECT public.prune_idempotency_keys(interval '0', 10000);   -- repeat until it returns 0
SELECT public.prune_rate_buckets(interval '1 day');
```
`prune_idempotency_keys(grace, batch)` deletes only expired rows, at most `batch` per call, and keeps rows expired less than `grace` ago. Schedule it (for example daily) from the platform's scheduler; there is deliberately no in-process timer. The runtime role cannot execute either function.

Session proof nonces (migration 014/015) are also operator-purged, hourly is ample:

```
node scripts/session-hmac.mjs purge-nonces --batch 1000 --max-batches 50
```
A nonce is deleted only when its expiry has passed and it is over an hour old, so replay protection is never weakened; batches skip locked rows and stay short. Provisioning and rotation of the HMAC secret are in `SESSION-HMAC-PROVISIONING.md`.

## Health and readiness contract (review: `/health` change)

| Path | Meaning | Use it for | Database |
|---|---|---|---|
| `/livez`, `/health`, `/v1/health` | the process is serving HTTP | orchestrator **liveness**: restart a process only when this fails | never; they stay 200 during a database outage and during drain |
| `/readyz` | ready to take traffic | load-balancer **readiness**; deployment gates | one bounded `SELECT 1` (acquire budget, server baseline, client read timeout), single-flight, cached `READINESS_CACHE_MS` |

`/readyz` additionally runs the session-mint HMAC self-test (migration 015). A database with no provisioned secret, or one that does not match this process's `SESSION_MINT_HMAC_KEY`, answers 503 `{"status":"unavailable","reason":"configuration"}` (cause logged, no key material), so a deployment is not ready merely because migration 014 exists.

`/health` and `/v1/health` used to run `SELECT 1` and returned a generic 500 on database failure. They now behave like `/livez` (same body, same status), identically in both API versions. **Consumer impact:** anything that polled `/health` to learn whether PostgreSQL was reachable now sees 200 while the database is down and must poll `/readyz` instead. No consumer exists in this repository (the web and mobile clients do not call `apps/api` yet; GRAPH Stage 15), and no deployment manifest exists to update; `GET /health` is documented in `openapi/openapi.yaml`. Tests: `test/lifecycle.http.test.ts` (database down: liveness 200, readiness 503, bounded, no internal detail) and `test/identityBounds.test.ts` (a stalled network).

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
| 503 on login or every authenticated request, `/livez` 200 | database too slow or locked on the identity path (identity statement or lock timeout) or unreachable; check `pg_stat_activity` for a long lock holder on `sessions` or `auth_rate_buckets` |

## Deployment prerequisites (not performed)

PostgreSQL with the migrator and `figbloom_app` roles provisioned out of band; secrets from a secret store; TLS to the database; a load balancer health check on `/readyz`; Node runtime matching `engines` (`>=20`; verified on 24.16.0 only); no Redis, queue or worker is required or provided; housekeeping (idempotency keys, rate buckets, proof nonces) is operator-scheduled. **Before the first start with migration 014/015:** provision the session-mint HMAC secret and set `SESSION_MINT_HMAC_KEY` (`SESSION-HMAC-PROVISIONING.md`); `/readyz` stays 503 until they match.
