# The web app on the new API (FIG-1890: sign-in, school setup, people)

Written 2026-11-23. The first steps of moving the web app from Supabase to `apps/api`: the client, the switch, sign-in,
the school-setup screens (School settings, Classes, Subjects) and the People page (Students & staff). Everything else in
the web app still reads Supabase and is **not in an API build**.

## One file for each area

Each area of the API build has its own file in `docs/web-on-api/`, so that two pull requests never edit the same lines and
conflict. This page keeps what is common to the whole build.

- **A new area adds a file** there, named after the area (for example `report-cards.md`): what works, what is hidden and why,
  how the model is mapped, and the API findings. It does not edit this page or another area's file.
- **New findings are numbered inside the area's own file, with the area as a prefix** (`parent-1`, `parent-2`, ...), so that
  two areas never pick the same number. Findings 1 to 46 keep their numbers and are in the files below.
- **Pages are registered the same way:** an area adds `apps/web/src/api/pages/<area>.pages.tsx` and does not edit
  `ApiConsole.tsx` (see "Where the code is").

| Findings | Where |
|---|---|
| 1 to 13 | this page, "Things found in the API while doing this (for Ancel)" |
| 14 to 16 | [family-reads.md](web-on-api/family-reads.md) |
| 17 to 22 | [account-and-access.md](web-on-api/account-and-access.md) |
| 23 to 28 | [grades.md](web-on-api/grades.md) |
| 29 to 34 | [chats-notices-messages.md](web-on-api/chats-notices-messages.md) |
| 35 to 37 | [sign-in-invitations.md](web-on-api/sign-in-invitations.md) |
| 38 to 44 | [timetable-classes-courses.md](web-on-api/timetable-classes-courses.md) |
| 45 and 46 | [report-cards.md](web-on-api/report-cards.md) |

## What a build is

A build talks to **one** backend, chosen when it is built:

| Setting | Meaning |
|---|---|
| `VITE_BACKEND` | `api` for the new API. Anything else, or nothing, is Supabase (the app as it is today). |
| `VITE_API_URL` | The API's address, e.g. `https://api.example.com`. Required when `VITE_BACKEND=api`. |

The two have separate accounts, so they are never mixed in one build. A Supabase build is unchanged by this work.

An API build runs `apps/web/src/api/ApiApp.tsx`, not `App.tsx`. Every screen in `App.tsx` still calls the database
directly, so on an API build they would fail one by one. `ApiApp` has only what runs on the API today, and each area
is added to it (or moved back into `App.tsx`) as it is ported.

## What works on an API build

- Sign in with **email and password**, or with the school's address, a **login ID** and a password (a learner's `ST-0001`); see [student-pages.md](web-on-api/student-pages.md).
- A password an admin handed out is changed first (`must_change_password`).
- **Two-step verification**: set up (key, recovery codes shown once, first code) and answer (code or recovery code).
  The API requires it for school admins, org admins, super admins and anyone holding the Fees area.
- A kept session survives a reload; a sign-out, or a session the server ended, signs every tab out.
- The admin console shell (the same menu and page gate as the Supabase app) with the pages below. A person with no admin
  console (a parent, a teacher with no admin areas) gets a plain page showing who is signed in, their school, and a
  "check the connection" button.
- **School settings**: start a term (the year is made if it is not there), the school's name, county and MOE registration,
  and its accent colour.
