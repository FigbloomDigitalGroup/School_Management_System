# The web app on the new API (FIG-1890: sign-in, then school setup)

Written 2026-11-23. The first steps of moving the web app from Supabase to `apps/api`: the client, the switch, sign-in,
and the school-setup screens (School settings, Classes, Subjects). Everything else in the web app still reads Supabase
and is **not in an API build**.

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
- **Announcements**: compose and send (or save as draft) in-app and push announcements to the whole school, a role, a year group, or a class, and view recently sent notices.
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

### Announcements screen: what the API cannot do yet

`announcementsCapabilities()` in `packages/shared/src/capabilities.ts` hides controls the API does not back yet:

| Hidden on the API build | Missing in the API |
|---|---|
| Per-audience recipient headcounts & SMS cost preview | no account-reach count endpoint yet (family account links wait on A1 / `FIG-1869`) |
| File attachments | file storage waits on A5 (`FIG-1873`) |
| Guardian signature requests & signature status | signatures wait on C12 (`FIG-1880`) |
| AI writing helper | calls a Supabase edge function |
| SMS and email channel checkboxes | SMS/email delivery waits on B8 (`FIG-1876`); `in_app` and `push` work (`publish` enqueues `announcement.push` on the server) |

Where the model differs it is mapped in `packages/shared/src/api/setupApi.ts`: a class belongs to an academic year (the screen
shows the current year's classes, and a class needs a current year, which "Start a term" makes); a teacher is a staff record,
so every teacher id on an API build is a staff id; a term "starts" by finding or making the year, making the term, and
setting both current; the API has no batch for classes or subjects, so "bulk add" sends them one at a time and says how
many were made if one is refused.

## Where the code is

- `packages/shared/src/api/`: `schema.d.ts` (generated), `client.ts` (the one way to call the API), `errors.ts`,
  `tokenStore.ts`, `paging.ts`, `authApi.ts` (login, MFA, password), `sessionApi.ts` (who is signed in and their school),
  `sessionEvents.ts`, `signInFlow.ts` (what comes next after a password).
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
