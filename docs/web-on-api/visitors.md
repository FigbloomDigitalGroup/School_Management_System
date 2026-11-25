# Visitors (`admin/visitors`, `teacher/visitors`, `staff/visitors`)

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.

Pages: `admin/visitors` (`AdminVisitors`), `teacher/visitors` (`TeacherVisitors`) and `staff/visitors` (`StaffVisitors`, the desk screen `DeskVisitors`, for staff who hold the Visitors area). Capability flags: `visitorsCapabilities()` in `packages/shared/src/capabilities.ts`. The API side is `packages/shared/src/api/visitorsApi.ts`. `admin/visitors` and `teacher/visitors` are registered in `apps/web/src/api/pages/visitors.pages.tsx`; `staff/visitors` is registered in `apps/web/src/api/pages/staff-shell.pages.tsx` with `when: staffMayKeepVisitors`, because it belongs to the staff console (`docs/web-on-api/staff-shell.md`).

## What works

- **Day-by-day visitor log (`AdminVisitors`):** lists visits for the selected date from `GET /v1/tenants/{tenantId}/gate-visits`, split into **Waiting for the principal's office** (`escalated && status !== "left"`) and **All visitors**.
- **Teacher's own visitors (`TeacherVisitors`):** works for every teacher without `resource.visitor.read` — `GET /v1/tenants/{tenantId}/gate-visits?mine=true` returns only today's visits hosted by the signed-in teacher (with visitor PII minimized on the server) and polls with `?mine=true`, keeping the view scoped to their own visitors even if they hold the Visitors area.
- **Advance visit status (`useDeskActions`):** moves visits along `expected` -> `at_reception` -> `with_host` -> `left` via `POST /v1/tenants/{tenantId}/gate-visits/{visitId}/advance` and updates the local list immediately.
- **Live updates (`subscribeVisits`):** polls `/gate-visits` every 10 seconds via `startPolling` (`POLL_MS.live`), pausing when the tab is hidden or idle.
- **The desk (`staff/visitors`):** `DeskVisitors` is the gate's and reception's screen: record a visitor at the gate or the office, move them along, today's log. It uses the same list, advance and polling as the admin page. Checked on a real API as a staff account holding only the Visitors area: the log loads, a walk-in is recorded, and "Taken to host" moves it along. The host and learner pickers do not work for that role (visitors-3).

## What is hidden and why

| Hidden on the API build | Missing in the API |
|---|---|
| **Escalate** button on existing visits (`escalateAfterArrival: false`) | No endpoint to escalate an existing visit after arrival (`host_kind: "principal"` visits are escalated on creation by the server) |

## How the model is mapped

- `visitFromApi` maps `host_user_id` -> `host_id`, `learner_id` -> `student_id`, and `learner_name` -> `student_name`.
- `apiListVisits` paginates `GET /gate-visits` (newest `arrived_at` first), stopping early once a page goes older than `since`, and filters `[since, until)` client-side.
- `apiFetchVisitHosts` and `apiFindVisitLearners` implement the shared host/learner lookups for visit recording (`DeskVisitors` / `VisitForm`).

## API findings (`visitors-1`, `visitors-2`, `visitors-3`)

- **visitors-1:** `GET /v1/tenants/{tenantId}/gate-visits` supports `open` and `mine` filters, not a `since`/`until` date filter, so viewing a day on `AdminVisitors` pages from newest down until the target date is passed.
- **visitors-2:** There is no endpoint to set `escalated = true` on a visit after arrival (only `host_kind: "principal"` sets `escalated = true` on `POST /gate-visits`).
- **visitors-3:** A person who holds only the Visitors area (the receptionist, the gate: role `staff`) can read and write `/gate-visits` but is refused (403) the staff list, learners and classes. The visit form's "A member of staff" picker then offers nobody and the learner lookup finds no one (both calls are swallowed as "forbidden" and answer an empty list), so the desk can record a visit for the office or the principal but not for a named teacher or a named learner. The fix is on the API: a small read for the desk, for example `GET /gate-visits/hosts` and `GET /gate-visits/learners?q=` (name, id and class only), allowed for `resource.visitor.write`, or a narrow staff and learner directory for the same permission. Until then the web cannot fill the pickers.