- **Classes**: list (the current year's), add one or several, and who the class teacher is (chosen when the class is made).
- **Subjects**: list, add one or several (a code and a name).
- **Subjects in a class**: name the teacher of a subject in a class.
- **Students & staff** (People):
  - **Learners:** the roster (search, class filter, pages); add a learner, with a class or "No class yet"; change a
    learner's details and move them to another class; archive and restore, with an Archived view.
  - **Guardians:** each learner's guardians, and an "Add a guardian" contact form.
  - **Import:** the CSV import of learners.
  - **Staff:** list, add, change details, archive and restore. Staff on the API are directory records, so adding one
    makes no sign-in.
- **Announcements**: compose and send (or save as draft) in-app and push announcements to the whole school, a role, a year group, or a class, and view recently sent notices.
- **Fees** (office side): view term collection stats, largest outstanding balances and overpayments; create, edit and archive
  term fee items; run term billing; search payable invoices and record payments (cash, M-Pesa, bank, cheque); review, confirm
  or reject submitted payment proofs.
- **Leave** (`admin/leave` and `teacher/leave`): teachers submit leave requests (dates and reason), view their history, and
  withdraw pending requests; school admins and Leave-area holders review pending requests, approve or reject them with a note
  (sending an in-app notice to the teacher), and view past requests.
- **Inventory** (`admin/inventory`): view the register of active items with out/available counts, add stock or tracked-asset
  items, issue copies to learners, user-linked staff, or a whole class, view Out now and Overdue issues, record returns
  (returned, damaged, or lost), write off items with nothing out, and export CSV.
- Platform and organization accounts are told their console is not on the new system yet, and are signed out.

## What does not, and why

| Not there | Why |
|---|---|
| Sign in with a school ID works once the public school lookup is deployed | the form is there (school address, login ID, password). A public, rate-limited lookup now exists (`GET /v1/public/schools/{slug}`, PR #414, `apps/api/docs/PUBLIC-SCHOOL-LOOKUP.md`) and the form uses it; until that API is deployed the form answers "school not found". See [student-pages.md](web-on-api/student-pages.md) |
| Password reset by email, accept-invitation page | No email provider is set up (FIG-1872); the reset and invitation tokens are only returned in API responses |
| A QR code for two-step set-up | The key is shown for typing in, with an `otpauth://` link for a phone. A QR needs a small library; left for a decision |
| Every other screen | Each area moves over on its own, after its shared module is on the API (FIG-1889 onwards) |

### Setup screens: what the API cannot do yet

The setup screens are the Supabase app's own screens. Each control the API has no endpoint for is hidden on an API build
(`packages/shared/src/capabilities.ts`, `setupCapabilities()`), and the shared function behind it throws `NotOnApiError`.
Each flag is one missing endpoint; when the API gains it, the flag turns on and the function gets its API branch.

| Hidden on the API build | Missing in the API |
|---|---|
| Change a class's teacher after it is made | no `PATCH` on a class (a teacher is chosen at creation) |
| Delete a class | no delete or archive for a class |
| A class's room | the class has no room field |
| Promote a class | no promotion, no learner move or archive in bulk (class memberships are assigned one at a time) |
| A class's timetable | timetable slots can be made and listed, not edited; not ported yet |
| Edit a subject; a subject's level, year range and core flag; adding from the KICD catalogue | a subject is a code and a name, and cannot be updated |
| Change or clear a subject's teacher in a class | a teaching assignment can be made, not changed or removed |
| Fee structure and payment methods steps; the school crest; the AI settings | not in the API (fees are their own area) or need storage |

### Announcements screen: what the API cannot do yet

`announcementsCapabilities()` in `packages/shared/src/capabilities.ts` hides controls the API does not back yet:

| Hidden on the API build | Missing in the API |
|---|---|
| Per-audience recipient headcounts & SMS cost preview | no account-reach count endpoint yet (family account links wait on A1 / `FIG-1869`) |
| File attachments | file storage waits on A5 (`FIG-1873`) |
| Guardian signature requests & signature status | signatures wait on C12 (`FIG-1880`) |
| AI writing helper | calls a Supabase edge function |
| SMS and email channel checkboxes | SMS/email delivery waits on B8 (`FIG-1876`); `in_app` and `push` work (`publish` enqueues `announcement.push` on the server) |

### Leave screens: what the API cannot do yet

`leaveCapabilities()` in `packages/shared/src/capabilities.ts` handles the differences between Supabase and `apps/api`:

| Hidden or different on the API build | Missing or different in the API |
|---|---|
| Figbloom HR leave handoff (`admin/leave-to-approve` and HR-backed applications) | HR handoff is not on the API yet (C13); `teacher/leave` uses the school's own leave form |
| Submitting a leave request with no reason | `POST /v1/tenants/{tenantId}/leave-requests` requires a reason of at least 3 characters |

How the model is mapped (`packages/shared/src/api/leaveApi.ts`):

- The API calls a rejected request `declined` and names the dates `start_on`/`end_on`; the client maps them to `rejected` and
  `starts_on`/`ends_on`.
- `GET /v1/tenants/{tenantId}/leave-requests` returns every request in the school when the caller holds `resource.leave.read`,
  so `fetchMyLeaveRequests` filters by `staff_user_id` so teachers who also hold the Leave area see only their own requests.
- `fetchAllLeaveRequests` resolves teacher names from `GET /v1/tenants/{tenantId}/staff` (all staff, active or archived) and
  falls back to `"Unknown teacher"` on 403 or when a user has no linked staff record.
- `decideLeaveRequest` posts the review and then creates and publishes an in-app `user`-audience announcement; if only the
  announcement fails (for example, a Leave-only reviewer without `resource.announcement.write`), the decision stands and the
  screen shows the notice error.
### Inventory screen: what the API cannot do yet

`inventoryCapabilities()` in `packages/shared/src/capabilities.ts` hides controls the API does not back yet:

| Hidden on the API build | Missing in the API |
|---|---|
| Edit an inventory item | no `PATCH /v1/tenants/{tenantId}/inventory/items/{itemId}` endpoint |
| Restore a written-off item ("Put back on the register") | no unretire endpoint, and `GET /inventory/items` returns active items only |
| Purchase date, unit cost, and item notes | not stored on the API's `InventoryItem` schema |
| History tab and Lost counter | `GET /inventory/issues` returns open (`status = 'out'`) issues only |
| Hand-out note when issuing an item | `POST /inventory/issues` has no `note` field (`POST .../close` does) |
| Charge lost or damaged items to fees | waits on closed-issue history and charge-by-issue lookup |
| Teacher's "My items" (`teacher/items`) | `GET /inventory/issues` requires `resource.inventory.read`, which regular teachers do not hold |

How the model is mapped (`packages/shared/src/api/inventoryApi.ts`):

- `POST /inventory/issues` requires `holder_user_id` to be an active school membership `user_id`, so the staff picker lists
  only staff directory records linked to a user account.
- Issuing to a whole class verifies that enough copies are on the shelf for every active learner in the class who does not
  already hold one, then sends individual `POST /inventory/issues` calls 4 at a time (`settlePool`).

Where the model differs it is mapped in `packages/shared/src/api/setupApi.ts`: a class belongs to an academic year (the screen
shows the current year's classes, and a class needs a current year, which "Start a term" makes); a teacher is a staff record,
so every teacher id on an API build is a staff id; a term "starts" by finding or making the year, making the term, and
setting both current; the API has no batch for classes or subjects, so "bulk add" sends them one at a time and says how
many were made if one is refused.

### People: what the API cannot do yet

The People page (Students & staff) works the same way: `peopleCapabilities()` hides what the API has no endpoint for, and
the shared function behind it throws `NotOnApiError`.

| Hidden on the API build | Missing in the API |
|---|---|
| Delete a learner | no delete: learners are archived and restored |
| Taking a learner out of their class ("Unassigned") for a learner who has one | a class a learner leaves cannot be given back that year (finding 7) |
| Change class for several learners at once; Export | no bulk move; exports are async jobs, not ported |
| The roster's Guardian, Login and Fees columns | the Guardian column shows no real data on either build yet; learners have no sign-in; fees are their own area, not ported |
| Learner sign-ins: create logins, password resets | learners have no accounts on the API |
| Guardian sign-in made by the school (login ID and password), "Send sign-in details again" | guardians sign in through an invitation, not a password the school chooses: see "Sign-in invitations" below |
| Home address and bus, health, documents, early sign-outs, sports and activities, photos, bio data and bio-data requests | not in the API's learner record, or not ported yet |
| Staff accounts made with a password, Remove staff, a teacher's subjects, calls; admin access on the staff card | staff are directory records, and a sign-in comes from an invitation (see "Sign-in invitations"); admin access is on Access & roles; no delete (archive instead) |
| The import's home and health columns | the API's import has five columns: admission_no, full_name, gender, date_of_birth, boarding |

Shown only on the API build, because the API has them and Supabase does not: archive and restore for staff (with an
Archived view), an "Add a guardian" contact form, and adding a learner with no class yet.

How the model is mapped (`packages/shared/src/api/peopleApi.ts`):

- A learner's class is a class membership, one active per learner per academic year. The roster shows the membership in a
  class of the current year. A move ends that membership and makes the new one.
- Archiving a learner leaves their membership active, so counts use only active learners' memberships.
- There is no bulk write. Archive, restore and placing imported learners go one at a time, four at once, and a failure says
  how many were done.
- The import: the page checks the file as before and leaves out the rows that need fixing. The API then checks the rest
  (1,000 rows per call); if it refuses any row, nothing is imported and the message names the line in the person's own
  file. Then the learners are made, and each is placed in the class the file named.
- What a person may read depends on their areas. A teacher holding only People reads and adds learners and staff, but cannot
  read classes, memberships or guardians, and cannot import. Those parts show "none" instead of failing the page, and a
  change to a learner's name does not touch their class.

## Where the code is

- `packages/shared/src/api/`: `schema.d.ts` (generated), `client.ts` (the one way to call the API), `errors.ts`,
  `tokenStore.ts`, `paging.ts`, `authApi.ts` (login, MFA, password), `sessionApi.ts` (who is signed in and their school),
  `sessionEvents.ts`, `signInFlow.ts` (what comes next after a password).
- `packages/shared/src/api/setupApi.ts` and `peopleApi.ts`: the API side of `schoolSetup.ts`, and of `peopleRoster.ts`,
  `learners.ts` and the guardian list in `learnerBio.ts`. `pool.ts` runs writes a few at a time.
- `packages/shared/src/api/attendanceApi.ts`: the API side of `attendanceSession.ts`, `earlySignOut.ts`, and the attendance
  register reads/writes in `teacherData.ts` (writing registers one learner per request, max 4 in flight until A4 bulk write).
- `packages/shared/src/api/leaveApi.ts`: the API side of `leave.ts` (`admin/leave` and `teacher/leave`), plus the API short-circuit in `hrLeave.ts`.
- `packages/shared/src/api/inventoryApi.ts`: the API side of `inventory.ts` (`admin/inventory`), plus API guards in `feeCharges.ts`.
- `packages/shared/src/api/accountApi.ts` and `accessApi.ts`: the API side of `profile.ts` and `notificationPreferences.ts` (My account), and of `adminAreas.ts` plus the guardian-access and delegation calls (Access & roles).
- `packages/shared/src/capabilities.ts`: what each area can do on this build's backend.
- `packages/shared/src/backend.ts`: `initBackend`, `onApi()`.
- `packages/shared/src/session.ts`: every function branches on `onApi()`, so the screens that use `useSession`
  need no change when their area is ported.
- `apps/web/src/lib/client.ts` starts the right backend; `apiTokenStore.ts` keeps the token in `localStorage`.
- `apps/web/src/api/`: the screens of an API build. `ApiConsole.tsx` is the shell (menus, the page gate, the two home pages).
  The pages it serves are registered in `apps/web/src/api/pages/`: one `<area>.pages.tsx` file for each area, which exports
  `pages` (`{ admin: [...], teacher: [...] }`, see `pages/types.ts`). `pages/index.ts` picks every such file up and builds
  `API_ADMIN_PAGES` and `API_TEACHER_PAGES` and the routes from them, so **a new area adds a file there and does not edit
  `ApiConsole.tsx`**. Wrap a `lazy()` page in `<Lazy>` (from `pages/Lazy.tsx`).

Each area describes its own code in its own file in `docs/web-on-api/`, not in the list above.

`packages/shared/src/api/schema.d.ts` is generated from `apps/api/openapi/openapi.yaml`:

```
npm run api:types          # regenerate it
npm run api:types:check    # CI: fails if the committed file is out of date
```

So a path that is not in the API's contract does not compile, and a contract change comes with the new file.

## Running it locally

1. The API (see `apps/api/README.md`): a Postgres, `migrate`, the `figbloom_app` login, a session key
   (`apps/api/scripts/session-hmac.mjs`), and the first super administrator (`apps/api/scripts/bootstrap-admin.mjs`).
   Start it with `CORS_ALLOWED_ORIGINS` set to the web's exact origin, e.g. `http://localhost:5173`.
2. Make a school and its admin through the API (`POST /v1/platform/schools`, then accept the invitation).
   Note that `organization_name` is required in practice (see below).
3. The web: `VITE_BACKEND=api VITE_API_URL=http://127.0.0.1:4199 npm run dev`.

The API enforces two-step verification outside `MFA_ENFORCEMENT=off`. A code is accepted once, so a second sign-in
inside the same 30 seconds needs the next code.

## Things found in the API while doing this (for Ancel)

1. `POST /v1/platform/schools` says a single-school organization is made "unless `organization_id` is given", but the
   database function refuses without `organization_name` (a 400 "Invalid request" with no details).
2. `/v1/auth/me` memberships carry no school slug or name, and a signed-in person has no way to go from a membership to
   its slug (the public lookup `GET /v1/public/schools/{slug}`, PR #414, goes the other way, slug to school, for the
   login-ID sign-in), so the client asks `GET /v1/tenants/{id}` for each membership to find the school at `/s/<slug>`. Adding `slug` and `name` to each
   membership would remove those calls.
3. Several answers have no `required` list in the OpenAPI file (`Me`, `TenantRecord`), and the MFA answers are
   `{ [key: string]: unknown }`. The client checks what it reads and types the MFA answers by hand from
   `apps/api/src/http/routes/auth.ts`.
4. A POST with `Content-Type: application/json` and no body is a 400. The client only sends the header with a body.
5. A teacher holding only the Academics area may read classes and subjects but not the staff list (`resource.staff.read`),
   so they see no class-teacher names and have no teachers to pick. A teacher list readable with Academics, or the
   teacher's name in the class record, would fix it.
6. Edit and remove for classes, subjects and teaching assignments, and a bulk create for classes and subjects, are the
   gaps the setup screens hit (the table above).
7. **A learner can never go back into a class they left that year.** The unique index
   `class_memberships_learner_class_year_uidx` (migration 029) is on `(tenant_id, learner_id, class_id, academic_year_id)`
   with no `WHERE active`, so an ended membership still blocks it. The 409 says "Learner already has an active class
   membership for this academic year", which is not what happened. There is also no endpoint to undo an ended membership
   or to move a learner in one call. The web refuses such a move before changing anything, and does not offer
   "Unassigned" for a learner who has a class. A partial index (`WHERE active`), or a move endpoint, would fix it.
8. **Archiving a learner leaves their class membership active**, so anything that counts memberships also counts learners
   who have left. The Classes page did; the web now counts only active learners' memberships. Ending the membership on
   archive (and giving it back on restore), or a count endpoint, would be simpler for every client.
9. **A teacher holding only People** can add learners, but cannot read classes or memberships, place a learner in a class
   (that needs Academics), read guardians (the administrator's, or a per-person grant) or import (`resource.import.write`).
   A secretary admitting learners therefore cannot put them in a class.
10. **The learner import** has no class column and reads at most 1,000 rows. The web sends files in batches of 1,000 and
    places each learner afterwards, one call each. A class column would make the import one atomic step.
11. **Validation answers** put the real problem in `details`; the message is a generic list of the required fields
    ("admission_no, full_name and gender (male|female) are required; ..."). The web turns `details` into words ("Phone is
    not in the right format."). The import's own errors use the column names ("date_of_birth is not a valid date").
12. **Leave requests carry no staff name.** `GET /v1/tenants/{tenantId}/leave-requests` returns `staff_user_id` without the
    requester's name. The web resolves names from `GET /v1/tenants/{tenantId}/staff`, which fails with 403 for a teacher holding
    only the Leave area (not People) and misses any user without a linked staff record (falling back to `"Unknown teacher"`).
    Including `staff_name` on `LeaveRequest` would remove the extra call and fix Leave-only reviewers.
13. **Inventory read and lifecycle gaps.** `GET /v1/tenants/{tenantId}/inventory/issues` returns open (`status = 'out'`) issues
    only and requires `resource.inventory.read` (so regular teachers get 403 on `teacher/items`, and admins cannot view closed
    issue history or Lost totals). Items also lack `PATCH` (edit), unretire, and `purchased_on`/`unit_cost_cents`/`notes`.
