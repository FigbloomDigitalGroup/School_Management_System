# VS-1 — Learner directory create/read (integration handoff)

> **Audience:** web and mobile developers integrating with `@figbloom/api`.  
> **Boundary:** backend contract only — do **not** treat this as authorization to edit `apps/web` or `apps/mobile` in the rebuild programme.  
> **Status:** IMPLEMENTED (scoped) — VS-1 only; School Directory module is **not** complete.  
> **OpenAPI:** `apps/api/openapi/openapi.yaml` (tag `directory`)  
> **Last updated:** 2026-11-13

---

## Endpoints

| Method | Path | Permission | Success |
|---|---|---|---|
| `POST` | `/v1/tenants/{tenantId}/learners` | `resource.learner.write` | `201` `{ learner }` |
| `GET` | `/v1/tenants/{tenantId}/learners/{learnerId}` | `resource.learner.read` | `200` `{ learner }` |

The P1-A probe `GET /v1/tenants/{tenantId}/resources/learners` remains (permission check only; no directory data).

---

## Authentication

| Requirement | Detail |
|---|---|
| Header | `Authorization: Bearer <opaque session token>` |
| Tenant | Session `activeTenantId` **or** `X-Tenant-Id` (UUID) the caller can access |
| Path tenant | Must match established authz tenant (`403` on mismatch) |
| Login | Existing `/v1/auth/login/email` or `/v1/auth/login/login-id` |

Client-supplied `permissions` / role lists in the body are **rejected** (`403`).

---

## Authorization (who can call)

| Actor | Create (`resource.learner.write`) | Read (`resource.learner.read`) |
|---|---|---|
| `school_admin` | Yes | Yes |
| `teacher` / `staff` with admin area `people` | Yes | Yes |
| `org_admin` with school delegation of `resource.learner.write` / `area.people` | Yes (delegated) | Yes if delegated read/people |
| `parent`, `student`, `driver`, teacher without people | No (`403`) | No (`403`) |
| Missing / invalid session | `401` | `401` |
| No tenant context | `403` | `403` |
| Cross-tenant path vs session | `403` | `403` |
| Learner id in another tenant (same auth tenant in path) | — | `404` |

Default deny. UI visibility is never the security boundary — re-check via `GET /v1/rbac/permissions`.

---

## Request / response fields

### Create body (`POST`)

| Field | Required | Notes |
|---|---|---|
| `admission_no` | Yes | 1–32 chars; unique per school (case-insensitive); People “ADM” |
| `full_name` | Yes | 1–120 chars |
| `gender` | Yes | `male` \| `female` |
| `boarding` | No | Default `false` |
| `date_of_birth` | No | `YYYY-MM-DD` or null; not future |

### Learner object (create/read)

| Field | Type |
|---|---|
| `id` | uuid |
| `tenantId` | uuid |
| `admission_no` | string |
| `full_name` | string |
| `gender` | `male` \| `female` |
| `boarding` | boolean |
| `date_of_birth` | date \| null |
| `active` | boolean |
| `archived_at` | timestamptz \| null |
| `created_at` / `updated_at` | timestamptz |

**Out of VS-1:** `class_id`, guardians, health, bus/home pin, avatar, profile/login link, archive/delete, list/search, CSV import.

---

## Error responses

Shape (always):

```json
{ "error": { "code": "<code>", "message": "<human-readable>" } }
```

| HTTP | `error.code` | Typical cause |
|---|---|---|
| 400 | `validation_error` | Missing/invalid fields |
| 401 | `unauthorized` | No/invalid session |
| 403 | `forbidden` | Missing permission, cross-tenant, no tenant |
| 404 | `not_found` | Learner not in this tenant |
| 409 | `conflict` | Duplicate `admission_no` |
| 500 | `internal_error` | Unexpected — **no** SQL / stacks in body |

---

## Existing People flows (compatibility)

| Existing surface | Today | VS-1 relevance |
|---|---|---|
| Web People → “Add a learner” | Supabase `students` insert (`People.tsx`) | Later: call `POST .../learners`; still needs class assignment (not in VS-1) |
| Web People roster / Manage | `students` select by `tenant_id` | `GET` by id **and** the keyset list `GET .../learners` (limit, cursor, `sort=name\|created`, `active`, `q`) shipped in Phase 3 — this row previously said the list API was not shipped |
| CSV import columns | `admission_no, full_name, gender, class, boarding, date_of_birth` | Field names aligned; `class` deferred |
| Shared `learners.ts` / `learnerBio.ts` | Legacy Supabase | Product terminology retained; do not copy schema wholesale |
| Mobile parent/student | Read linked learners via shared | No VS-1 write path for parents |

**Compatibility note:** Legacy UI requires **class** on add. The new API deliberately omits `class_id` until Academics. Dual-run clients may create via new API then assign class on legacy/new class APIs when available.

---

## Audit

Successful create writes `directory.learner.created` to `security_audit_events` with `learnerId` and `admission_no` in `detail`.

---

## Database / isolation (backend notes)

- Table: `learners` (migration `006_learners_directory.sql`)
- App-layer: path tenant + permission checks + SQL `tenant_id` predicates
- Defence in depth: FORCE RLS for `figbloom_app`; least privilege (no `DELETE`/`TRUNCATE` for app role)
- Runtime still may connect as owner until FIG-1605; learner routes set `app.tenant_id` in transactions for future wiring

---

## Suggested client integration order (outside rebuild agents)

1. Add typed client methods from OpenAPI.
2. Gate “Add learner” / detail fetch on `resource.learner.write` / `resource.learner.read` from `/v1/rbac/permissions`.
3. Keep class/guardian/health on existing paths until later slices.
4. Do not remove Supabase People writes until dual-run cutover is authorized.
