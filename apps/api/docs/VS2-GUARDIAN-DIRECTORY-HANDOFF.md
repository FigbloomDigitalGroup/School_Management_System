# VS-2 — Guardian directory create/read and learner links (integration handoff)

> **Audience:** web and mobile developers integrating with `@figbloom/api`.  
> **Boundary:** backend contract only — do **not** treat this as authorization to edit `apps/web` or `apps/mobile` in the rebuild programme.  
> **Status:** IMPLEMENTED (scoped) — VS-2 only; School Directory module is **not** complete. Independent review findings F-1–F-6 remediated.  
> **OpenAPI:** `apps/api/openapi/openapi.yaml` (tag `directory`)  
> **Last updated:** 2026-11-13 (low-finding fixes: code-point name length, email pattern; deferred limitations recorded)  

---

## Endpoints

| Method | Path | Permission | Success |
|---|---|---|---|
| `POST` | `/v1/tenants/{tenantId}/guardians` | `resource.guardian.write` **and** `resource.learner.read` | `201` `{ guardian: { id, tenantId, links } }` (**no contact fields**) |
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
| `full_name` | Yes | 1–120 **Unicode code points** (one emoji counts as one, matching JSON Schema `maxLength` and Postgres `char_length`); no leading or trailing whitespace (pattern `^\S([\s\S]*\S)?$`). Stored exactly as sent: no normalization, no truncation |
| `phone`, `alt_phone` | No | Pattern `^[0-9+()\-][0-9+()\-\s]{3,30}[0-9+()\-]$` (5–32 chars; digits, `+ ( ) -` and spaces; no leading or trailing space) |
| `email` | No | Max 254 chars; must match the published OpenAPI `pattern` (ASCII, no whitespace, no leading dot, no `..`, domain with a 2+ letter TLD). The pattern is the whole backend rule (same acceptance set as zod 3.25 `.email()`); `format: email` in the schema is only a hint. Contact metadata only |
| `learners` | Yes | 1–20 items; each `{ learner_id, relationship, is_primary_payer? }` |

**Values are validated as sent, not trimmed (F-5).** A padded value such as `" 0712345678"` is refused with `400`, which is what the published pattern says. Clients should trim input before sending.

`relationship` is `mother` \| `father` \| `guardian`. `is_primary_payer` defaults to `false` and is **stored only**; at-most-one-payer enforcement is deferred. Unknown body fields are rejected (`400`). The guardian and all its initial links are created in **one transaction**: if any step fails nothing is stored. A guardian cannot be created without a learner. Learner ids are normalized before duplicate detection (case-only duplicates → `400`). Archived learners cannot receive new relationships: they get the same `404` as an unknown learner.

## Responses

`POST` create `guardian`: `id`, `tenantId`, `links[]` (`id`, `guardianId`, `learnerId`, `relationship`, `is_primary_payer`, `created_at`). **Contact fields are not echoed back** (F-2, F-6): a caller with only `resource.guardian.write` receives no name, phone or email. Read them with `GET .../guardians/{guardianId}` (needs `resource.guardian.read`).

`GET` guardian: contact fields only — **no** `links` / linked learner identifiers (F-2). Use `GET .../learners/{id}/guardians` for relationships of a known learner.

`GET .../learners/{id}/guardians` returns each guardian's contact fields plus `linkId`, `relationship`, `is_primary_payer` and the link's `created_at`, oldest link first.

## Errors

Shape: `{ "error": { "code", "message" } }`; no SQL or stack traces.

| HTTP | `code` | Typical cause |
|---|---|---|
| 400 | `validation_error` | Missing/invalid fields (including padded phone, name or email), no learner, same learner twice (incl. case-only) |
| 401 | `unauthorized` | No/invalid session |
| 403 | `forbidden` | Missing permission, path tenant mismatch, no tenant context |
| 404 | `not_found` | Guardian or learner not in this tenant, **or an archived learner**. Unknown ids, other tenants' ids and archived learners give the **same** response (`Learner not found`), so records and archive status cannot be probed (F-3) |
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
- Migration `008_guardian_link_active_learner_guard.sql` (F-4): trigger `guardian_links_active_learner` on `guardian_links` (insert, and update of `learner_id` / `tenant_id`). It runs as a `SECURITY DEFINER` function owned by the table owner, takes `FOR SHARE` on the learner row, and refuses an archived or missing learner with SQLSTATE `P0002`. The API maps `P0002` to `404`. It is a database rule, so it holds for any writer and for `figbloom_app` after FIG-1605.
- **Why a trigger and not an application lock:** `figbloom_app` has only `SELECT, INSERT` on `learners`, and a row lock `FOR SHARE` requires `UPDATE` privilege. An application-level `FOR SHARE` therefore fails for the runtime role. The application keeps a plain precheck (clean `404`); the trigger is what closes the race.

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
| Archived-learner guard (migration 008 trigger) | **Active** on every writer, because it is a database rule (runs as owner via `SECURITY DEFINER`) | API tests (owner path, `SET ROLE figbloom_app` path, concurrent archive race) |
| Concurrent duplicate links | **Active**: `guardian_links_guardian_learner_uniq` | API tests (concurrent API requests and concurrent direct inserts) |

