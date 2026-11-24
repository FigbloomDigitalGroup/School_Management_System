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
