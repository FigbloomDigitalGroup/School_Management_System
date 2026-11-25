# Platform console on the new API

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md) and implementing slice **P2** of
[`apps/api/docs/PLATFORM-CONSOLE.md`](../../apps/api/docs/PLATFORM-CONSOLE.md).

## Current status (handoff)

- **P1 (done on `dev-joe`)**: `GET /v1/platform/schools` and `GET /v1/platform/schools/{schoolId}` (`platform.tenants.read`).
- **P2 (this branch, `feature/web-api-platform-console`)**: platform console shell on the API build, `super_admin` sign-in,
  `platform/tenants` (read-only directory + onboarding via `POST /v1/platform/schools`), and `platform/health` (live ops snapshot
  via `GET /v1/platform/ops/status`). Everything else is hidden behind `platformCapabilities()` and unbacked functions in
  `packages/shared/src/platform.ts` fail loudly with `NotOnApiError`.

## What works in P2

- **Sign-in (`continueSignIn`)**: `super_admin` accounts are no longer refused at sign-in. After MFA (required by the API for
  `super_admin`), sign-in opens `/platform/tenants` (or a safe `/platform/...` return path after idle/expiry).
- **Platform shell (`apps/web/src/api/ApiPlatform.tsx`, `ApiPlatformRoutes.tsx`)**: lazy-loaded from one line in `ApiApp.tsx`,
  gated on `profile.role === "super_admin"`. Covered by `ApiSessionGuard` (idle timeout, expiry banner, automatic re-auth modal).
- **`platform/tenants` (`apps/web/src/screens/platform/ApiPlatformTenants.tsx`)**:
  - Lists all schools from `GET /v1/platform/schools` (keyset-paginated, `tenantId: null`) with search and status filters.
  - Shows only real directory fields (name, slug, status, timezone, created date, organisation name/slug/kind/status) — no
    invented MRR, seat counts, DAU or role-adoption charts (Risk R6).
  - **+ Onboard** modal calls `POST /v1/platform/schools` (automatic password re-auth prompt when needed) and either confirms
    email delivery or shows the one-time acceptance link (`OneTimeValue` + `acceptInviteLink`) when email delivery is not configured.
- **`platform/health` (`apps/web/src/screens/platform/ApiPlatformHealth.tsx`)**:
  - Reads `GET /v1/platform/ops/status` (`finance_ops_snapshot()`), displaying worker heartbeats/ages, job queue depth/lag/dead,
    reconciliation backlog, and unmatched M-Pesa callback/case counters, with a Refresh action.

## What is hidden on the API build (`platformCapabilities()`)

| Hidden on the API build | Next slice / blocker |
|---|---|
| `platform/organizations` | **P3**: needs `GET /v1/platform/organizations` + `/{id}` (`platform.organizations.read`, migration); create/approve/suspend wait on Q1 |
| School admins panel on `platform/tenants` | **P3**: needs `GET /v1/platform/schools/{tenantId}/admins` (`platform.tenants.admins.read`, read-audited) |
| `platform/usage` & per-school headcounts | **P4**: needs counts-only owner function (`GET /v1/platform/usage`, `platform.usage.read`); seats wait on Q2 |
| `platform/audit` | **P5**: needs platform-wide audit read (`platform.audit.read`) reusing migration 106's allowlist; retention waits on Q5 |
| Suspend / reactivate / move organisation | **Q1** (and Risk R5 for org-delegation FK when moving schools) |
| `platform/subscriptions` & `platform/invoices` | **Q2** (whether the API owns Figbloom billing of schools) |
| `platform/impersonation` | **Q3** (impersonation vs bounded support sessions) |
| `platform/incidents` | **Q4** (in-app incident list vs external status/ops) |
| `platform/curriculum` | **Q6** (platform-verified vs per-school KICD catalogue) |
| Live external provider checks on `platform/health` | **Q7** (worker/queue ops status is shown today) |

## Where the code is

- `packages/shared/src/api/platformApi.ts` + `platformApi.test.ts`
- `packages/shared/src/api/signInFlow.ts` + `signInFlow.test.ts`
- `packages/shared/src/api/sessionLifecycle.ts` + `sessionLifecycle.test.ts`
- `packages/shared/src/capabilities.ts` (`platformCapabilities()`)
- `packages/shared/src/platform.ts` (API branches + `NotOnApiError` guards)
- `apps/web/src/api/ApiPlatformRoutes.tsx`, `ApiPlatform.tsx`, `ApiApp.tsx`, `ApiSessionGuard.tsx`
- `apps/web/src/screens/platform/ApiPlatformTenants.tsx`, `ApiPlatformHealth.tsx`

## Next steps for the next agent

1. **P3 (unblocked, no owner decision needed for reads)**:
   - API migration adding `platform.organizations.read` and `platform.tenants.admins.read` (granted to `super_admin`).
   - Routes: `GET /v1/platform/organizations`, `GET /v1/platform/organizations/:orgId`, `GET /v1/platform/schools/:schoolId/admins` (audit personal-data reads).
   - Wire `organizationsPage: true` and `tenantAdminsPanel: true` in `platformCapabilities()` and add the read-only API views.
2. **P4 (unblocked for counts)**:
   - Counts-only `SECURITY DEFINER` function (active learners, active staff memberships, active guardian links per school — no names or IDs of people), registered in `SECURITY-DEFINER-INVENTORY.md` + tests.
   - Route: `GET /v1/platform/usage` (`platform.usage.read`), wire `usagePage: true`.
3. **P5 (unblocked for reads, Q5 for retention)**:
   - Platform-wide audit read (`GET /v1/platform/audit-events`, `platform.audit.read`) reusing migration 106's allowlist, auditing the read itself, wire `auditPage: true`.
4. **Blocked on owner decisions Q1–Q8**: see section 6 of `apps/api/docs/PLATFORM-CONSOLE.md`.
