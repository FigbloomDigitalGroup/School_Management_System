# API conventions (WP-A1 Stage E)

Status: implemented and tested locally. Not independently verified. Clients (web, mobile) are not edited by this work; this file is the integration handoff.

## Contract changes and what did NOT change

| Area | Change | Compatibility |
|---|---|---|
| Probes | `/livez` (new, no database), `/readyz` (new). `/health` and `/v1/health` no longer touch PostgreSQL | **Behaviour change** for the two health paths: they used to run `SELECT 1` and answer a generic 500 when the database was down. They now answer 200 while the process serves HTTP. Use `/readyz` for dependency health. Body of `/health` unchanged |
| Error bodies | additive `error.request_id` | `error.code` and `error.message` unchanged; new code `idempotency_key_reused` (422) in the `code` enum |
| Response headers | `X-Request-Id` on every response; security headers; `Cache-Control: no-store`; `Idempotent-Replayed: true` on a replay | additive |
| CORS | none unless `CORS_ALLOWED_ORIGINS` lists the caller's exact origin | **A browser app on another origin will be blocked until its origin is configured.** Existing server-to-server and same-origin callers are unaffected |
| Idempotency | optional `Idempotency-Key` on four POSTs | header-less requests unchanged |
| Session activity | `last_seen_at` written at most once per interval | no API change; the column is no longer a per-request timestamp |
| Pagination | **not changed**: no list endpoint has been converted yet (see "Not done") | unchanged |

## Health and readiness

| Path | Meaning | Database | Status |
|---|---|---|---|
| `GET /livez`, `/health`, `/v1/health` | process is serving HTTP | never | 200 |
| `GET /readyz` | ready for traffic | one bounded `SELECT 1`, single-flight, cached `READINESS_CACHE_MS` (default 1000), budget `READINESS_TIMEOUT_MS` (default 2000) | 200 `{"status":"ready"}`; 503 `{"status":"draining"}` during shutdown; 503 `{"status":"unavailable"}` when the check fails or times out. `Retry-After` is set. No internal detail is returned |

Liveness never fails because PostgreSQL is down: an orchestrator must not restart a healthy process for that.

## Request correlation and logging

Every response carries `X-Request-Id` (also exposed to browsers through CORS). An inbound `X-Request-Id` is honoured only if it matches `[A-Za-z0-9._-]{8,64}`; otherwise a UUID is generated. Error bodies repeat it as `error.request_id`.

One structured logger (`src/log.ts`, JSON lines on stdout). Logged fields are an allowlist enforced at runtime: `request_id`, `method`, `route` (template, never the concrete URL), `status`, `duration_ms`, `tenant_id`, `user_id`, `error_code`, `error_class`, `sqlstate`, `outcome`, `reason`. Never logged: Authorization, cookies, tokens, passwords or hashes, request or response bodies, query-string values, IP addresses, names, e-mails, phones, admission numbers, dates of birth, idempotency payloads, connection strings, raw exception or driver messages. 5xx are logged by class and SQLSTATE only.

## Errors

Shape: `{ "error": { "code", "message", "request_id" } }`. Codes: `unauthorized`, `forbidden`, `not_found`, `validation_error`, `rate_limited`, `conflict`, `idempotency_key_reused`, `service_unavailable`, `internal_error`.

`service_unavailable` (503, `Retry-After`) covers pool exhaustion (acquire timeout) and the transient SQLSTATEs `55P03`, `57014`, `25P03`, `40001`, `40P01`, `08000`, `08001`, `08003`, `08006`, `53300`, `57P01`, `57P03`. There is **no automatic retry** inside the API. `GET /v1/tenants/:id` no longer turns every failure into 404: only a real not-found is 404.

## Headers and CORS

