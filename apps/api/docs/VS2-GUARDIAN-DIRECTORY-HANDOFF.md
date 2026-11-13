# VS-2 — Guardian directory create/read and learner links (integration handoff)

> **Audience:** web and mobile developers integrating with `@figbloom/api`.  
> **Boundary:** backend contract only — do **not** treat this as authorization to edit `apps/web` or `apps/mobile` in the rebuild programme.  
> **Status:** IMPLEMENTED (scoped) — VS-2 only; School Directory module is **not** complete. Independent review pending.  
> **OpenAPI:** `apps/api/openapi/openapi.yaml` (tag `directory`)  
> **Last updated:** 2026-11-13

---

## Endpoints

| Method | Path | Permission | Success |
|---|---|---|---|
| `POST` | `/v1/tenants/{tenantId}/guardians` | `resource.guardian.write` | `201` `{ guardian }` (with `links`) |
| `GET` | `/v1/tenants/{tenantId}/guardians/{guardianId}` | `resource.guardian.read` | `200` `{ guardian }` (with `links`) |
| `POST` | `/v1/tenants/{tenantId}/guardians/{guardianId}/links` | `resource.guardian.write` | `201` `{ link }` |
| `GET` | `/v1/tenants/{tenantId}/learners/{learnerId}/guardians` | `resource.guardian.read` **and** `resource.learner.read` | `200` `{ guardians: [...] }` |

## Model

A guardian is a **standalone person record** in the school directory. It is **not** an authentication identity: no login, no `login_id`, no password, no user or membership binding, and no invitation is created. Guardians and learners are linked through `guardian_links` (many-to-many, same tenant only).

## Authentication and authorization

Same as VS-1: `Authorization: Bearer <session token>`, tenant from the session `activeTenantId` or `X-Tenant-Id`, path tenant must match (`403` otherwise). Client-supplied `permissions` in the body are rejected (`403`). Default deny.

| Actor | Write | Read |
|---|---|---|
| `school_admin` | Yes | Yes |
| `teacher` / `staff` with admin area `people` | Yes | Yes |
| `org_admin` with delegation of `resource.guardian.*` or `area.people` | Yes (delegated) | Yes (delegated) |
| `parent`, `student`, `driver`, teacher without people | `403` | `403` |
| Missing / invalid session | `401` | `401` |

Parent self-service access to their own children is **not** part of VS-2.

## Create body (`POST .../guardians`)

| Field | Required | Notes |
|---|---|---|
| `full_name` | Yes | 1–120 chars |
| `phone`, `alt_phone` | No | 5–32 chars; digits, `+`, `(`, `)`, `-`, spaces |
| `email` | No | Valid email, max 254. Contact metadata only |
| `learners` | Yes | 1–20 items; each `{ learner_id, relationship, is_primary_payer? }` |

`relationship` is `mother` \| `father` \| `guardian`. `is_primary_payer` defaults to `false` and is **stored only**; at-most-one-payer enforcement is deferred. Unknown body fields are rejected (`400`). The guardian and all its initial links are created in **one transaction**: if any step fails nothing is stored. A guardian cannot be created without a learner.

## Responses

`guardian`: `id`, `tenantId`, `full_name`, `phone`, `alt_phone`, `email`, `created_at`, `updated_at`, `links[]` (`id`, `guardianId`, `learnerId`, `relationship`, `is_primary_payer`, `created_at`).

`GET .../learners/{id}/guardians` returns each guardian's contact fields plus `linkId`, `relationship`, `is_primary_payer` and the link's `created_at`, oldest link first.

## Errors

Shape: `{ "error": { "code", "message" } }`; no SQL or stack traces.

| HTTP | `code` | Typical cause |
|---|---|---|
| 400 | `validation_error` | Missing/invalid fields, no learner, same learner twice in one request |
| 401 | `unauthorized` | No/invalid session |
| 403 | `forbidden` | Missing permission, path tenant mismatch, no tenant context |
| 404 | `not_found` | Guardian or learner not in this tenant. Unknown ids and other tenants' ids give the **same** response, so records cannot be enumerated |
| 409 | `conflict` | The guardian is already linked to that learner |
| 500 | `internal_error` | Unexpected; generic body |

## Audit

`security_audit_events`: `directory.guardian.created` (`guardianId`, `learnerIds`, `relationships`) and `directory.guardian.linked` (`guardianId`, `learnerId`, `relationship`). No names, phones or emails are written to audit detail.

## Database / isolation (backend notes)

- Migration `007_guardians_directory.sql`: tables `guardians`, `guardian_links`; permissions `resource.guardian.read` / `.write` (granted to `school_admin`; `area.people` implies both in `authorize.ts`; both delegable to org admins).
- `guardian_links` uses composite foreign keys `(guardian_id, tenant_id)` and `(learner_id, tenant_id)`, so a link cannot join rows of different tenants even if application checks were bypassed. Unique `(guardian_id, learner_id)`.
- Adds `UNIQUE (id, tenant_id)` on `learners` (required for the composite key; no new restriction since `id` is the primary key). Migration 006 is unchanged.
- FORCE RLS for `figbloom_app` on both tables; app role has `SELECT, INSERT` only (no UPDATE/DELETE/TRUNCATE).
- Learner deletes are `RESTRICT`; deleting a guardian (owner-level only) cascades its links.
- Runtime may still connect as owner until FIG-1605; routes set `app.tenant_id` per transaction.

## Mapping to existing People flows

| Existing | VS-2 |
|---|---|
| People → Invite guardians (Edge `provision-guardian` creates an account and links) | Directory person + links **only**. Login provisioning is **deferred, not dropped** |
| Learner card guardians | `GET .../learners/{id}/guardians` (contact fields live on the guardian row) |
| `is_primary_payer` | Stored on the link; enforcement deferred to Finance |

## Deferred (not in VS-2)

Account provisioning and invitations; user-to-guardian binding; parent self-service endpoints; single primary-payer enforcement; guardian update/archive/unlink; learner list/update/archive; staff directory; admissions; documents; class assignment; client changes.
