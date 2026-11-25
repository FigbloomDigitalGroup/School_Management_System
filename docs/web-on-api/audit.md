# Audit log (`admin/audit`)

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.

Page: `admin/audit` (`AdminAuditLog`, `apps/web/src/screens/admin/AuditLog.tsx`), registered in `apps/web/src/api/pages/audit.pages.tsx`. Capability flags: `auditCapabilities()` in `packages/shared/src/capabilities.ts`. The API side is `packages/shared/src/api/auditApi.ts`, on `GET /v1/tenants/{tenantId}/audit-events` (what the API returns, and what it never returns, is in `apps/api/docs/SCHOOL-AUDIT.md`; the database function is `school_audit_events`, migration 106).

## What works

- **Who may open it:** a full administrator, and whoever holds the Audit area on Access & roles. The page gate is the same as on Supabase (`ADMIN_PAGE_AREA["admin/audit"]` is `"audit"`), so a teacher or staff member holding only the Audit area sees the page (and its card on their admin home), and a holder of any other area is sent back to their home. The API refuses everyone else with a 403 (`resource.audit.read`), which the page shows as "You don't have permission to read the audit log."
- **The list:** newest first, with When, Who, What and a category badge, 100 events a screen. "Show older events" pages on through the whole log.
- **Filters:** the eight categories (People & setup, Access, Academic, Financial, Health, Transport, Communication, Operations), "From" (a day), and a search box (who did it, or the words of the event).
- **Words:** each event has a sentence (`label`), for example "Payment recorded", "Learner created", "Admin areas changed".

## What is hidden and why

`auditCapabilities()` (`fieldChanges` and `everyChange`); both are true on Supabase.

| Hidden on the API build | Missing in the API |
|---|---|
| Opening an event to see which fields of which record changed, with the old and new values (the rows are not clickable, so there is no empty "What changed" table) | A row carries no detail, by design: the detail of an event can hold names, amounts and health information, and its shape differs from event to event. A row says what happened, who did it and when |
| "Every change made in the school" (the page's own wording says what the log is instead) | The log is the school's **business events** only. Sign-in, session and two-step events, refused attempts, read events ("viewed"), personal settings, private chat starts, file transfers and any kind of event nobody classified on purpose are never listed. A new kind of event stays hidden until it is added to the database function |

## How the model is mapped

- `auditEventFromApi` makes the screen's `AuditEvent`: `event` is the API's `label`, `actor_label` is the actor's name, `category` and the time (`created_at` is `occurred_at`) are as they come. `metadata` holds only `event_type` (the event's own name, for example `finance.payment.recorded`): there is nothing else to show.
- **No actor is "System".** An event the system wrote on its own, and an event whose account was removed, both come with no actor. An actor with an id but no name (not seen in practice) is "Unknown person".
- **Offset to cursor.** The screen pages by offset (how many events it already shows); the API pages by cursor. `apiFetchAuditEvents` keeps, for each school and filter set (at most 20 sets), the cursor that starts each page it has read, so "Show older events" is one request. Reading from the start again forgets the sets' cursors, so the chain always follows the newest read. A page asked for with no cursor held (not reachable from the screen today) is found by reading the pages before it.
- **Search.** The API takes at most 80 characters: a longer search is cut to 80 instead of being refused. A search is plain text (the API ignores wildcards), where Supabase replaced `%`, `_`, commas and brackets with spaces.
- **"From".** A day, `yyyy-mm-dd`: that day from 00:00 UTC and later, as on Supabase.
- The page and the console shell are unchanged apart from the page's wording (`everyChange`) and the rows' click (`fieldChanges`).

## API findings (`audit-1` to `audit-7`)

- **audit-1:** the API returns no `detail` for an audit row, so "What changed" (the field-by-field old and new values the Supabase log shows) cannot be built. If the owner wants it, the API needs an allow-list of fields per event kind and a decision about which values may be shown (health and money first).
- **audit-2:** the wording is generic, made from the event's name when no wording is written for it ("Mar recorded" for `health.mar.recorded`, "Issue created" for `inventory.issue.created`), and it never says whose record: "Payment recorded" does not name the learner or the invoice. Supabase words each event itself, with names.
- **audit-3:** search matches the actor's name and the event's words only. It cannot find an event by the learner, class or amount it concerned.
- **audit-4:** `since` is a day from 00:00 UTC, not from midnight at the school (Kenya is UTC+3), so events between 00:00 and 03:00 local time belong to the day before.
- **audit-5:** health events are listed by kind only ("Mar recorded", "Sick bay visit created"), with no learner and no values. Whether a holder of only the Audit area should see health events at all is an owner decision.
- **audit-6:** a person who holds only the Audit area is not forced to use two-step verification (the API requires it by role and for the Fees area only), though the log is sensitive. It would be a one-line change in the API's two-step rule.
- **audit-7:** an event written by the system and one whose account was later removed both show as "System", because the API sets the actor to null when an account is removed.
