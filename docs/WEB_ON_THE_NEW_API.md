# The web app on the new API (FIG-1890, first slice)

Written 2026-11-23. This is the first step of moving the web app from Supabase to `apps/api`: the client, the
switch, and sign-in. Everything else in the web app still reads Supabase and is **not in an API build**.

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
- A page at `/s/<slug>` showing who is signed in, their school and admin areas, and a "check the connection" button.
- Platform and organization accounts are told their console is not on the new system yet, and are signed out.

## What does not, and why

| Not there | Why |
|---|---|
| Sign in with a school ID | `POST /v1/auth/login/login-id` takes the school's UUID and there is no public school search or login-ID lookup (FIG-1872) |
| Password reset by email, accept-invitation page | No email provider is set up (FIG-1872); the reset and invitation tokens are only returned in API responses |
| The re-enter-password prompt (`reauth_required`) | The client supports it (`setApiAuthHandlers`), but no screen on the API build does a sensitive action yet. The two-step set-up asks for the password inline |
| A QR code for two-step set-up | The key is shown for typing in, with an `otpauth://` link for a phone. A QR needs a small library; left for a decision |
| Every other screen | Each area moves over on its own, after its shared module is on the API (FIG-1889 onwards) |

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
