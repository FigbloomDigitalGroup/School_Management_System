# The school's audit log

Written 2026-11-25. What a school administrator (or a holder of the Audit area) can read of the audit trail, how the
database decides it, and what stays closed. Found while putting the web page `admin/audit` on the API build: the Supabase
page reads its own `audit_events` table; the API had no read at all (the table `security_audit_events` has no `SELECT`
grant for the runtime role, and only `org_my_audit_events` read it, for an organisation administrator's own actions).

## Who may read it

The permission `resource.audit.read` (migration 106), held by:

| Who | How |
|---|---|
| a full school administrator | the `school_admin` role row, and the explicit administrator list in `loadEffectivePermissions` |
| a teacher or staff member given the **Audit** area | `area.audit` (it was in the catalogue since migration 001 and in the delegable areas, but nothing used it) implies `resource.audit.read` (`AUDIT_AREA_IMPLIED`) |
| an organisation administrator acting for the school | only through a delegation that includes `area.audit`; the same implication applies |
| a platform super administrator | the `super_admin` role row |

Everyone else (a parent, a student, a driver, a teacher without the area, a holder of another area) gets the audited 403.
Another school's administrator is refused by path and by `X-Tenant-Id`.

## The read

`GET /v1/tenants/{tenantId}/audit-events?category&since&search&limit&cursor`, newest first.

| Parameter | Meaning |
|---|---|
| `category` | one of the web console's eight: `provisioning` (people and setup), `access`, `academic`, `financial`, `health`, `transport`, `communication`, `operations` |
| `since` | a day, `yyyy-mm-dd`: that day (from 00:00 UTC) and later. Not school time |
| `search` | up to 80 characters, matched case-insensitively against who did it and the event's own words, **as plain text** (a `%` or `_` means nothing) |
| `limit`, `cursor` | the FIG-1621 convention. The cursor is bound to the school and to every filter, so it cannot be replayed under another one. `sort` is refused |

Each row: `id`, `occurred_at`, `event_type` (for example `finance.payment.recorded`), `label` (the event in words; a known wording
or the event's own name without its domain), `category`, `actor_user_id` and `actor_name` (null for an event the system wrote).

## One function decides what exists: `school_audit_events` (migration 106)

`security_audit_events` keeps no `SELECT` grant for `figbloom_app` (asserted by `phase3.runtimeIsolation`), so the read is one
`SECURITY DEFINER` function, the same pattern as `org_my_audit_events` (105) and `family_my_children` (099):

- **The school is not an argument.** It is `app_current_tenant_id()`, set by the API after it authorised the request. Without a
  school and an account in the request the function raises 42501.
- **Only business events.** The function classifies each event kind by its name and returns a row only when it has a
  category. **Never returned**: sign-in, session and two-step events (`auth.*`), refusals (`...denied`), read events (`...viewed`),
  `family.*`, `ai.*`, `notifications.*`, `identity.*`, personal settings (`communications.notification_preferences.updated`,
  `communications.device_token.reclaimed`), private chat starts, internal bookkeeping (`attendance.register.stale_ignored`,
  `import.learners.preview_expired`, `rbac.org_delegation.legacy_inert` and `.review_required`,
  `finance.mpesa.operator_inconclusive`, jobs, the worker, a membership archived by the database), platform operators' notes on
  unmatched M-Pesa callbacks (`finance.unmatched.*`), the platform's own `platform.school.provisioned`, storage transfers (only
  `storage.object.deleted` is shown), and **every kind the function does not name**: a new event kind is hidden until someone
  adds it on purpose.
- **Shown under "access"**, though the database functions write them under other names: invitations (`account.invitation.*`,
  `guardian.invitation.*`), a member deactivated (`account.membership.deactivated`), a guardian link revoked
  (`guardian.account.revoked`), and an administrator issuing a password reset or resetting someone's two-step sign-in
  (`auth.password.reset_issued`, `auth.mfa.admin_reset`). The person's own password change, reset request and sign-ins stay hidden.
- **Never the `detail` and never the `ip`.** A row says what happened, who did it and when, not what the record held: the detail
  may carry names, amounts or health information, and its shape differs by event.
- Newest first, keyset on `(occurred_at, id)`, at most 201 rows. The index `(tenant_id, occurred_at DESC)` serves it.

### Every kind the code writes is classified on purpose

`test/fixtures/schoolAuditClassification.json` records, for each of the 222 event kinds the code can write (a scan of
`src/`, the kinds built from a template, and every dotted literal inside an `INSERT INTO security_audit_events` of a migration,
because the database functions write events too), the category the function gives it, or `hidden`. The test
(`test/schoolAudit.test.ts`) inserts one event of each kind and reads the log back as the school's administrator. It fails when
(a) the code writes a kind the file does not list ("decide if a school may see it, then regenerate with
`SCHOOL_AUDIT_WRITE_SNAPSHOT=1` and review the diff") or (b) the function and the file disagree. So no event kind can start or
stop appearing in a school's log without a reviewed change.

## Database

No table, grant or policy changes. The function is `SECURITY DEFINER`, `STABLE`, `search_path = pg_catalog, pg_temp`,
`REVOKE ALL FROM PUBLIC`, `EXECUTE` for `figbloom_app` only. It reads `security_audit_events` and the `full_name` of `users`.
It is listed in `test/securityDefiner.test.ts` and `SECURITY-DEFINER-INVENTORY.md`.

### How fast it is

Measured on 2026-11-25 on a throwaway Postgres 16 with 400,000 events for one school, 85% of them sign-in events that are never
shown (so the hidden ones dominate, the worst realistic mix): the first page with no filter 6 ms; a category that is 1 in 100
rows (`transport`) 27 ms; a search that matches 30 ms. The index `(tenant_id, occurred_at DESC)` serves the order, and the
database stops at the page size. **The slow case is a filter that matches almost nothing**: a search for words no event has
walks the school's whole log (2.7 s at 400,000 events, growing with the log; the API cuts a request at 30 s). Nothing prunes the
log yet (open decision 4). If that bites, require `since` with `search`, or add a partial index on the shown kinds.

## What the web page shows, and does not

The web page `admin/audit` can list, filter by category, search, filter by day and load more. It cannot show **what changed
field by field** (the Supabase page does): that needs the detail, which is withheld on purpose. The wording is generic
(for example "Mar recorded").

## Tests (negative first)

`test/schoolAudit.test.ts`, through the real `figbloom_app` login: a parent, a student, a driver, a teacher with no area, a
holder of another area and the audited denial; anonymous, a disabled account, an archived member, a suspended school; another
school's administrator by path and header, who reads only their own school; the Audit area opening it and ending it closing it;
the function refusing without a school; the exact set of shown events, newest first, with nothing from sign-in, refusals, reads,
other schools or no school; no detail, no IP and no learner name in the body; the category, `since` and `search` filters
(including wildcards as plain text and bad input); paging, and a cursor replayed under another filter, by another school; and
the classification file above. Responses are validated against the OpenAPI schema.

## Open decisions for the owner (defaults chosen here, easy to change)

1. **Health events** are shown by name and actor only (for example "Medication incident reported"), so a holder of the Audit
   area learns that one happened, not about whom. Hide the category from anyone without the Medical area?
2. **Two-step sign-in.** Today only the administrator roles and the Fees area are forced to use it. A teacher holding only the
   Audit area can read this log without it. Add the Audit area to the rule?
3. **The detail.** Show a safe per-event summary (the record's id, the fields that changed, never their values)? It needs a
   reviewed projection per event kind; the Supabase page shows field names, and hides the values of health, documents, exam
   answers, leave and visits.
4. **Retention.** Nothing prunes `security_audit_events` today, and no period is decided. The Supabase page says seven years.
5. **Sign-in events for a school's own staff** (who signed in when, failures): hidden here. A school may want them; they carry
   IP addresses and need their own decision.
6. **`since` in school time.** The day is read as UTC. Use the school's time zone?