Every response: `Content-Security-Policy: default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, no `X-Powered-By`. `Strict-Transport-Security` only when `HSTS_ENABLED=true` (set it only where TLS terminates for this host).

CORS: exact origins from `CORS_ALLOWED_ORIGINS` (comma-separated `scheme://host[:port]`; wildcards, `null`, paths and trailing slashes are refused at startup). Default empty = no CORS headers. Credentials are never allowed (the API uses a bearer token, not cookies). Allowed methods `GET, POST, PUT, DELETE`; allowed headers `Authorization, Content-Type, Idempotency-Key, X-Request-Id, X-Tenant-Id`; exposed `X-Request-Id, Retry-After, Idempotent-Replayed`; preflight cache `CORS_MAX_AGE_SECONDS` (default 600).

Server timeouts: keep-alive 65 s (must exceed the load balancer idle timeout), headers 66 s, request 30 s, body limit 64 KiB.

## Idempotency-Key

Optional on `POST /v1/tenants/{t}/learners`, `POST /v1/tenants/{t}/guardians`, `POST /v1/tenants/{t}/guardians/{g}/links` and `POST /v1/rbac/org-delegations`. Key: 8-128 characters from `A-Z a-z 0-9 . _ : -` (400 otherwise).

**Guarantee: at most one committed effect per (school, caller, key) within 24 hours.** It is not exactly-once across client, network or process failures: a client that never saw the outcome retries with the same key and gets the original outcome (replay) or, if the first attempt rolled back, a fresh execution.

| Situation | Result |
|---|---|
| first request | executes; effect, audit event and key record commit together |
| same key, same request | original status, resource re-read by reference (it reflects the resource's **current** state; the guardian create-view still carries no contact fields), `Idempotent-Replayed: true`, no second effect or audit event |
| same key, different request or route | 422 `idempotency_key_reused` |
| concurrent duplicates | one effect; the others wait for the first transaction, then replay (or proceed if it rolled back) |
| first attempt failed | rolled back, nothing stored, the key is free |
| key older than 24 h | treated as absent and replaced atomically; deleting expired rows is housekeeping, never required |
| resource deleted after the original request | replay is 409 |
| not authorised / no longer authorised | refused as usual; a key never grants access; nothing is stored for a denied actor |

Stored per key: tenant, actor, key, route template, a **keyed HMAC-SHA256 fingerprint** (secret `IDEMPOTENCY_FINGERPRINT_KEY`, required outside local/test), resource reference, status, expiry. No request or response body.

## Session activity

`SESSION_LAST_SEEN_INTERVAL_SECONDS` (default 300, 0 = every request). Expiry, revocation, user, membership and school state are evaluated on every request; only the `last_seen_at` write is throttled, as one conditional `UPDATE` that concurrent requests cannot multiply.

## Request cancellation

When the HTTP client goes away before the response is finished, the in-flight PostgreSQL statement of that request is cancelled, its transaction rolls back and its connection is released with no context left behind. A request abandoned before `COMMIT` begins has no effect; once `COMMIT` has begun it is not cancelled, so a client that disconnected at that moment cannot know the outcome (use an idempotency key). Identity-path autocommit statements (login, rate limiting) are short and bounded by `STATEMENT_TIMEOUT_MS`; they are not cancelled on disconnect.

## Not done in this work package (recorded, not hidden)

- **Keyset pagination and the single list envelope (FIG-1621, AD-9)**: not implemented. No list endpoint (`/v1/org/schools`, `/v1/rbac/org-delegations`, `/v1/tenants/{t}/learners/{id}/guardians`, `/v1/rbac/permissions`, `/v1/auth/me` memberships) has changed shape; their consumers have not been assessed. This is a response-shape change for clients and needs that assessment first.
- Field-level `details[]` in validation errors and one shared validation helper: not implemented. Validation messages remain the fixed strings they were.
- `EXPLAIN` evidence per paginated endpoint (E12): not applicable until pagination exists. Statement-count changes made: per-transaction limits are one statement instead of three; session validation is one statement instead of two (and usually no write).
- Node 26: not verified (no Node 26 runtime, no team confirmation); `engines` and `@types/node` unchanged.
