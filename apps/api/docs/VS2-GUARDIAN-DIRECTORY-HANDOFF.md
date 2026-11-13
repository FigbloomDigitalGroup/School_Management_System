# VS-2 — Guardian directory create/read and learner links (integration handoff)

> **Audience:** web and mobile developers integrating with `@figbloom/api`.  
> **Boundary:** backend contract only — do **not** treat this as authorization to edit `apps/web` or `apps/mobile` in the rebuild programme.  
> **Status:** IMPLEMENTED (scoped) — VS-2 only; School Directory module is **not** complete. Independent review findings F-1–F-6 remediated.  
> **OpenAPI:** `apps/api/openapi/openapi.yaml` (tag `directory`)  
> **Last updated:** 2026-11-13

---

## Endpoints

| Method | Path | Permission | Success |
|---|---|---|---|
| `POST` | `/v1/tenants/{tenantId}/guardians` | `resource.guardian.write` **and** `resource.learner.read` | `201` `{ guardian }` (with `links`) |
| `GET` | `/v1/tenants/{tenantId}/guardians/{guardianId}` | `resource.guardian.read` | `200` `{ guardian }` (**contact fields only** — no `links`) |
| `POST` | `/v1/tenants/{tenantId}/guardians/{guardianId}/links` | `resource.guardian.write` **and** `resource.learner.read` | `201` `{ link }` |
| `GET` | `/v1/tenants/{tenantId}/learners/{learnerId}/guardians` | `resource.guardian.read` **and** `resource.learner.read` | `200` `{ guardians: [...] }` |

## Model

A guardian is a **standalone person record** in the school directory. It is **not** an authentication identity: no login, no `login_id`, no password, no user or membership binding, and no invitation is created. Guardians and learners are linked through `guardian_links` (many-to-many, same tenant only).

## Authentication and authorization

Same as VS-1: `Authorization: Bearer <session token>`, tenant from the session `activeTenantId` or `X-Tenant-Id`, path tenant must match (`403` otherwise). Client-supplied `permissions` in the body are rejected (`403`). Default deny.

| Actor | Write | Read |
|---|---|---|
| `school_admin` | Yes | Yes |
| `teacher` / `staff` with admin area `people` only | **No** (F-6) | **No** (F-6) |
| `org_admin` with `area.people` only | **No** (F-6) | **No** (F-6) |
| `org_admin` with explicit `resource.guardian.*` (+ `resource.learner.read` for write/link) | Yes (delegated) | Yes (if `resource.guardian.read` delegated) |
| `parent`, `student`, `driver`, teacher without explicit guardian permission | `403` | `403` |
| Missing / invalid session | `401` | `401` |

**F-6:** Existing `area.people` grants and org-admin `area.people` delegations do **not** automatically include guardian contact access. Guardian operations require explicit `resource.guardian.read` / `resource.guardian.write`.

Parent self-service access to their own children is **not** part of VS-2.

## Create body (`POST .../guardians`)

| Field | Required | Notes |
|---|---|---|
| `full_name` | Yes | 1–120 chars |
| `phone`, `alt_phone` | No | Pattern `^[0-9+()\-\s]{5,32}$` (OpenAPI `pattern` / `minLength` / `maxLength`) |
| `email` | No | Valid email, max 254. Contact metadata only |
| `learners` | Yes | 1–20 items; each `{ learner_id, relationship, is_primary_payer? }` |

`relationship` is `mother` \| `father` \| `guardian`. `is_primary_payer` defaults to `false` and is **stored only**; at-most-one-payer enforcement is deferred. Unknown body fields are rejected (`400`). The guardian and all its initial links are created in **one transaction**: if any step fails nothing is stored. A guardian cannot be created without a learner. Learner ids are normalized before duplicate detection (case-only duplicates → `400`). Archived learners cannot receive new relationships (`400`).

## Responses

`POST` create `guardian`: `id`, `tenantId`, `full_name`, `phone`, `alt_phone`, `email`, `created_at`, `updated_at`, `links[]` (`id`, `guardianId`, `learnerId`, `relationship`, `is_primary_payer`, `created_at`).

`GET` guardian: contact fields only — **no** `links` / linked learner identifiers (F-2). Use `GET .../learners/{id}/guardians` for relationships of a known learner.

`GET .../learners/{id}/guardians` returns each guardian's contact fields plus `linkId`, `relationship`, `is_primary_payer` and the link's `created_at`, oldest link first.

