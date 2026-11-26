# HR & Payroll connect page and one-click launch on the API build (`admin/hr`, `/hr/launch`)

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file. Written 2026-11-25 (slice H2
of `docs/handoffs/WEB-ON-API-ROADMAP.md`, section 5, S3). The API side is slice H1: `apps/api/docs/HR-HANDOFF.md`, section 9.

"HR & Payroll" takes a person from the school's console into Figbloom HR, signed in. It is not a menu page. It is one side item under
the menu (admin, teacher and staff consoles), a connect page (`admin/hr`) the item opens while HR is not yet there for the school, and a
launch tab (`/hr/launch`) that asks for the one-time sign-in link and replaces itself with it. On Supabase these are the `open-hr`
function's three actions. On the API build the **same screens** run on `GET .../me/hr/handoff-status`, `POST .../me/hr/handoff-request`
and `POST .../me/hr/handoff`. **The API is off by default** (`PLATFORM_HANDOFF_ENABLED` plus the four `PLATFORM_*` settings), so on a
fresh API build nobody sees the item. Nothing here was tried against a real platform or a real HR.

## What works

- **The screens are unchanged.** `HrPayroll.tsx`, `HrLaunch.tsx`, `HrLaunchView.tsx`, `HrPayrollViews.tsx`, `useHrItem.ts` and
  `hrLaunch.ts` are as they came from `main`. The four functions in `packages/shared/src/hrHandoff.ts` that call a backend
  (`fetchHrStatus`, `requestFigbloomHr`, `requestHrLink`, `fetchHrHandoffStatus`) keep their signatures and branch on `onApi()` to
  `packages/shared/src/api/hrHandoffApi.ts`. The API answers with `open-hr`'s own fields, so `readHrStatus` reads it as before.
- **The item** ("HR & Payroll", under the menu, set apart) is in the three shells of `api/ApiConsole.tsx` (`sideActions`). It shows only
  when the person may be offered it (`mayOfferHr`: the school's administrator, or a teacher or other staff member holding the Fees area)
  **and** the API says the hand-off is on for the school (`enabled: true`). Then it does what it does on Supabase (`hrItemMode`):
  - HR is there (`connected`) or could not be checked (`unknown`): it opens the launch tab at once, with the external-link mark.
  - Not there, or still being set up: it opens the connect page, with the "+" mark.
- **The connect page** (`admin/hr`, registered in `api/pages/hr.pages.tsx`, no menu entry) shows the school's state: connected (with
  "Open Figbloom HR", a new tab), setting up (with "Check again"), not connected (with "Request Figbloom HR"), or requested (with the date).
  A request is `POST handoff-request`: the first request is kept, a repeat answers the first one's time, and `409 already_connected` (HR was
  switched on meanwhile) makes the card follow the new state instead of showing an error. The address is gated by the Fees area as on
  Supabase (`ADMIN_PAGE_AREA["admin/hr"]`).
