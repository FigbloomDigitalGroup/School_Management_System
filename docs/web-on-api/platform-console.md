# Platform console on the new API

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md) and implementing slice **P2** of
[`apps/api/docs/PLATFORM-CONSOLE.md`](../../apps/api/docs/PLATFORM-CONSOLE.md).

## Current status (handoff)

- **P1 (done on `dev-joe`)**: `GET /v1/platform/schools` and `GET /v1/platform/schools/{schoolId}` (`platform.tenants.read`).
- **P2 (done on `feature/web-api-platform-console`)**: platform console shell on the API build, `super_admin` sign-in,
  `platform/tenants` (read-only directory + onboarding via `POST /v1/platform/schools`), and `platform/health` (live ops snapshot
  via `GET /v1/platform/ops/status`).
- **P3 (done on `feature/web-api-platform-console`)**:
  - Migration `apps/api/migrations/111_platform_organizations_and_admins_read.sql` (`platform.organizations.read`, `platform.tenants.admins.read`, `super_admin` only).
  - Migration `apps/api/migrations/114_platform_school_admins_read.sql` (a fix): the school administrators read first queried `school_memberships` directly, where forced row-level security hid every row from a request with no school, so the list was always empty. It now calls the `platform_school_admins()` definer function.
  - API routes: `GET /v1/platform/organizations`, `GET /v1/platform/organizations/{organizationId}`, `GET /v1/platform/organizations/{organizationId}/admins` (audited `platform.organization.admins_read`), `GET /v1/platform/schools/{schoolId}/admins` (audited `platform.school.admins_read`).
  - Web: `platform/organizations` (`ApiPlatformOrganizations.tsx`) showing all organizations, their administrators, and their member schools; plus the **School administrators** panel on `platform/tenants`. `platformCapabilities()` enables `organizationsPage` and `tenantAdminsPanel`.
- **P4 (done on `feature/web-api-platform-console`)**:
  - Migration `apps/api/migrations/112_platform_usage_counts.sql` (`platform.usage.read`, `public.platform_usage_counts()` counts-only `SECURITY DEFINER`, registered in `SECURITY-DEFINER-INVENTORY.md` + `securityDefiner.test.ts`).
  - API route: `GET /v1/platform/usage`.
  - Web: `platform/usage` (`ApiPlatformUsage.tsx`), `usagePage: true` in `platformCapabilities()`.
- **P5 (done on `feature/web-api-platform-console`)**:
  - Migration `apps/api/migrations/113_platform_audit_read.sql` (`platform.audit.read`, `public.platform_audit_events(...)` `SECURITY DEFINER`, never returns `ip` or `detail`, registered in `SECURITY-DEFINER-INVENTORY.md` + `securityDefiner.test.ts`).
  - API route: `GET /v1/platform/audit-events` (reading is itself audited as `platform.audit.read`).
  - Web: `platform/audit` (`ApiPlatformAudit.tsx`), `auditPage: true` in `platformCapabilities()`.
- **S5 (incidents, on feature branches)**: migration `121_platform_incidents.sql`, the super-admin incident API, and
  `platform/incidents` connected through `ApiPlatformIncidents.tsx`. The page keeps the hand-entered workflow chosen by D2.
- **S6a (subscriptions, local feature branch)**: migration `122_platform_billing_subscriptions.sql`, owner-only subscription
  and price tables, audited/re-authenticated writes, typed OpenAPI operations, and `platform/subscriptions` connected in
  `ApiPlatformSubscriptions.tsx` without MRR or seat estimates.

## Remaining work

Owner answers have unblocked most of the console. Remaining platform work is:

- **S6b (next)**: `platform/invoices` API and web page, migration 123. Staff create invoices and mark them paid by hand;
  an overdue invoice does not suspend a school.
- **Q1 follow-up**: implement approved school lifecycle actions and the `console.figbloom.org` visibility contract; do not
  infer that contract from this API.
- **Q5**: audit retention policy (the seven-year immutability claim).
- **Q7**: live external provider checks on `platform/health`.
- **Q8**: super-admin + org-admin dual accounts (Risk R4).
- **Closed**: impersonation (D4) and platform curriculum verification (D6) remain hidden; each school verifies its own catalogue.

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

## Remaining or closed platform work on the API build

| Page or action | Next slice / blocker |
|---|---|
| School lifecycle actions | **Q1**: this API's console owns lifecycle; approve/reject are planned with sign-up, and suspend/reactivate/move remain future work. The `console.figbloom.org` visibility contract still needs implementation |
| `platform/invoices` | **D3 answered 2026-11-25: API owns school billing.** Next API slice (migration 123); overdue invoices do not suspend schools |
| `platform/incidents` | **D2 answered 2026-11-25: keep a hand-typed incident list.** API and web work is on a sibling local feature branch |
| `platform/impersonation` | **Closed by D4 (2026-11-25: no impersonation).** Hidden for good. A separate question remains: a super admin can act inside any school with full powers and no record the school can read |
| `platform/curriculum` | **Closed by D6 (2026-11-25: each school verifies its own catalogue).** Hidden for good; there is no platform-wide catalogue to show |
| Live external provider checks on `platform/health` | **Q7**: worker/queue ops status is shown today; live provider checks are not built |

## Where the code is

- `packages/shared/src/api/platformApi.ts` + `platformApi.test.ts`
- `packages/shared/src/api/signInFlow.ts` + `signInFlow.test.ts`
- `packages/shared/src/api/sessionLifecycle.ts` + `sessionLifecycle.test.ts`
- `packages/shared/src/capabilities.ts` (`platformCapabilities()`)
- `packages/shared/src/platform.ts` (API branches + `NotOnApiError` guards)
- `apps/web/src/api/ApiPlatformRoutes.tsx`, `ApiPlatform.tsx`, `ApiApp.tsx`, `ApiSessionGuard.tsx`
- `apps/web/src/screens/platform/ApiPlatformTenants.tsx`, `ApiPlatformHealth.tsx`, `ApiPlatformSubscriptions.tsx`

## Next steps

1. **S6b**: build the invoices API and connect platform/invoices; migration 123 follows subscriptions. Create and mark-paid actions need recent re-authentication and audit logging.
2. **Platform lifecycle**: build the approved school and organisation actions, plus the agreed visibility contract for console.figbloom.org.
3. **Later decisions**: audit retention (Q5), live provider checks (Q7), and dual super-admin/org-admin accounts (Q8) remain open.
