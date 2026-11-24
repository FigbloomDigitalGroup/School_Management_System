# The web app on the new API (FIG-1890: sign-in, school setup, people)

Written 2026-11-23. The first steps of moving the web app from Supabase to `apps/api`: the client, the switch, sign-in,
the school-setup screens (School settings, Classes, Subjects) and the People page (Students & staff). Everything else in
the web app still reads Supabase and is **not in an API build**.

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

- Sign in with **email and password**.
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
| Sign in with a school ID | `POST /v1/auth/login/login-id` takes the school's UUID and there is no public school search or login-ID lookup (FIG-1872) |
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

### Report cards: what the API cannot do yet

`reportCardsCapabilities()` in `packages/shared/src/capabilities.ts` hides controls the API does not back yet (`admin/report-cards` and `teacher/report-cards`), and the shared functions behind them throw `NotOnApiError`:

| Hidden or different on the API build | Missing or different in the API |
|---|---|
| Choosing a subset of exams, and toggling position, attendance, fees, activities, or next-term date | `POST /v1/tenants/{tenantId}/report-cards` takes `{ term_id, class_id, grading_scheme_id? }` and always aggregates every published assessment, published/closed CBE assessment, and competency rating for that class and term |
| Draft state, "Send to families", and "Withdraw all" | `POST /report-cards` publishes immediately; there is no draft or withdraw endpoint |
| Per-learner class teacher and principal comments (and "Suggest missing comments") | `report_card_publications` stores a class-level `figures` snapshot with no per-learner comment fields |
| Signing report cards and printing signatures on PDFs | document signatures wait on C12 (`FIG-1880`) |
| "Draft comments with Bloom" (AI helper) | calls a Supabase edge function |
| Clearing a competency rating back to unrated | `POST /v1/tenants/{tenantId}/competency-ratings` only sets `EE \| ME \| AE \| BE`; there is no `DELETE` endpoint |

How the model is mapped (`packages/shared/src/api/reportCardsApi.ts`):

- `fetchClassReportCards` reads `GET /v1/tenants/{tenantId}/report-cards?termId=&classId=` (ordered newest first), takes the latest snapshot, and hydrates one `StoredReportCard` per learner from its `figures` (plus assessment marks, CBE results, and competency ratings) so the table and client-side PDF downloads (`Results sheet (PDF)`, `All report cards (PDF)`, and per-learner `PDF`) work.
- `saveCompetencyRating` tracks `row_version` per rating so updates send the optimistic concurrency version the API requires.
- **Plain teacher (OD-2) scope:** a plain teacher can read `/classes`, `/report-cards`, `/assessments`, `/assessments/{id}/marks`, and `/competency-ratings` for classes they teach, but gets 403 on `/academic-terms`, `/academic-years`, `/learners`, `/subjects`, and `POST /competency-ratings`. `fetchReportCardSetup` discovers terms from existing published report cards when `/academic-terms` returns 403, `fetchClassReportCards` degrades gracefully without learner names if `/learners` returns 403, and `CompetencyRatings` renders read-only when the caller lacks `resource.academics.write`.

## Where the code is

- `packages/shared/src/api/`: `schema.d.ts` (generated), `client.ts` (the one way to call the API), `errors.ts`,
  `tokenStore.ts`, `paging.ts`, `authApi.ts` (login, MFA, password), `sessionApi.ts` (who is signed in and their school),
  `sessionEvents.ts`, `signInFlow.ts` (what comes next after a password).
- `packages/shared/src/api/setupApi.ts` and `peopleApi.ts`: the API side of `schoolSetup.ts`, and of `peopleRoster.ts`,
  `learners.ts` and the guardian list in `learnerBio.ts`. `pool.ts` runs writes a few at a time.
- `packages/shared/src/api/attendanceApi.ts`: the API side of `attendanceSession.ts`, `earlySignOut.ts`, and the attendance
  register reads/writes in `teacherData.ts` (writing registers one learner per request, max 4 in flight until A4 bulk write).
