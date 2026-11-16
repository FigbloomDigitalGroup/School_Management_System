# API conventions (WP-A1 Stage E)

Status: implemented and tested locally. Not independently verified. Clients (web, mobile) are not edited by this work; this file is the integration handoff.

## Contract changes and what did NOT change

| Area | Change | Compatibility |
|---|---|---|
| Probes | `/livez` (new, no database), `/readyz` (new). `/health` and `/v1/health` no longer touch PostgreSQL | **Behaviour change** for the two health paths: they used to run `SELECT 1` and answer a generic 500 when the database was down. They now answer 200 while the process serves HTTP. Use `/readyz` for dependency health. Body of `/health` unchanged |
| Error bodies | additive `error.request_id` and optional `error.details[]` on validation failures | `error.code` and `error.message` unchanged; new code `idempotency_key_reused` (422) in the `code` enum; details never echo submitted values |
| Response headers | `X-Request-Id` on every response; security headers; `Cache-Control: no-store`; `Idempotent-Replayed: true` on a replay | additive |
| CORS | none unless `CORS_ALLOWED_ORIGINS` lists the caller's exact origin | **A browser app on another origin will be blocked until its origin is configured.** Existing server-to-server and same-origin callers are unaffected |
| Idempotency | optional `Idempotency-Key` on four POSTs | header-less requests unchanged |
| Session activity | `last_seen_at` written at most once per interval | no API change; the column is no longer a per-request timestamp |
| Pagination | keyset envelope `{ items, page: { limit, next_cursor } }` on list endpoints (FIG-1621 / AD-9) | **Response-shape change** for `/v1/org/schools`, `/v1/rbac/org-delegations`, `/v1/tenants/{t}/learners/{id}/guardians`, and `/v1/rbac/permissions` (`permissions` → `items` + `page`). No web/mobile client calls `apps/api` yet |

## Health and readiness

| Path | Meaning | Database | Status |
|---|---|---|---|
| `GET /livez`, `/health`, `/v1/health` | process is serving HTTP | never | 200 |
| `GET /readyz` | ready for traffic | one bounded `SELECT 1`, single-flight, cached `READINESS_CACHE_MS` (default 1000), budget `READINESS_TIMEOUT_MS` (default 2000) | 200 `{"status":"ready"}`; 503 `{"status":"draining"}` during shutdown; 503 `{"status":"unavailable"}` when the check fails or times out. `Retry-After` is set. No internal detail is returned |

Liveness never fails because PostgreSQL is down: an orchestrator must not restart a healthy process for that. The `/health` and `/v1/health` contract change (they no longer touch the database), its consumer impact and the shutdown behaviour are in `OPERATIONS.md` ("Health and readiness contract", "What no 5xx in a controlled restart means").

## Request correlation and logging

Every response carries `X-Request-Id` (also exposed to browsers through CORS). An inbound `X-Request-Id` is honoured only if it matches `[A-Za-z0-9._-]{8,64}`; otherwise a UUID is generated. Error bodies repeat it as `error.request_id`.

One structured logger (`src/log.ts`, JSON lines on stdout). Logged fields are an allowlist enforced at runtime: `request_id`, `method`, `route` (template, never the concrete URL), `status`, `duration_ms`, `tenant_id`, `user_id`, `error_code`, `error_class`, `sqlstate`, `outcome`, `reason`. Never logged: Authorization, cookies, tokens, passwords or hashes, request or response bodies, query-string values, IP addresses, names, e-mails, phones, admission numbers, dates of birth, idempotency payloads, connection strings, raw exception or driver messages. 5xx are logged by class and SQLSTATE only.

## Errors

Shape: `{ "error": { "code", "message", "request_id", "details?" } }`. Codes: `unauthorized`, `forbidden`, `not_found`, `validation_error`, `rate_limited`, `conflict`, `idempotency_key_reused`, `service_unavailable`, `internal_error`.

`details` (optional, OI-4 / FIG-1621) is an array of `{ field, code, message }` on some `validation_error` responses from the shared `parseOrThrow` helper. It never includes submitted values, secrets, SQL or stacks.

`service_unavailable` (503, `Retry-After`) covers pool exhaustion (acquire timeout), the transient SQLSTATEs `55P03`, `57014`, `25P03`, `40001`, `40P01`, `08000`, `08001`, `08003`, `08006`, `53300`, `57P01`, `57P03`, and connection-level failures (database refused, reset, closed, or the client-side read timeout). An unreachable or stalled database is therefore a 503 on login, on session validation and on every business endpoint, never a 500, and the body never carries driver text. There is **no automatic retry** inside the API. `GET /v1/tenants/:id` no longer turns every failure into 404: only a real not-found is 404.

## List pagination (FIG-1621 / AD-9)

> Cursor keys per endpoint: delegations and guardians carry `(created_at, id)`, permissions carry the permission code, and `/v1/org/schools` carries only the last school's id (organisation and school names have no length limit, so they are never embedded in a cursor; the boundary is read in SQL). An id that is not in the caller's own authorised set is rejected as `400 validation_error`, the same as one that no longer exists. Known trade-off of anchoring by id: renaming or deleting the last-seen school between two requests moves the boundary.

