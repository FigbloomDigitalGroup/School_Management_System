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
| Invite guardians, send their sign-in again | guardian invitations exist, but families can read nothing yet (FIG-1869) |
| Home address and bus, health, documents, early sign-outs, sports and activities, photos, bio data and bio-data requests | not in the API's learner record, or not ported yet |
| Staff accounts: admin access, password reset, Remove staff, a teacher's subjects, calls | staff are directory records (a name, a role, contact details), not accounts; accounts come from invitations, not ported |
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
| Setting up two-step from the account page | the server only asks for the code from people it requires it of, so a set-up on this page would never be used (finding 14) |
| Turning two-step off, for a person whose role needs it | the server would only ask them to set it up again at the next sign-in |

### Access & roles

Full admins give **admin areas** to a teacher or other staff member, one person at a time (`PUT /v1/rbac/staff-areas`, read back with
`GET /v1/rbac/staff-areas`, the new endpoint of the API PR #362), with the same quick picks and area ticks as the Supabase build. The same
card gives or takes away **access to parents' records** (`/v1/rbac/guardian-access`, read and change apart). **Organization
administrators** who were given access to the school are listed, with a way to take it all back (`/v1/rbac/org-delegations`).

| Hidden on the API build | Why |
|---|---|
| The school's own named roles ("Exams officer": make, edit, delete, give to people) | the API has no write path for school roles (finding 16) |
| Giving an organization administrator access | the list carries user ids only and nothing looks an administrator up; it starts from the organization console, which is not on the API build (finding 17) |
| Admin areas for a person with no sign-in, a driver, a full admin, or yourself | areas belong to a sign-in; the server only lets teachers and staff hold them, and refuses your own |

### API findings (for the API owner)

13. **No way to change your own name, phone or photo.** The `users` table has a `full_name` and a `phone`, but there is no
    `PATCH /v1/auth/me`, and `GET /v1/auth/me` returns no phone. The staff directory holds its own name and phone for the same person, so
    one of the two would have to win.
14. **Two-step is only asked of the people it is required of.** `auth_mfa_state` makes `required` true for admins, org admins, super
    admins, anyone with the Fees area (and `MFA_REQUIRED_ROLES`). A teacher who sets it up anyway is never asked for the code at
    sign-in, so it protects nothing. The account page therefore offers no set-up to people who are not required.
15. **Nothing read another person's admin areas** (`GET /v1/rbac/permissions` is the caller's own), so `PUT /v1/rbac/staff-areas`, which
    replaces, could only be used blind. `GET /v1/rbac/staff-areas` is added in the API PR #362: one row per person with areas of their
    own, keyset-paged, for holders of `rbac.staff_areas.manage`.
16. **School roles have tables and a place in `authorize.ts` but no endpoints** (`school_roles`, `school_role_assignments`), and the API's
    own test says they have no write path. The Access screen shows none.
17. **Delegations name nobody.** `GET /v1/rbac/org-delegations` gives `delegateUserId` only, and no endpoint lists an organization's
    administrators, so a school cannot choose one to give access to.
18. **The password rule is not in the contract.** `passwordPolicy.ts` wants 10 or more characters with letters and numbers; the OpenAPI
    file says nothing, and the web's sidebar dialog said 8 (fixed here).