## Errors

Shape: `{ "error": { "code", "message" } }`; no SQL or stack traces.

| HTTP | `code` | Typical cause |
|---|---|---|
| 400 | `validation_error` | Missing/invalid fields, no learner, same learner twice (incl. case-only), archived learner |
| 401 | `unauthorized` | No/invalid session |
| 403 | `forbidden` | Missing permission, path tenant mismatch, no tenant context |
| 404 | `not_found` | Guardian or learner not in this tenant. Unknown ids and other tenants' ids give the **same** response, so records cannot be enumerated |
| 409 | `conflict` | The guardian is already linked to that learner (including under concurrent races; DB unique constraint is authoritative) |
| 500 | `internal_error` | Unexpected; generic body |

## Audit

`security_audit_events`: `directory.guardian.created` (`guardianId`, `learnerIds`, `relationships`) and `directory.guardian.linked` (`guardianId`, `learnerId`, `relationship`). No names, phones or emails are written to audit detail.

## Database / isolation (backend notes)

- Migration `007_guardians_directory.sql`: tables `guardians`, `guardian_links`; permissions `resource.guardian.read` / `.write` (granted to `school_admin` via `role_permissions`; **not** implied by `area.people`; both delegable to org admins).
- `guardian_links` uses composite foreign keys `(guardian_id, tenant_id)` and `(learner_id, tenant_id)`, so a link cannot join rows of different tenants even if application checks were bypassed. Unique `(guardian_id, learner_id)`.
- Adds `UNIQUE (id, tenant_id)` on `learners` (required for the composite key; no new restriction since `id` is the primary key). Migration 006 is unchanged.
- FORCE RLS for `figbloom_app` on both tables; app role has `SELECT, INSERT` only (no UPDATE/DELETE/TRUNCATE).
- Learner deletes are `RESTRICT`; deleting a guardian (owner-level only) cascades its links.
- Routes set `app.tenant_id` / `app.user_id` per directory transaction.

### Runtime isolation vs RLS proof (FIG-1605)

| Control | Live application path today | Proven how |
|---|---|---|
| Path/tenant match (`assertSameTenant`) | **Active** | API tests |
| Permission checks (`resource.guardian.*`, `resource.learner.read` where required) | **Active** | API tests |
| Application SQL scoped with `tenant_id` predicates | **Active** | Module code + API tests |
| Transaction `set_config('app.tenant_id' / 'app.user_id')` | **Active** on directory txs | Module code |
| Postgres RLS policies on `guardians` / `guardian_links` | Policies exist (FORCE RLS) | Migration 007 |
| RLS enforcement as `figbloom_app` | **Not on the live app connection** while the API still connects as DB owner | Proven only via `SET LOCAL ROLE figbloom_app` in tests |
| Least-privilege grants (`SELECT, INSERT` only) as runtime role | Depends on connecting as `figbloom_app` | Same `SET ROLE` tests |

**Remaining (FIG-1605):** wire the live API pool to `figbloom_app` (or equivalent non-owner role) so RLS and table grants apply on every request. Until then, do not claim production least-privilege DB role isolation for guardians. Do not treat VS-2 as closing FIG-1605.

## Mapping to existing People flows

| Existing | VS-2 |
|---|---|
| People → Invite guardians (Edge `provision-guardian` creates an account and links) | Directory person + links **only**. Login provisioning is **deferred, not dropped** |
| Learner card guardians | `GET .../learners/{id}/guardians` (contact fields live on the guardian row) |
| `is_primary_payer` | Stored on the link; enforcement deferred to Finance |

## Review findings → fixes

| ID | Fix |
|---|---|
| F-1 | Normalize learner ids before duplicate detection → `400` |
| F-2 | `GET` guardian returns contact fields only (no linked learner ids) |
| F-3 | Create/link also require `resource.learner.read` |
| F-4 | Archived / inactive learners rejected for new links (`400`) |
| F-5 | OpenAPI phone/`alt_phone` use `pattern`, `minLength`, `maxLength` |
| F-6 | `area.people` no longer implies `resource.guardian.*` |

## Deferred (not in VS-2)

Account provisioning and invitations; user-to-guardian binding; parent self-service endpoints; single primary-payer enforcement; guardian update/archive/unlink; learner list/update/archive; staff directory; admissions; documents; class assignment; client changes; FIG-1605 runtime role wiring.
