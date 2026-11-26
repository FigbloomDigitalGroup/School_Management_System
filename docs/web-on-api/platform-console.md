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
- **P6 (API commit `d5078f70`, web on `feature/web-api-platform-incidents`)**:
  - Migration `apps/api/migrations/121_platform_incidents.sql`, owner-only `platform_incidents` table, and the three `SECURITY DEFINER` functions listed in `apps/api/docs/PLATFORM-CONSOLE.md` section 7.1.
  - API routes: `GET /v1/platform/incidents`, `POST /v1/platform/incidents`, and `POST /v1/platform/incidents/{incidentId}/resolve` (`platform.incidents.manage`; writes require recent re-auth and audit in the same transaction).
  - Web: the existing hand-typed `Incidents` page is available at `/platform/incidents` on the API build. The shared client maps API records to the page's existing shape, pages through the list, and sends identity-scoped calls without `X-Tenant-Id`. `platformCapabilities()` enables the page; the shell shows the open-incident badge.
- **S6a to S6c (billing, D3)**:
  - Migrations `122_platform_billing_subscriptions.sql` (owner-only `platform_subscriptions` and `plan_pricing`) and `123_platform_billing_invoices.sql` (owner-only `platform_invoices`), read and written only through `platform_billing_*` definers; writes need a recent password confirmation and are audited in the same transaction.
  - API routes: `GET /v1/platform/subscriptions`, `PUT /v1/platform/subscriptions/{schoolId}`, `PUT /v1/platform/plan-pricing/{plan}`, `GET`/`POST /v1/platform/invoices`, `PUT /v1/platform/invoices/{invoiceId}/mark-paid`.
  - Web: `platform/subscriptions` (`ApiPlatformSubscriptions.tsx`) and `platform/invoices` (`ApiPlatformInvoices.tsx`), `subscriptionsPage` and `invoicesPage` on in `platformCapabilities()`. No MRR or seat estimates are shown; overdue is derived from the due date.

## Remaining work (open owner decisions)

Unblocked slices (**P1–P6**) are implemented. Remaining platform console work waits on owner answers to section 6 of `apps/api/docs/PLATFORM-CONSOLE.md`:

- **Q1 (answered 2026-11-26)**: This API console owns organization lifecycle. Approve and reject come with sign-up (slice S6); suspend and reactivate come later. Showing API schools in `console.figbloom.org` requires that console's contract.
- **Q2 (answered 2026-11-25)**: The API owns Figbloom billing of schools. Subscriptions, plan prices and invoices are built (S6a to S6c, below); do not tie overdue invoices to school suspension or invent MRR or seat counts.
- **Q3 (closed 2026-11-25)**: No impersonation page or impersonation feature.
- **Q5**: Audit retention policy (7-year immutability claim).
- **Q7**: Live external provider checks on `platform/health`.
- **Q8**: Super-admin + org-admin dual accounts (Risk R4).
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

## What remains hidden on the API build (`platformCapabilities()`)

| Hidden on the API build | Next slice / blocker |
|---|---|
| `platform/organizations` | **P3**: needs `GET /v1/platform/organizations` + `/{id}` (`platform.organizations.read`, migration); **Q1 answered 2026-11-26: this API's console owns lifecycle**, so approve and reject come with sign-up (slice S6) and suspend and reactivate later. API schools in `console.figbloom.org` need that console's contract |
| School admins panel on `platform/tenants` | **P3**: needs `GET /v1/platform/schools/{tenantId}/admins` (`platform.tenants.admins.read`, read-audited) |
| `platform/usage` & per-school headcounts | **P4**: needs counts-only owner function (`GET /v1/platform/usage`, `platform.usage.read`); seats wait on Q2 |
| `platform/audit` | **P5**: needs platform-wide audit read (`platform.audit.read`) reusing migration 106's allowlist; retention waits on Q5 |
| Suspend / reactivate / move organisation | **Q1** (and Risk R5 for org-delegation FK when moving schools) |
| `platform/impersonation` | **Closed by decision (Q3 answered 2026-11-25: no impersonation).** Hidden for good. The page was an empty log (nothing ever wrote to it). Still open as a separate question: a super admin can act inside any school with full powers and no record the school can read |
| Audit retention | **Q5**: retention and immutability policy for the platform-wide audit log |
| `platform/curriculum` | **Closed by decision (Q6 answered 2026-11-25: each school verifies its own catalogue, as the API already works).** Hidden for good; there is no platform-wide catalogue to show |
| Live external provider checks on `platform/health` | **Q7** (worker/queue ops status is shown today) |
| Super-admin + org-admin dual accounts | **Q8** (Risk R4) |

## Where the code is

- `packages/shared/src/api/platformApi.ts` + `platformApi.test.ts`
- `packages/shared/src/api/signInFlow.ts` + `signInFlow.test.ts`
- `packages/shared/src/api/sessionLifecycle.ts` + `sessionLifecycle.test.ts`
- `packages/shared/src/capabilities.ts` (`platformCapabilities()`)
- `packages/shared/src/platform.ts` (API branches + `NotOnApiError` guards)
- `apps/web/src/api/ApiPlatformRoutes.tsx`, `ApiPlatform.tsx`, `ApiApp.tsx`, `ApiSessionGuard.tsx`
- `apps/web/src/screens/platform/ApiPlatformTenants.tsx`, `ApiPlatformHealth.tsx`, `ApiPlatformSubscriptions.tsx`, `ApiPlatformInvoices.tsx`

## Next steps for the next agent

1. **Billing (Q2, approved by D3) is built** (migrations 122 and 123). Before a production API cutover, transfer the historical Supabase invoice rows (the API table starts empty). Do not link overdue invoices to school suspension or invent MRR/seat counts.
2. **Open owner decisions**: Q1, Q3, Q5, Q7 and Q8 remain open; see section 6 of `apps/api/docs/PLATFORM-CONSOLE.md`.
3. **Sign-up visibility**: API-owned school sign-ups still need an explicit contract with `console.figbloom.org`; do not guess its integration.
