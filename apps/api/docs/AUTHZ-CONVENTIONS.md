# Authorization conventions (P1-A / FIG-1573)

## Principles

1. **Authentication ≠ authorization.** Sessions prove identity; permissions prove access.
2. **Default deny.** Missing tenant context, membership, or permission → `403 forbidden`.
3. **Server-enforced.** UI nav and client state never authorize.
4. **No client evidence.** Request bodies must not supply the caller’s `permissions` list as authority. Roles come from membership / platform tables.
5. **Tenant from trust.** Active tenant is the session's, or an `X-Tenant-Id` the caller proves access to. Access is re-derived from membership / organisation / platform tables on **every** request (never cached in the token), so archiving a membership, suspending a school, disabling a user or revoking a grant takes effect on the very next call. A bare `X-Tenant-Id` without access is denied; a non-UUID value is `400`.
6. **Suspension is live.** Members and org admins of a suspended school get `403` immediately, not only at sign-in. Platform `super_admin` may still act there (support / unsuspend).
7. **Identity-only endpoints.** `logout`, `select-tenant` and `/auth/me` need a valid session but not a usable school, so a caller whose school was archived/suspended (or who has several schools and has not chosen one) can still switch or sign out.

## Headers

| Header | Meaning |
|---|---|
| `Authorization: Bearer <token>` | Opaque session token (hash stored server-side) |
| `X-Tenant-Id` | Optional request-scoped tenant when membership (or org/platform acting-as) is valid |

## Standard failures

| HTTP | `error.code` | When |
|---|---|---|
| 401 | `unauthorized` | Missing/invalid/expired/revoked session; bad credentials |
| 403 | `forbidden` | No membership, cross-tenant, missing permission, suspended school |
| 400 | `validation_error` | Malformed payload |
| 404 | `not_found` | Unknown school / membership (not the same as suspended) |
| 429 | `rate_limited` | Auth token-bucket exhausted; `Retry-After` when waiting can help |
| 500 | `internal_error` | Unexpected; **no** SQL/stack in body |

## OpenAPI extensions

- `x-figbloom-authz`: `public` \| `authenticated` \| `permission`
- `x-figbloom-permissions`: permission codes required
- `x-figbloom-tenantScope`: where tenant is taken from (`session`, `path.*`, `requestBody.*`, `none`)

## Rate limiting

Postgres token bucket (`consume_rate_token`): capacity 5, starts full, +2 tokens per 5 s, cost 1 per login attempt (weighted `cost` supported). **Order:** per-IP bucket is consumed first, then the account bucket (R2-03), so an exhausted IP limit never creates account-bucket rows. Atomic across API instances (row lock, database clock). Not yet applied to non-auth endpoints.

**Client address (R2-01 / R2-02).** Default: socket address only; `X-Forwarded-For` ignored. To trust proxies, set **both** `API_TRUST_PROXY_HOPS` (positive hop count) and `API_TRUST_PROXY_CIDRS` (comma-separated CIDRs of those proxies). Boolean `API_TRUST_PROXY=true` is rejected. IPv6 zone identifiers are rejected (normalized to null) and never written to `inet` columns.

**Suspended schools.** Members and org admins cannot select or act in a suspended school. Platform `super_admin` may select a suspended school for ops (aligned with live acting-as). A nonexistent school returns `404`, not “suspended”.

## Organization administrators (R2-05 approved)

- Org admins get **aggregate** school lists via `GET /v1/org/schools` (`org.tenants.read`).
- They do **not** automatically `mayAdminister` inside a member school.
- School-level powers require rows in `org_admin_school_delegations` (granular, school-scoped, revocable, audited).
- Permission metadata: `GET /v1/rbac/permissions` includes `delegatedPermissions[]` and `actingVia` (`org_admin_delegation` when applicable).
- See `ORG-ADMIN-POLICY.md`.

## UI visibility vs enforcement

Clients must not show actions the user cannot perform, but hiding is **never** the security boundary:

- A client decides what to *show* from one source: `GET /v1/rbac/permissions` (`permissions[]`, `mayAdminister`, `delegatedPermissions`, `actingVia`) for the active school, plus `GET /v1/org/schools` for org aggregate navigation. Show a control only if its required permission code (the endpoint's `x-figbloom-permissions`) is in that set.
- Every endpoint independently re-checks the same permission server-side (`403`), so a forged or stale client cannot perform the action.
- Re-fetch the permission set after `select-tenant`, after a `403`, and on a short interval; it is a hint that can be stale, the server answer is authoritative.
- Phase 9 maps each existing navigation entry / action to a permission code; P1-A supplies the codes and the endpoint, not the UI wiring.

## Dual-run with legacy Supabase

Existing web/mobile continue to use Supabase Auth + RLS. This API exposes a parallel session contract for the replacement backend. Phase 9 (Mobile & UI Integration) wires clients; P1-A does not rewrite frontends.

## MFA

Privileged MFA is **designed** for a later gate (programme D-6). P1-A does **not** enforce MFA.