- `packages/shared/src/api/leaveApi.ts`: the API side of `leave.ts` (`admin/leave` and `teacher/leave`), plus the API short-circuit in `hrLeave.ts`.
- `packages/shared/src/api/reportCardsApi.ts`: the API side of `reportCards.ts` and `competencies.ts` (`admin/report-cards` and `teacher/report-cards`).
- `packages/shared/src/api/inventoryApi.ts`: the API side of `inventory.ts` (`admin/inventory`), plus API guards in `feeCharges.ts`.
- `packages/shared/src/api/accountApi.ts` and `accessApi.ts`: the API side of `profile.ts` and `notificationPreferences.ts` (My account), and of `adminAreas.ts` plus the guardian-access and delegation calls (Access & roles).
- `packages/shared/src/capabilities.ts`: what each area can do on this build's backend.
- `packages/shared/src/backend.ts`: `initBackend`, `onApi()`.
- `packages/shared/src/session.ts`: every function branches on `onApi()`, so the screens that use `useSession`
  need no change when their area is ported.
- `apps/web/src/lib/client.ts` starts the right backend; `apiTokenStore.ts` keeps the token in `localStorage`.
- `apps/web/src/api/`: the screens of an API build.

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
2. `/v1/auth/me` memberships carry no school slug or name, and there is no lookup by slug, so the client asks
   `GET /v1/tenants/{id}` for each membership to find the school at `/s/<slug>`. Adding `slug` and `name` to each
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

## Family reads (API side of A1, FIG-1869)