**Remaining (FIG-1605):** wire the live API pool to `figbloom_app` (or equivalent non-owner role) so RLS and table grants apply on every request. Until then, do not claim production least-privilege DB role isolation for guardians: the RLS policies on `guardians` and `guardian_links` are proven only by `SET LOCAL ROLE figbloom_app` tests, not on the live connection. The archived-learner guard does not depend on FIG-1605. Do not treat VS-2 as closing FIG-1605.

## Mapping to existing People flows

| Existing | VS-2 |
|---|---|
| People → Invite guardians (Edge `provision-guardian` creates an account and links) | Directory person + links **only**. Login provisioning is **deferred, not dropped** |
| Learner card guardians | `GET .../learners/{id}/guardians` (contact fields live on the guardian row) |
| `is_primary_payer` | Stored on the link; enforcement deferred to Finance |

## Review findings → fixes

| ID | Fix |
|---|---|
| F-1 | Normalize learner ids before duplicate detection → `400`. Tests: case-only duplicate on create (`400`, nothing stored); upper-case id on link to an existing link (`409`) |
| F-2 | `GET` guardian returns contact fields only (no linked learner ids). Create no longer echoes contact fields back (test: create response has no name, phone or email) |
| F-3 | Create/link also require `resource.learner.read`. Archived and unknown learners return the same `404` body (test compares the two bodies) |
| F-4 | Archived learners cannot receive new links: app precheck plus DB trigger (migration 008). Test: an archive that commits during a link request makes the link `404`; the trigger refuses the insert as owner and as `figbloom_app` |
| F-5 | OpenAPI phone, `alt_phone` and `full_name` use `pattern`, `minLength`, `maxLength`. The same patterns are exported from `modules/directory/guardians.ts` and the backend uses them. Test sends sample values through the endpoint and checks each accept/refuse result against the published pattern |
| F-6 | `area.people` no longer implies `resource.guardian.*`; org-admin delegations must name `resource.guardian.*` explicitly (tests: `area.people` alone is refused; explicit delegation works) |
| F-5 follow-up (low review findings) | `full_name` length is counted in code points on both sides (backend `codePointLength`, OpenAPI `maxLength`); the OpenAPI `email` carries the exact backend `pattern`. Tests: boundary names (ASCII, 61/120/121 supplementary characters, mixed) and email samples compared with the published pattern and with zod's own `.email()` (no weakening); a round-trip test checks an emoji name is stored unchanged |

**Concurrency tests:** concurrent guardian creation (two parallel creates: both succeed, each with exactly one link); concurrent link creates (one `201`, one `409`); concurrent direct inserts (one row); archive-versus-link race (see F-4).

## Accepted limitations and deferred items

Decided and recorded for this slice. None of these is a defect to fix in VS-2.

- **Duplicate guardian person records are permitted.** There is no uniqueness rule on name, phone or email, and none is planned in VS-2. Only the guardian–learner relationship is unique. Identity resolution, deduplication and merging are future product functionality. Two concurrent identical creates both succeed.
- **Guardian-not-found and learner-not-found responses are distinguishable on the link path.** `POST .../guardians/{guardianId}/links` returns `404 Guardian not found` or `404 Learner not found`. A caller with `resource.guardian.write` could therefore learn whether a guardian UUID exists in their own tenant. Accepted as low risk (UUIDs are not guessable; same tenant only). Unknown, foreign and archived *learners* remain indistinguishable. A broader error-contract change is out of scope.
- **Guardian contact reads are not separately audited.** Creates and links write audit events; `GET` guardian and `GET .../learners/{id}/guardians` do not. Read auditing for personal data is a cross-cutting audit-policy decision, not a one-off for this slice.
- **Migration 008 needs deployment verification against an existing database.** It was applied only by the test suite, which resets `figbloom_api` and runs every migration from scratch. Applying it to a database that already holds guardian and learner data has not been verified. It is forward-only; manual rollback is `DROP TRIGGER guardian_links_active_learner ON guardian_links; DROP FUNCTION guardian_links_active_learner_guard();`.
- **Migration 008 was edited after its first commit (comment only).** The migration runner refuses a changed, already-applied migration (checksum). The earlier commits were never pushed, but any database that applied the first version of 008 (for example by running `npm run migrate` between `8df77a0` and the comment fix) will report a checksum mismatch and must be reset or have its recorded checksum updated by a human. The test database is reset on every run and is not affected.
- **Runtime RLS is not verified.** The live API connects as the database owner; RLS on `guardians` and `guardian_links` is proven only with `SET LOCAL ROLE figbloom_app` tests. This stays with FIG-1605.
- **Pattern engines.** The published `pattern` values are ECMAScript regular expressions. A validator that uses different `$` semantics (for example one that lets `$` match before a trailing newline) may accept a value with a trailing newline that this API refuses.

## Deferred (not in VS-2)

Account provisioning and invitations; user-to-guardian binding; parent self-service endpoints; single primary-payer enforcement; guardian update/archive/unlink; learner list/update/archive; staff directory; admissions; documents; class assignment; client changes; FIG-1605 runtime role wiring.


> **Correction (2026-11-17, owner decision):** the statement above that the guardian codes are delegable to org admins is superseded. `resource.guardian.*` is NOT delegable; guardian access is only the explicit per-person grant (FIG-1614 Option D). See `ORG-ADMIN-POLICY.md`.