SQL keyset pagination (`src/http/pagination.ts`). Ordering and cursor comparisons happen in PostgreSQL (`ORDER BY` + keyset `WHERE` + `LIMIT n+1`). Envelope: `{ items, page: { limit, next_cursor } }` (plus route-specific metadata such as `tenantId` on org-delegations, or role flags on permissions).

| Query | Rules |
|---|---|
| `limit` | default 50; maximum 200; decimal integers only (`/^\d+$/`). Above 200, `0x10`, `1e2` ⇒ `400 validation_error` |
| `cursor` | opaque **v2** keyset cursor; keys are PostgreSQL text (timestamps keep microseconds). Bound to sort + filter + tenant/org scope fingerprint. Wrong version, wrong types, reuse across tenants/filters/sorts, truncation or tampering ⇒ `400 validation_error` |
| `sort` | fixed per endpoint; any other value ⇒ `400` (never silently ignored) |
| `status` (org-delegations only) | `active` (default; **behavioural change** vs pre-pagination), `revoked`, or `all` |

| Endpoint | SQL order | Notes |
|---|---|---|
| `GET /v1/org/schools` | `(o.name, t.name, t.id)` with `COLLATE "C"` | Locale-independent; matches predicate |
| `GET /v1/rbac/org-delegations` | `created_at DESC, id` | Mixed-direction predicate |
| `GET /v1/tenants/{t}/learners/{id}/guardians` | `(l.created_at, l.id)` | Link timestamps as µs UTC text |
| `GET /v1/rbac/permissions` | `unnest(codes) ORDER BY code` | Bounded catalogue; paged in SQL |

`GET /v1/auth/me` memberships are **not** paginated: the response shape is unchanged. At most 200 memberships are returned (write-time enforcement expected). Excess never produces HTTP 500.

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
| key older than 24 h | treated as absent and replaced atomically; deleting expired rows is housekeeping, never required. The operator runs `public.prune_idempotency_keys(grace, batch)` as the migrator (migration 013, `OPERATIONS.md` "Housekeeping"); the API cannot delete these rows |
| resource deleted after the original request | replay is 409 |
| not authorised / no longer authorised | refused as usual; a key never grants access; nothing is stored for a denied actor |

Stored per key: tenant, actor, key, route template, a **keyed HMAC-SHA256 fingerprint** (secret `IDEMPOTENCY_FINGERPRINT_KEY`, required outside local/test), resource reference, status, expiry. No request or response body.

## Session activity

`SESSION_LAST_SEEN_INTERVAL_SECONDS` (default 300, 0 = every request). Expiry, revocation, user, membership and school state are evaluated on every request; only the `last_seen_at` write is throttled, as one conditional `UPDATE` that concurrent requests cannot multiply.

## Request cancellation

When the HTTP client goes away before the response is finished, the in-flight PostgreSQL statement of that request is cancelled, its transaction rolls back and its connection is released with no context left behind. A request abandoned before `COMMIT` begins has no effect; once `COMMIT` has begun it is not cancelled, so a client that disconnected at that moment cannot know the outcome (use an idempotency key). Identity-path autocommit statements (login, rate limiting, session validation, readiness) are not cancelled on disconnect; they are short point statements bounded by their own limits. **Correction (WP-A1 review R-01):** earlier text said they were bounded by `STATEMENT_TIMEOUT_MS`. That was false: that limit is transaction-local and applies only to tenant transactions, and the identity path had no limit at all. They are now bounded by a per-connection baseline (`IDENTITY_STATEMENT_TIMEOUT_MS` 5 s, `IDENTITY_LOCK_TIMEOUT_MS` 2 s, installed when each pooled connection is created) plus a client-side backstop (`CLIENT_QUERY_TIMEOUT_MS` 20 s). A timeout, a lock wait or an unreachable database on that path is `503 service_unavailable` with `Retry-After: 1`. See `RUNTIME-DATABASE-SECURITY.md`, "Limits: what bounds what".

## Not done in this work package (recorded, not hidden)

- Optional covering indexes for keyset predicates (tenant/filter columns + order columns) when `EXPLAIN` on production-scale data shows a sequential sort. Do not edit applied migrations; add a new forward-only migration when needed. Suggested shapes: `(tenant_id, created_at DESC, id)` on `org_admin_school_delegations`; `(tenant_id, learner_id, created_at, id)` on `guardian_links`. Collections under test are small.
- Node 26: portable binary **v26.12.1** verified locally (typecheck, OpenAPI check, build, compiled `migrate --verify`, full API suite). SHA-256 of the official win-x64 zip matched `SHASUMS256.txt`. Clean install under Node 26 was **not** run. `engines` and CI Node pins unchanged pending OD-5 team confirmation. Details: `NODE-26-COMPATIBILITY.md`.