- **The launch tab** (`/hr/launch?school=<id>&slug=<slug>`, a top-level route added in `api/ApiHrRoutes.tsx`, one import and one line in
  `ApiApp.tsx`): it asks `POST handoff` for the person's one-time link, checks it is `https`, and replaces itself with it. The login is
  shared with the school's tab (the API token is in `localStorage`), so it is signed in. Every refusal reads in plain words
  (`hrLaunchProblem`): not switched on, still being set up, only administrators and the bursar, session ended, too many attempts, or
  "couldn't reach Figbloom HR" (also for the API's `503 hr_unavailable`, `502 hr_bad_answer` and `403 handoff_off`).
- **The one-time link holds a code.** It is returned to the launch tab and opened. Nothing shows, stores or logs it: it is in no error, no
  message, no console line, and not in the audit row (the browser pass looked for it in the page, the console, the API's log and the audit rows).
- **Audit.** The school's audit log (`admin/audit`) shows the two events in the Supabase wording: "Opened HR & Payroll (one-time sign-in link)"
  and "Asked Figbloom for HR & Payroll" (`WORDING` in `api/auditApi.ts`, see hr-handoff-6).
- **The platform console** (`platform/tenants`, `ApiPlatformTenants.tsx`) shows which schools asked for HR & Payroll: an "HR asked" badge in
  the list, an "HR asked" filter with its count, and an "HR & Payroll" block in the school's detail with the date and the account that asked.
  `platformSchoolFromApi` maps `hrRequestedAt` and `hrRequestedBy` (camelCase on the API).
- **Errors.** `api/errors.ts` knows the five new codes (`handoff_off`, `already_connected`, `target_not_enabled`, `target_not_linked`,
  `target_no_handoff_url`). Without them a `403 handoff_off` would fold into a plain "forbidden" and the launch tab would tell a person "only
  administrators can open HR" when the switch is simply off.
- **The POSTs are sent with no body** and no content type (a JSON type with an empty body is a 400 on this API).

## When the item shows

| What the API says | Item | Connect page |
|---|---|---|
| 403 (not someone who may have it, or no membership) | none | "HR & Payroll isn't available for your account" |
| `enabled: false` (the hand-off is off, the API's default) | none | the same sentence |
| `connection: not_connected` (the platform does not know the school, or HR is not on for it) | connect page ("+") | "Not connected", or "Requested" once the school asked |
| `setting_up` (HR on, its company not linked yet) | connect page ("+") | "Setting up", "Check again" |
| `connected` | launch tab (external mark) | "Connected", "Open Figbloom HR" |
| `unknown` (the platform could not be asked, or the school's row has no platform id) | launch tab (external mark) | "Open Figbloom HR", without claiming "Connected"; the launch tab says what is wrong |

A person who is not asked at all (a teacher or staff member without the Fees area, a parent, a learner, a driver) makes no call to the
hand-off routes. The web remembers an answer for a minute per person and school; the API keeps a school's connection a minute (15 seconds
when unknown).

## What is hidden or different, and why

No capability flag was needed (`capabilities.ts` is unchanged): whether HR is available is the API's own answer, per school and per person,
not a property of the build.

| Different or not there | Why |
|---|---|
| The item and the page for everyone, until the owner switches the hand-off on and links schools | off by default (owner's decision): it needs the platform settings and a `platform_school_links` row per school (hr-handoff-1) |
| Organisation administrators | Supabase lets any org admin of the school's organisation open HR. The API needs an `area.fees` delegation, and the API build's session never carries "acting for a school" (an org admin reaches a school through the organisation console, which has no HR item). So an org admin has no item on the API build (hr-handoff-4) |
| Super admins | refused by the API: HR has no account for Figbloom staff. They have no school console on the API build anyway |
| `admin/leave-to-approve` and the HR parts of the leave screens | not this slice (S4, leave): they stay hidden |
| The phone app | its own piece of work. `fetchHrHandoffStatus` (the phone's three-way answer) now works on the API too, worked out from the API's status (`hrHandoffStatusFrom`) |

## Where the code is

- `packages/shared/src/api/hrHandoffApi.ts`: the three calls and the error mapping (`ApiError` to `EdgeError`, the server's sentence kept).
  `packages/shared/src/hrHandoff.ts`: the `onApi()` branches and `hrHandoffStatusFrom`. `packages/shared/src/api/errors.ts`: the new codes.
- `apps/web/src/api/pages/hr.pages.tsx` (the connect page), `apps/web/src/api/ApiHrRoutes.tsx` (the launch tab's route),
  `apps/web/src/api/ApiConsole.tsx` (the `sideActions` of the three shells, the only edit there: three `useHrItem` calls).
- `packages/shared/src/api/auditApi.ts` (the two sentences), `packages/shared/src/api/platformApi.ts` and
  `apps/web/src/screens/platform/ApiPlatformTenants.tsx` (the request on the platform's Tenants page).
- Tests: `packages/shared/src/api/hrHandoffApi.test.ts` (every state, each route, each refusal, no body, no link in any log),
  `errors.test.ts`, `auditApi.test.ts`, `platformApi.test.ts`, and `apps/web/src/screens/hr/hrOnApi.test.ts` (the registered page and route).

## API findings: HR & Payroll (numbered `hr-handoff-1` and so on)

hr-handoff-1. **Nobody links a school to the platform on the API.** There is no registration (`PLATFORM-CONSOLE.md`, Q1), so an operator
    inserts a `platform_school_links` row and sets `platform_tenant_id` by SQL (`MY-HR.md`, "Linking a school"). Seen in the browser pass: a
    school with no row reads `not_connected` (it can still ask for HR, and the request is recorded); a row without the platform id reads
    `unknown`; a row with the id asks the platform. Nothing flips a school to `connected` but the platform's own answer after the operator's
    work. Same as my-hr-2.

hr-handoff-2. **The ids the platform and HR know are the Supabase ids.** The API sends its own `tenants.id` as `tenant_local_id` and its own
    `users.id` as the person's `external_id`. A school copied with `scripts/supabase-to-api` gets new ids, so the platform will say it does not
    know the school (or HR will not know the person) even when HR is set up properly. Open question for the owner (`HR-HANDOFF.md` risk R1,
    question 3). Same as my-hr-1. This is the biggest risk and not a coding one.

hr-handoff-3. **`unknown` can lead to a dead end.** A row with no `platform_tenant_id` reads `unknown`, which the web offers like `connected`
    (its launch tab is meant to say what is wrong). If the platform does not know the school, a click ends on "Figbloom HR isn't set up for your
    school yet" (`409 school_not_linked`). Seen with the fake platform. Whoever inserts the row should set the platform id in the same statement.

hr-handoff-4. **Organisation administrators.** Supabase: any org admin of the school's organisation. API: only with an `area.fees` delegation,
    and the web's school session on the API never has "acting for a school", so even a delegated org admin has no item in a school console.
    Whether to widen that is the owner's decision (`HR-HANDOFF.md` question 6, risk R5).

hr-handoff-5. **`hrRequestedBy` is an id.** `GET /v1/platform/schools` gives the account that asked as a bare id (no name or e-mail), so the
    platform's Tenants page can only print "Asked by account <id>". If staff should see who asked, the API needs to add the name (the console
    already reads a school's administrators with names).

hr-handoff-6. **The API words the two audit events generically.** `schoolAudit.ts` has no `LABELS` entry for `hr.handoff.opened` and
    `hr.handoff.requested`, so the API's `label` would read "Handoff opened" and "Handoff requested". The web overrides both with the Supabase
    sentences (`WORDING` in `auditApi.ts`). Two entries in the API's `LABELS` would make the override unnecessary.

hr-handoff-7. **Two caches stack.** The API keeps a school's connection a minute (15 seconds when unknown; the platform's `cache_seconds`,
    at most 60), and the web keeps the answer a minute per person and school. After staff switch HR on, the item can take up to about two
    minutes to change. "Check again" and a reload skip the web's minute, not the API's.

hr-handoff-8. **`expires_at` can be null.** The platform may give no expiry, so `POST handoff` answers `expires_at: null`. `requestHrLink`'s
    type was widened to `string | null` (nothing reads it; the launch tab uses only `url`).

hr-handoff-9. **The phone's three-way status is an approximation.** The API has no `hr_handoff_status()`. `hrHandoffStatusFrom` maps
    `not_connected` to `not_enabled`, switched off to `off`, and every other connection to `available`. The API cannot say "not linked" apart
    from "not switched on" (both are `not_connected`).

## What was verified, and what was not

Verified:

- Unit tests: `hrHandoffApi.test.ts` (28: each connection and its item, off, unknown shapes, 403 hidden, other failures as `EdgeError`s, the
  school taken from the argument, no body and no content type on the POSTs, `already_connected`, `handoff_off` not read as "forbidden", the link
  never in the console and not in an error, each refusal's launch-tab message, the Supabase path untouched), with `errors.test.ts` (+1),
  `auditApi.test.ts` (+1), `platformApi.test.ts` (+2), `hrOnApi.test.ts` (3) and the existing HR tests. Full run: 183 files, 3,122 tests.
  Typecheck of shared, web, web tests, mobile and mobile node tests; `eslint .` (no errors); both Vite builds (with and without
  `VITE_BACKEND=api`).
- One browser pass (Edge, headless) against a throwaway API (Postgres 16 container, the API built from this branch, migrated, the demo school
  seeded) and the API's own fake platform (`apps/api/test/support/fakeHr.ts`, run by hand, with a small control port):
  - **Off** (no `PLATFORM_*` settings, 16 checks): a teacher is not asked and has no item; the admin's status is `enabled: false`, there is no
    item, `admin/hr` says it is not available, and the launch tab says "couldn't reach Figbloom HR" (403 `handoff_off`).
  - **On** (47 checks): school not registered (item opens the connect page, "Request Figbloom HR" records the request, the request survives a
    reload, who asked is recorded); a row with no platform id (`unknown`, the item launches, the tab says "isn't set up"); the platform's own id
    recorded (the lookup carried it, not the school's id); HR on but not linked ("Setting up", "Check again"); linked ("Connected", "Open
    Figbloom HR"); the card and the menu item each open a new tab that ends on the platform's `https` link; the code is not in the school's page,
    either tab's console, the API's log or the audit rows (which hold only `{"target": "hr"}`); the opener is cut; the audit log shows both
    sentences; each refusal on the launch tab (no sign-in address yet, not switched on, platform down, a non-`https` answer); a teacher
    without the Fees area has no item; the platform console shows the request (badge, filter, detail with date and account).
- Not run: the Supabase build in a browser. `hrHandoff.ts` is the one shared module that build also uses; its Supabase paths are unchanged and
  covered by the existing tests (`hrHandoff.test.ts`, `hrLaunch.test.ts`, `HrLaunchView.test.ts`, `HrPayrollViews.test.ts`) and a clean build.

**Not** verified: anything against a real platform, a real HR or real credentials (none were used); a Fees-area holder (a teacher or staff
member) in a browser (they must use two-step, and the pass had no such account): their item and page follow the same code as the admin's and
the API's own tests cover its rule; an organisation administrator; the `429 rate_limited` answer in a browser (unit-tested); a school whose HR
company was linked in the real HR; the phone app.

## Leave to approve (L1 API + L2 web, 2026-11-26)

`admin/leave-to-approve` is now registered in `api/pages/hr.pages.tsx` and uses the existing `LeaveToApprove` screen. The shared HR leave
helpers call the API for access, pending approvals and decisions while `onApi()` is true; the Supabase calls are unchanged. The page and its
admin-home/menu entry are offered only when `GET .../me/hr/leave/access` says `{status: "available", approver: true}`. The access cache is
60 seconds and keyed by both user and school. `approver_not_linked` opens the existing connect-once message and HR & Payroll action. The page
passes on HTTPS document links only and hides links without a fresh expiry. The API's global `HR_LEAVE_ENABLED` switch remains off by default.

**Limit:** this is the approver view only. Staff applications and cancellations through HR (L3) and signed HR decisions applied back to the
school record (L4) are not built. Do not turn the switch on for a real school before both paths exist and a real test school has been checked.

**Verified so far:** 45 shared and page-registration tests passed; the API leave suite passed (9 tests), API typecheck passed, and the OpenAPI
check passed (334 paths / 420 operations). No browser pass has been run yet. No real HR, platform or credentials were used.

hr-handoff-10. **Access takes effect within one minute in the web menu.** The web caches the access answer per user and school for 60 seconds;
   changing the global switch or a person's delegated area may take that long to update the menu. The API checks permission again on every
   approvals request and decision, so a cached menu does not authorize the action.
