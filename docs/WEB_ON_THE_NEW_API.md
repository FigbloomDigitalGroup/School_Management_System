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
- Platform and organization accounts are told their console is not on the new system yet, and are signed out.

## What does not, and why

| Not there | Why |
|---|---|
| Sign in with a school ID | `POST /v1/auth/login/login-id` takes the school's UUID and there is no public school search or login-ID lookup (FIG-1872) |
| Password reset by email, accept-invitation page | No email provider is set up (FIG-1872); the reset and invitation tokens are only returned in API responses |
| The re-enter-password prompt (`reauth_required`) | The client supports it (`setApiAuthHandlers`), but no screen on the API build does a sensitive action yet. The two-step set-up asks for the password inline |
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