The API now has the reads the parent pages need (PR #359; design and rules in `apps/api/docs/FAMILY-READS.md`). No parent
or student page is ported yet: the web slices come after this merges.

- `GET /v1/tenants/{t}/me/children`: the parent's own children in that school, with each child's current class.
- Per child, `GET /v1/tenants/{t}/me/children/{learnerId}/…`: `attendance`, `results`, `report-cards`, `homework`,
  `materials`, `timetable`, `fees`, `activities`, `items`, `health`. Any learner who is not the caller's child is a 404.
- `GET /v1/tenants/{t}/me/chat-contacts`: who a parent may start a chat with.
- Bus: the existing `/me/transport`.
- Paying (M-Pesa prompt, invoice PDF, payment proof, AI-helper opt-in) now works for a parent whose account link reaches
  the learner. Class and form-level notices now reach the parents of children in them, and a parent may chat with their
  child's teachers.
- All of them need permission `resource.family.read`, which only parents hold.

Things found while doing it:

14. **Learners have no sign-in on the API** (A4). There is no link from an account to a learner record and no flow that
    makes a `student` membership. It needs owner decisions first (who makes the login, how a child without e-mail gets
    a password, session length, MFA, chat); see "Student accounts" in `apps/api/docs/FAMILY-READS.md`. The student
    pages stay on Supabase until then.
15. **Sick-bay notices to guardians are never written.** `medical_notices` exists and parents could read it, but the
    sick-bay module still reports `guardian_notices_available: false` and emits none. The family health read shows the
    visits instead.
16. **Push for class and form-level announcements counts nobody.** The worker's eligibility count covers only
    whole-school, role, user and people audiences (migration 063), for staff and parents alike.

## Account and access (admin/account, teacher/account, admin/access)

Opened from the menu on an API build: **My account** (the avatar menu, and the sidebar's "My account" / "Account" entry) for school
admins and teachers, and **Access & roles** for full admins. The shared account code is built to be reused by `staff/account` and
`parent/settings` (`AccountSections`, `apps/web/src/components/account/`).

### My account

- **Your details**: name, email, sign-in ID, role and school, read from `GET /v1/auth/me`. Read-only (see below).
- **Password**: current password, new password twice, with the server's rule (10 or more characters, letters and numbers). The server
  ends the person's other sessions and keeps this one. The sidebar's "Change password" does the same call.
- **Two-step verification**: its state from `GET /v1/auth/mfa/status`. A person who has it can make new recovery codes (a fresh code
  from the app is needed) and, where their role does not require it, turn it off. Setting it up still happens at sign-in, when the server
  asks for it.
- **How we reach you**: the notification switches of `GET`/`PATCH /v1/me/notification-preferences`, saved when flipped. A staff
  member has "General school notices" and "Chat messages"; a family has all five.
- Every call that needs the password again (`reauth_required`: new recovery codes, turning two-step off, giving access) opens the app's
  own "Confirm your password" prompt (`ApiSessionGuard`) and is retried once.

| Hidden on the API build | Why |
|---|---|
| Changing your own name, phone or second phone | no endpoint: `PATCH /v1/auth/me` does not exist, and `/v1/auth/me` carries no phone |
| Your photo | needs file storage (A5, FIG-1873), and the API holds no photo |
| "Call someone" (teacher) | calls are not on the API (C13) |
| Setting up two-step from the account page | the server only asks for the code from people it requires it of, so a set-up on this page would never be used (finding 18) |
| Turning two-step off, for a person whose role needs it | the server would only ask them to set it up again at the next sign-in |

### Access & roles

Full admins give **admin areas** to a teacher or other staff member, one person at a time (`PUT /v1/rbac/staff-areas`, read back with
`GET /v1/rbac/staff-areas`, the new endpoint of the API PR #362), with the same quick picks and area ticks as the Supabase build. The same
card gives or takes away **access to parents' records** (`/v1/rbac/guardian-access`, read and change apart). **Organization
administrators** who were given access to the school are listed, with a way to take it all back (`/v1/rbac/org-delegations`).

| Hidden on the API build | Why |
|---|---|
| The school's own named roles ("Exams officer": make, edit, delete, give to people) | the API has no write path for school roles (finding 20) |
| Giving an organization administrator access | the list carries user ids only and nothing looks an administrator up; it starts from the organization console, which is not on the API build (finding 21) |
| Admin areas for a person with no sign-in, a driver, a full admin, or yourself | areas belong to a sign-in; the server only lets teachers and staff hold them, and refuses your own |

### API findings (for the API owner)

17. **No way to change your own name, phone or photo.** The `users` table has a `full_name` and a `phone`, but there is no
    `PATCH /v1/auth/me`, and `GET /v1/auth/me` returns no phone. The staff directory holds its own name and phone for the same person, so
    one of the two would have to win.
18. **Two-step is only asked of the people it is required of.** `auth_mfa_state` makes `required` true for admins, org admins, super
    admins, anyone with the Fees area (and `MFA_REQUIRED_ROLES`). A teacher who sets it up anyway is never asked for the code at
    sign-in, so it protects nothing. The account page therefore offers no set-up to people who are not required.
19. **Nothing read another person's admin areas** (`GET /v1/rbac/permissions` is the caller's own), so `PUT /v1/rbac/staff-areas`, which
    replaces, could only be used blind. `GET /v1/rbac/staff-areas` is added in the API PR #362: one row per person with areas of their
    own, keyset-paged, for holders of `rbac.staff_areas.manage`.
20. **School roles have tables and a place in `authorize.ts` but no endpoints** (`school_roles`, `school_role_assignments`), and the API's
    own test says they have no write path. The Access screen shows none.
21. **Delegations name nobody.** `GET /v1/rbac/org-delegations` gives `delegateUserId` only, and no endpoint lists an organization's
    administrators, so a school cannot choose one to give access to.
22. **The password rule is not in the contract.** `passwordPolicy.ts` wants 10 or more characters with letters and numbers; the OpenAPI
    file says nothing, and the web's sidebar dialog said 8 (fixed here).

## Grades: exams, the gradebook, performance and reports

Five pages: `admin/exams`, `teacher/gradebook`, `admin/performance` and `teacher/performance` (one screen), and `admin/reports`.
They are the Supabase app's own screens. The API side is `packages/shared/src/api/gradesApi.ts` (exams and marks),
`performanceApi.ts` (the charts) and `reportsApi.ts` (the term report); `gradesCapabilities()` and `fetchGradesAccess()` in
`capabilities.ts` and `teacherData.ts` say what is hidden. Report cards are not here (another slice).

### How the API's model differs

- **An exam is a name for the term** on Supabase. The API has no such record: it has an **assessment for each class and
  subject** (a title, a kind, `max_score`, a status of draft, published or closed). So on the API an exam is every assessment
  of kind `exam` with the same title in a term, and its id is `<termId>|<title>`. "New exam" makes one assessment for every
  class of the term's year and subject that has a teacher (one request each, four at a time). "Add new class subjects" makes
  the missing ones later, when a subject was given a teacher after the exam was made.
- **The paper's total is `max_score`** (up to 10,000, decimals allowed), not a fixed 100. "New exam" asks for it. The
  Gradebook header, the limit on a mark and the decimals follow it. Grades and means are worked out as percentages, so exams
  with different totals still compare.
- **Publishing is final and is the Academics area's.** A teacher who is assigned the class and subject can save marks (a
  draft) but cannot publish; the school office publishes from the Exams page (the "Papers" window: publish or close one paper,
  or all drafts). A published paper's marks are locked, so "Withdraw results" does not exist and the boxes are read-only.
- **There is no "absent" mark.** `abs` saves nothing for that learner; a saved mark cannot be taken back to absent (the web
  refuses before writing anything).
- **No bulk write.** Marks are sent four at a time; only marks that changed are sent (with the `row_version` they were read at);
  a failure says how many were saved ("Saved 2 of 3 marks (1 failed: ...)").

### What a person can do, by role (checked on a real API)

| | School admin | Teacher with the Academics and People areas | Plain teacher (class or subject teacher, no areas) |
|---|---|---|---|
| Exams | all of it: new exam, papers, publish, close, add new class subjects | no menu page unless the Academics area opens the admin console; publishing needs `resource.academics.write` | no page |
| Gradebook | not a teacher page (no classes of their own) | enters marks for the classes and subjects they teach, and publishes | **cannot open it**: the page says why |
| Performance | the whole school, or one class | their classes | **cannot open it**: the page says why |
| Reports | all of it (full admins only, as on Supabase) | no page | no page |

A plain teacher can read classes, class memberships, assessments and marks of the classes they teach (OD-2). They cannot read
the terms or the subjects (`resource.academics.read`) or the learners' names (`resource.learner.read`), so the Gradebook has no
term, no subject names and no learners to show. The page says: "The new system does not let you read this school's terms,
subjects and learners with the access you have, so the Gradebook cannot open for you yet. Ask the school office to give you the
Academics and People areas." Performance gives a sentence of the same kind. This is the gap that also stops the teacher's
Attendance page for a plain teacher (finding 23).

### What the API cannot do yet (hidden on the API build)

`gradesCapabilities()` hides these, and the shared function behind each throws `NotOnApiError`:

| Hidden on the API build | Missing in the API |
|---|---|
| Rename an exam; delete an exam | no change or delete for an assessment's title (the same missing PATCH and DELETE as classes and subjects) |
| "Marks entered" on the Exams page | an assessment carries no mark count; the "Papers" window counts each paper's marks with one read each |
| Withdraw results; change a published mark | publication is final; a correction (`/mark-corrections`, needs a reason, Academics writers) is not built in the web yet |
| The CBE strand gradebook (the "Strand assessment" tab) | a subject has no learning area, so its strands cannot be found; CBE results are written by Academics writers only |
| The higher-education gradebook | the API keeps one final grade for each enrolment (`/he-enrolments/{id}/grade`), not a section's assessments and marks; the screen shows a sentence |
| The CBE rubric charts on Performance, the CBE table on Reports | the figures need the learning-area link above (the functions answer "none") |

### How the figures are worked out

- **Performance** (`performanceApi.ts`): the published and closed papers of kind `exam` (one list), their marks (one read per
  paper, six at a time, kept for a minute because a published paper's marks are final), the terms, subjects, classes and who
  teaches each (staff names only if the staff list may be read). Rows are percentages of each paper's own total. Only published
  results count, like Supabase.
- **Reports** (`reportsApi.ts`): the API's reports (`/reports/overview`, `finance-summary`, `academics-summary`) are
  whole-school counts with nothing by class. So attendance comes from `/attendance-counted` (every entry of the term, 200 to a
  page, counted by class), fees from the term's invoices joined to each active learner's class, and the class means from the
  marks of the latest exam to go out. A class mean uses published papers only (Supabase's counted any entered mark, FIG-1441).
  A big school waits longer than it did on Supabase (finding 25).

### Things found in the API while doing this

(Numbered so that no other slice shares a number: this slice's findings are 23 to 28.)

23. **A plain teacher cannot read what the teacher pages need.** They read classes, memberships, teaching assignments, assessments
    and marks (OD-2 scoped), but `/academic-terms`, `/subjects`, `/learners` and `/staff` answer 403, so they have no term, no
    subject names, no learner names and cannot tell which subjects are theirs. The Gradebook, Performance and the teacher's
    Attendance page cannot work for them. A teacher read of the current term, of the subjects they teach, and of the names of
    the learners in classes they teach (on `/class-memberships`, say) would fix all three.
24. **A teacher cannot publish their own marks.** Mark writes are open to the assigned teacher; `publish` and `close` need
    `resource.academics.write`. Supabase let each teacher publish their own class and subject. If that is wanted, `publish`
    could accept the assigned teacher, as the mark write does. Publication is also final (no withdraw), and a mark cannot be
    deleted or saved as "absent" (`score` is required).
25. **No per-class term figures.** Reports needs attendance, fees and marks by class for a term. Supabase did this in
    `term_class_figures`. On the API the web reads every attendance entry of the term (`/attendance-counted`, 200 a page): a
    school of 500 learners over a 60-day term is about 150 requests, one of 1,500 about 450. A `GET /reports/term-class-figures`
    (attendance here and total, billed and paid, and a mark mean for an exam, per class) would be one request. Also,
    `/attendance-counted` accepts `classId` in the route and the description, but the OpenAPI file does not list the parameter.
26. **An exam is not a record.** An exam is a title shared by the per-class assessments, so it has no rename, no delete, no
    mark count, and making one takes one request for each class and subject. A term-level exam record (name, total) that the
    assessments point to would give all of these, and let the web publish a whole exam in one call.
27. **A subject has no learning area**, so a CBE assessment (`learning_area_id`) cannot be chosen from the subject a teacher
    teaches, and the strands of a subject cannot be found. CBE results can be written only by Academics writers.
28. **Higher education marks.** The API has one grade per enrolment and no section assessments with marks, so the course
    gradebook (`GpaGradebook`) has nothing to run on.

## Chats, notices and messages

`admin/chats`, `teacher/chats`, `teacher/notices` and `teacher/messages` run on an API build. The screens are the Supabase
app's own; the shared functions behind them (`chat.ts`, the notice functions in `teacherData.ts` and `otherStaff.ts`,
`subscribeAnnouncements` in `parentData.ts`) branch on `onApi()` into `api/chatApi.ts`, `api/noticesApi.ts`,
`api/inboxApi.ts` and `api/directoryApi.ts`. `staff/chats` and `staff/notices` use the same functions: when the staff shell
exists it needs only the two routes.

| Page | On the API build |
|---|---|
| `admin/chats` | "My chats" only: list, start a chat, read and send text. The "All school chats" and "Calls" tabs are hidden |
| `teacher/chats` | The same list and thread. A plain teacher cannot see names or start a chat (finding 29) |
| `teacher/notices` | The inbox, newest first, with the notice's text. No unread marks, attachments or signatures |
| `teacher/messages` | Opens. A teacher without the Communication area gets a message saying why instead of a composer (finding 33) |

### Polling instead of realtime

The API has no push channel, so `packages/shared/src/api/poll.ts` asks again every few seconds. The header of that file
is its documentation. In short: `startPolling`, `pollNewItems` (the shape of `subscribeChatMessages` and the other
`subscribe*` helpers that deliver rows) and `pollChanges` (the shape of `subscribeAnnouncements`); one request at a time;
paused while the tab is hidden and after 10 minutes with no input, so a tab left open does not keep the API's idle timer
alive; one catch-up request when the person comes back; a longer wait after failures. An open thread asks every 4.5 s, the
chat list every 10 s, the notices inbox every 30 s. The fleet, visitors and parent slices use the same file.

### What is hidden on this build, and why

`chatCapabilities()` and `noticesCapabilities()` in `packages/shared/src/capabilities.ts`; the shared function behind each
control throws `NotOnApiError`.

| Hidden | Missing in the API |
|---|---|
| Sending and opening files in a chat | chat messages are text only; files wait on storage (A5, FIG-1873) |
| Voice and video calls, and the school's call log | not in the contract (C13) |
| "All school chats" (the office reading every chat) and the line "The school's administrators can read this chat" | nobody can read a chat they are not in, the office included (finding 30) |
| Unread counts: the menu badge, a bold name, the count on a chat | the API does not say what a person has read (finding 29) |
| Unread dots and the menu badge on notices | the inbox has no read state (finding 32) |
| Notice attachments, "Waiting for your signature", the AI writing helper in Messages | storage (A5), signatures (C12), an edge function; the same as the Announcements page |
| A list of people to start a chat with, for a person who may not read the staff list | there is no contacts endpoint (finding 29) |

### How the model is mapped

- A chat has `peer_user_id` and `last_message_at`, nothing else. The other person's name comes from the staff list
  (`GET /staff`, which needs `resource.staff.read`: a school admin and the People area have it, a plain teacher does not),
  kept for a minute per school. Without it the chat shows "Someone at the school". Parents and learners cannot be named:
  guardian contacts carry no account id.
- The chat list's preview is the newest message of each of the 30 latest chats, one small request each.
- "Start a chat" offers staff who have an account (`userId` on the staff record), active, other than the person. Who may
  talk to whom is the server's `may_talk`: staff with staff, a parent with the school office. A refused pair is a 403 on
  the first message, shown as the server's own words.
- A thread is the newest 1,000 messages. A poll asks for the newest 50 and merges by id.
- The notices inbox is `GET /communications/announcements/inbox`: what reaches the person (whole school, their role, them by
  name, the classes they teach) and what they wrote. That is more than the Supabase list, which showed only whole-school
  notices and ones sent to the teacher by name. "From" is "You" for their own, a teacher's name when the staff list can be
  read, else "School office".
- "Sent by you" is the person's own published notices, read from the inbox (a teacher cannot read the composer's list, and
  drafts are not in the inbox). Opening a notice calls `POST .../read` once, for when the inbox says what is read.
- A class message is an in-app announcement with audience `{ kind: "class", class_id, recipients }`, created and published.
  `recipients` is stored but the server's reach rule ignores it. Parents and learners are not reached until their accounts
  are linked (FIG-1869): only the teachers of that class see it. The composer says so.
- A teacher who holds an admin area lands in the admin console on this build, which has no console switch yet. Their
  `teacher/chats`, `teacher/notices` and `teacher/messages` are reachable by address only, as `teacher/leave` is.

### Things found in the API while doing this (for the owner)

29. **The chat list is only ids.** `GET /chat/conversations` answers `peer_user_id` and `last_message_at`: no name, no role,
    no last message, no unread count. There is also no "people I may chat with" list, no unread count and no single-chat
    read. A plain teacher cannot read `/staff`, so every chat is "Someone at the school" and they cannot start one. Add to
    each conversation `peer { user_id, full_name, role }`, `last_message { body, sender_id, created_at }` and
    `unread_count` (from `conversation_members.last_read_at`, which exists and is never returned), plus
    `GET /chat/contacts` (the people `may_talk` allows, with a name and a role) and `GET /chat/unread-count`.
30. **No oversight read.** `listMessages` needs membership of the chat, so the office cannot read other people's chats, and
    there is no school-wide list. The Supabase app tells families and teachers "The school's administrators can read this
    chat", and the Communication area is described as reading the school's chats. That is a product and privacy decision
    first, an endpoint second.
31. **Chat messages come newest first with no `since`**, so a poll re-reads a page. A `since` (or `after`) cursor on
    `GET .../messages` and on the conversation list would make polling cheaper (B7).
32. **The announcements inbox has no read state and no author name.** Items have the composer's shape, with `author_id`
    only. `communications_announcement_reads` is written by `POST .../read` and never returned. Add `read_at` (null when
    unread) and the author's name and role to each inbox item. Class and year-group notices also reach no parent or learner
    until their accounts are linked (FIG-1869), and `recipients` in a class audience is ignored by
    `communications_audience_reaches`.
33. **A teacher cannot send a class message.** `POST /communications/announcements` and `.../publish` need
    `resource.announcement.write`, which only the school admin role and the Communication area hold. The check for a `class`
    audience does not look at who the sender is: anyone with the permission can post to any class. A rule that lets a teacher
    create and publish a `class` announcement for a class they teach (the reach function already knows who teaches what)
    would make the Messages page work for the people it is for. It widens who may write to families, so it is the owner's
    call.
34. **`/notifications` is not announcements.** It lists generic in-app notifications (transport, medication and so on; its
    items are an untyped `object` in the OpenAPI file), and publishing an announcement creates none. The Notices page does
    not use it. A bell or a notification centre would be a new screen the web app does not have.

## Sign-in invitations (People page)

On the API a sign-in is made by an **invitation**, not by the school choosing a password. The People page now has:

- **Learner card, Guardians:** each guardian with an e-mail or phone has **Invite by e-mail** (or **by SMS** when there is no e-mail). An open
  invitation shows "Invited (r***@gmail.com), open until ...", with **Send again** (a new invitation replaces the open one) and **Cancel invitation**.
- **Invite guardians** (toolbar, selected learners): the same controls for every guardian of up to 25 selected learners, with a line saying families
  cannot read anything on the new system yet.
- **Staff card, Sign-in:** a staff record with no sign-in is invited by e-mail (a teacher, other staff or a driver; an administrator's sign-in is made
  by the platform). A record that has a sign-in can have a one-time **reset link** made (needs the password confirmed again).
- Every invitation or reset answers `delivery`. When the message was not sent (no e-mail provider, or it failed; a local API never sends) the
  single-use code or link comes back once and is shown for the school to hand over, with a Copy button. Staff links are the web's own
  `/accept-invite?token=` and `/reset-password?token=` addresses.

| Hidden or missing on the API build | Why |
|---|---|
| A list of open staff invitations (the staff card shows only the one sent in this visit, which can be cancelled) | no endpoint lists them (finding 35) |
| Joining the new sign-in to the staff record by itself | nothing tells the web which sign-in accepted: the record's `userId` can only be set with a user id the web cannot find (finding 36) |
| A page where a guardian accepts the code | the guardian accept endpoints exist (`/v1/guardian-invitations/preview` and `/accept`) but the web has no page for them, and families can read nothing yet (FIG-1869) |
| Guardian invitations by e-mail text | the server sends no e-mail for guardian invitations (they are "handed over as a code or QR by the school"), so a guardian invitation always shows the code |
| Making a reset link for yourself or for an administrator | the server refuses both |

### API findings (continued)

35. **No list of open staff invitations.** `POST /v1/tenants/{id}/invitations` and its `revoke` exist; nothing lists them, so a page cannot show who
    was invited and is still waiting. Guardian invitations have a list.
36. **Accepting a staff invitation does not link the staff record.** The invitation takes an e-mail, a role and a name, and accepting makes a user and a
    membership; the staff record keeps `userId: null`. `PATCH .../staff/{id}` can set `userId`, but nothing returns a user's id (no members list, no
    lookup by e-mail). Linking by e-mail inside `account_accept_invitation` (a staff record of the school with the same e-mail and no `userId`), or a
    `staff_id` on the invitation, would fix it. Until then an invited teacher has a sign-in but is not "their" staff record (their classes, leave).
37. **Guardian invitations carry no e-mail and no accept page.** `guardian_invitation` messages are never sent (the e-mail notifier returns
    `not_configured` for them), so the school hands over the code, and the web has no page that takes it.


## Timetable, My classes and Courses

Pages: `teacher/timetable`, `teacher/classes`, the Timetable window of a class on `admin/classes`, and `admin/courses` (higher-education
schools). `teacher/sections` is not on the API build (see below). Capability flags: `timetableCapabilities()` and
`coursesCapabilities()` in `packages/shared/src/capabilities.ts`. The API side is `api/timetableApi.ts`, `api/teachingLookups.ts`,
`api/teachingApi.ts` and `api/coursesApi.ts`.

**Needs API PR #363 merged first:** `GET /v1/tenants/{id}/staff/me` (a person's own staff record) and a teacher-scoped
`GET /subjects` (the subjects of the classes they teach). Without them these pages still open, but a plain teacher cannot tell which
periods and classes are theirs, a period's subject shows as "Lesson", and My classes lists no subjects.

### What works

- **Timetable (teacher):** the classes the teacher teaches or leads; one class's week or all of them; the class teacher sees the
  whole week of their homeroom (each period says whose it is), a subject teacher sees only their own periods. Times and rooms come
  from the class's timetable slots.
- **My classes (teacher):** the classes, the person's role in each (class teacher or subject teacher), the subjects they teach
  there, the roll size.
- **Classes > Timetable (admin):** the class's periods, Monday to Friday, with start and end times, subject, teacher and room; add a
  period (day, start, end, subject, room). An overlapping period is refused by the API and the window says so.
- **Courses (admin, higher-education schools):** semesters (= academic terms: list, add, set as current), the course catalogue (list,
  add), sections of a semester (list, add), a section's roster (list, enrol learners).

### How the model is mapped

- A timetable **slot** has a subject, a day number, a start and an end time and a room. It has no free-text label, so a period is
  named by its subject; "Games", "Library" or "Break" can only be periods if the school makes them subjects. Saturday and Sunday
  slots are not shown (the screens' week is Monday to Friday).
- Who teaches a period is the **teaching assignment** of that subject in that class (the slot's own link when it has one). "Mine"
  means "assigned to my staff id", found with `GET .../staff/me`.
- A class records its class teacher as a staff id. In a teacher's own class list, a class they lead carries their sign-in id as
  `class_teacher_id`, so the screens' existing "am I this class's teacher" check works (this also fixes the early sign-out check on
  the teacher Attendance screen).
- A **semester is an academic term**. "Add semester" finds or makes the calendar year (1 January to 31 December), then the term.
  "Set as current" also sets the term's year current. Every higher-education call is refused (400) unless the school's profile says
  it is a higher-education school.
- A course's **title** is the screens' course name and its **credit hours** are its credits. The API has no batch, so enrolling
  several learners goes one at a time (four at once) and a refusal part-way says how many went in.
- The school-wide lookups of a timetable page (subject names, staff names, the person's own staff id) are kept for 8 seconds so a
  page of six classes asks for them once.

### What a plain teacher can and cannot do on the API

A plain teacher (no area) reads only the classes they teach (OD-2), and those classes' memberships, assignments and timetable
slots. They cannot read the staff list, learners or academic years/terms. So on the Timetable page they see their periods; a colleague's
name is missing from the class teacher's whole-class view; and the page's "Timetable · Term 1" heading is missing (no term read).
A teacher who teaches nothing sees "You aren't assigned to any classes yet." A person with no staff record (a school administrator
who was never added to the directory) has no periods of their own.

### What the API cannot do yet (hidden on the API build)

| Hidden on the API build | Missing in the API |
|---|---|
| The week-grid editor of a class's timetable (replaces the whole week; CSV import) | a slot can be made and listed, not changed or removed; so there is a list and an "Add a period" form instead |
| A free-text period label ("Games", "Library", "Break") | a slot is a subject's period, with no label |
| "Needs cover" and "Covered by" on a teacher's timetable | `/attendance-coverage` is attendance cover by class and day, not cover for a period, and a plain teacher cannot read others' leave |
| The "Live classes" panel on the teacher Timetable | calls and live classes are not in the API |
| A course's department | a course is a code, a title and credit hours |
| A section's instructor, room, capacity and weekly schedule | a section is a course in a term with a label |
| Dropping a student from a section | an enrolment can be made; nothing ends it (the status `withdrawn` exists, with no endpoint) |
| **`teacher/sections` ("My sections")** | no instructor on a section, so a lecturer's sections cannot be found. The page is not on the API build |

`/timetable-publications` (a versioned snapshot of a class's timetable that is published) has no Supabase counterpart and nothing
on the web reads it, so it is not used.

### API findings (numbered 38 to 44 so that no other slice shares a number)

38. **A plain teacher cannot learn their own staff id.** Class teachers, teaching assignments and timetable slots name staff ids, a
    teacher cannot read the staff list, and `/auth/me` has no staff id. Fixed in API PR #363 with `GET /staff/me`.
39. **A plain teacher cannot read the subject list**, so a timetable slot or a teaching assignment (subject ids) cannot be named, and
    "My classes" cannot list subjects. Fixed in API PR #363: `GET /subjects` is scoped like the class list (OD-2) to the subjects of
    the active teaching assignments and timetable slots of the classes they teach.
40. **Colleagues' names:** the class teacher's whole-class timetable would name each period's teacher, which needs the staff list.
    A plain teacher sees no name. A staff name inside the teaching-assignment record, or a scoped staff read, would fix it.
41. **A timetable slot cannot be changed or removed**, and a slot needs a subject (no "Break", "Games", "Assembly").
42. **A higher-education section has no instructor, room, capacity or schedule**, and an enrolment cannot be ended. So a lecturer's
    "My sections" cannot be built on the API, and the admin cannot name an instructor.
43. **The OpenAPI file does not declare** `sectionId` on `GET /he-enrolments` or `courseId` on `GET /he-sections`, although the routes
    honour them. The typed client cannot send them, so a section's roster lists every enrolment of the school and picks the section
    out. Declaring them would make it one small call.
44. **Per-period cover for approved leave** (the Supabase "Needs cover" list) has no API counterpart: `/attendance-coverage` assigns
    who may take a class's register on a day.

### API findings: report cards and competency ratings (numbered 45 and 46 so that no other slice shares a number)

45. **Report cards are class-level published snapshots only.** `POST /v1/tenants/{tenantId}/report-cards` publishes immediately
    with no draft/withdraw workflow, no per-learner teacher/principal comments, and no learner names in `figures`. For a plain
    teacher (OD-2), `GET /report-cards` works for taught classes, but `GET /academic-terms` and `GET /learners` return 403,
    so a plain teacher cannot pick terms that have no published report cards yet and sees fallback learner labels instead of
    full names.
46. **Competency ratings cannot be cleared and require `resource.academics.write`.** There is no `DELETE` endpoint for
    `/v1/tenants/{tenantId}/competency-ratings`, and `POST` requires `resource.academics.write`, so a plain class teacher
    can view ratings for their taught classes (`GET` is OD-2 scoped) but cannot save ratings on the API yet.
