# Platform console on the API: design note

Written 2026-11-24 against `dev-joe` at `f05300a`. Design only. It decides no product question; those are listed at the end
for the owner.

The platform console is Figbloom staff's own console (`/platform/*` in the web app, role `super_admin`). It has 10 pages. On
the API build a platform admin is refused at sign-in today ("The platform console is not on the new system yet",
`packages/shared/src/api/signInFlow.ts`), and there is no platform shell.

## 1. What the API has today

| What | Where | Notes |
|---|---|---|
| `POST /v1/platform/schools` | `src/http/routes/accounts.ts`, `platform_provision_school()` (migration 072) | Creates an organisation (or uses one), the school (status `onboarding`) and the first school-admin invitation. Needs recent re-authentication. Audited `platform.school.provisioned`. The school turns `active` when that admin accepts. |
| `GET /v1/platform/ops/status` | `src/http/routes/opsStatus.ts` | Worker, queue and reconciliation counts and ages (`finance_ops_snapshot()`). `platform.ops.read`. |
| `/v1/platform/finance/unmatched-callbacks/*` | `src/http/routes/unmatchedCallbacks.ts` | M-Pesa callbacks that matched no payment, worked as cases. `platform.finance.unmatched.manage`. |
| Curriculum catalogue | `/v1/tenants/{t}/academics/cbe/curriculum-catalogue/*` | Per school, not platform-wide (see page 9). |
| `platform.tenants.read` | migration 001, granted to `super_admin` | **No route used it** (`test/permissions.registry.test.ts` allowlisted it as unused). |

Other facts that shape the design:

- **Super admins can already act inside any school.** With `X-Tenant-Id` (or a selected school) `buildAuthzContext` makes a
  super admin `super_admin` in that school, `mayAdminister` is true, so they hold every school-admin permission. This works in
  a suspended school too (on purpose, for support). There is no reason, no time limit, and nothing the school can read that
  says "Figbloom staff were here". The audit rows name the super admin as the actor, and no endpoint reads audit rows.
- **MFA.** Super admins must use two-step (TOTP); the check is in `requireSessionAuth`, so every new route gets it. Writes that
  matter also use `assertRecentAuth` (sign in again within `SENSITIVE_REAUTH_WINDOW_SECONDS`, 300 s by default).
- **Tables.** `tenants` and `organizations` have no row level security: they are identity tables, filtered by the application,
  and `figbloom_app` may only `SELECT` them. Any write needs a `SECURITY DEFINER` function, as provisioning does. School data
  (`learners`, `school_profiles`, ...) has forced RLS per school, so a cross-school count or list cannot be read from the
  identity path; it needs either one tenant transaction per school or an owner function that returns counts only.
- **`security_audit_events`** is insert-only for the API. There is no `SELECT` grant and no read path, for any role.
- **The `tenants` row is small:** id, organisation, name, slug, status, timezone, created date. Plan, seats, price, trial end,
  renewal date, accent, logo, county, level and payment details are not on it. Some are in `school_profiles` (county, country,
  level, institution type, contact, MoE number, logo key, accent), which is per-school data under RLS.

## 2. A second console already exists: console.figbloom.org

The repo README ("Figbloom console", "Figbloom platform registration") describes a separate Figbloom console at
`console.figbloom.org` (bloomHR's `/api`, the figbloomHR-platform). On Supabase:

- it lists every school and suspends or reactivates one, server to server, through the edge function `platform-schools`;
- organisations and schools are registered with the platform (`platform-sync`), and the platform's organisation decisions
  (approve, reject, suspend, reactivate) come back signed to `platform-decisions`. Once `PLATFORM_DECISIONS_ENABLED` is on,
  organisation status comes **only** from the platform, and this app's console shows it instead of an Approve button.

The API has none of this: no `platform-schools`, no sync, no decisions webhook. So before building school or organisation
lifecycle on the API, the owner has to say which console owns it (question Q1).

## 3. The 10 pages

"Calls" counts what the Supabase screen really sends (database queries, RPCs and edge-function calls), read from
`packages/shared/src/platform.ts`, `curriculum.ts` and the screens in `apps/web/src/screens/platform/`.

### 3.1 `platform/tenants` (Tenants.tsx, TenantDetail.tsx, OnboardSchool.tsx, components/SchoolAdmins.tsx)

**Supabase does:** list every school (1 query); MRR and learner seats (2: `plan_pricing`, count of active `students`); per
school: learners, staff and parent counts and what the school owes Figbloom (4); the organisation list (1); activate an
`onboarding` school (1 update); move a school to another organisation (1 update) or to an organisation of its own (1 RPC);
list the school's admins (1), add one (edge `invite-admin`, shows a password), remove one (edge `delete-account`); the
onboarding wizard (organisation list, insert the school, upload a crest, save it, invite the admin: 4 calls + 1 upload).
The sidebar badges count schools, open incidents and due invoices (3). About 20 calls in all.

**Not real on the Supabase screen (do not port as is):** the "Daily active users" chart and "Role adoption" bars are fixed
numbers in the code; the alert texts for `overdue`, `setup_stalled` and `trial` ("Two reminders sent", "step 3 of 5",
"twelve days") are invented; the Branding tab's accent picker saves nothing; "View invoices" passes `?school=`, which the
Invoices page ignores.

**API backs:** creating a school (`POST /v1/platform/schools`, with an invitation instead of a password). A super admin can
read one school's profile through `GET /v1/tenants/{t}/school-profile` with `X-Tenant-Id` (this is "acting inside the school").

**Missing:** list schools, one school's detail, counts, plan and billing fields, activate, move between organisations,
list/remove a school's admins from the platform side, suspend and reactivate (Supabase has these through the other console).

**Proposed:**

| Endpoint | Permission | Reads / writes | Audit | Extra |
|---|---|---|---|---|
| `GET /v1/platform/schools?status&organizationId&limit&cursor` | `platform.tenants.read` (exists) | `tenants` + `organizations`, directory fields only | none (no personal data) | slice P1 |
| `GET /v1/platform/schools/{tenantId}` | same | same | none | slice P1 |
| `GET /v1/platform/schools/{tenantId}/admins` | new `platform.tenants.admins.read` | memberships + users (name, email) | read audit (personal data) | slice P3 |
| `POST /v1/platform/schools/{tenantId}/suspend` and `/reactivate` (`{reason}`) | new `platform.tenants.manage` | definer function; remembers the previous status (new column) | `platform.school.suspended` / `.reactivated` with the reason, written in the same transaction | re-auth; **only if Q1 says this console owns it** |
| `PUT /v1/platform/schools/{tenantId}/organization` | `platform.tenants.manage` | definer function | `platform.school.organization_changed` | re-auth; see risk R5 |

### 3.2 `platform/organizations` (Organizations.tsx)

**Supabase does:** list organisations (1), add one (1 insert), approve a pending one (1 update), its member schools (1), its
admins (1), invite an org admin (edge `invite-org-admin`, shows a password), and ask whether the other console decides
status (1 RPC). 6 calls + 1 edge call.

**API backs:** nothing at platform level. `GET /v1/org/schools` is the org admin's own view, not Figbloom's.

**Proposed:** `GET /v1/platform/organizations` and `/{id}` (new `platform.organizations.read`; `organizations` only);
member schools come from `GET /v1/platform/schools?organizationId=` (P1). Org admins list and invite overlap with slice
S11 (org-admin management): reuse its functions. Create, approve, suspend and reject only after Q1.

### 3.3 `platform/usage` (pages.tsx `Usage`)

**Supabase does:** every school's licensed seats and status (1) and learners plus staff per school (1 RPC
`platform_usage_counts`). 2 calls.

**API backs:** nothing. There is no licensed-seats field.

**Proposed:** `GET /v1/platform/usage` (new `platform.usage.read`) backed by one owner function that returns **counts only**
per school (active learners, active staff memberships, active guardian links), no names, no ids of people. It must be added
to `SECURITY-DEFINER-INVENTORY.md` and its tests. Seats need Q2.

### 3.4 `platform/incidents` (pages.tsx `Incidents`)

**Supabase does:** list incidents newest first (1), declare one (1 insert), resolve one (1 update). Staff type them in by
hand; nothing writes them automatically. 3 calls.

**API backs:** nothing. **Proposed (only if Q4 says keep it here):** a platform-only table `platform_incidents` (no
`tenant_id`, owner-only, read and written through definer functions that check `super_admin`), `GET/POST
/v1/platform/incidents`, `POST /v1/platform/incidents/{id}/resolve`, permission `platform.incidents.manage`, audit
`platform.incident.declared` / `.resolved`. Schools do not see incidents today on either build.

### 3.5 `platform/subscriptions` and 3.6 `platform/invoices` (pages.tsx)

**Supabase does:** Subscriptions: every school's plan, status, price override, trial end and renewal date (1) and the price
list (1). Invoices: every invoice with the school's name (1), the school list for the form (1), mark paid (1 update), create
(1 insert). 6 calls. Money is Figbloom's own billing of schools (KES), not school fees. There is no payment gateway: staff
mark an invoice paid by hand.

**API backs:** migration 122 adds the owner-only `plan_pricing` and `platform_subscriptions` tables, with
`GET /v1/platform/subscriptions`, `PUT /v1/platform/subscriptions/{schoolId}` and
`PUT /v1/platform/plan-pricing/{plan}`. Both writes need recent re-authentication and audit their money changes in the same
transaction. The old price rows were explicitly placeholders, so no prices are seeded; an unset price stays unset.

**Not built yet:** `platform_invoices` and its create/mark-paid endpoints (the next slice). Overdue invoices will not suspend
a school. The API stores subscription terms in a platform table keyed by school; it does not add billing columns to `tenants`.

### 3.7 `platform/impersonation` (pages.tsx `Impersonation`)

**Supabase does:** reads the last 100 rows of `impersonation_sessions` (1 call). **Nothing ever writes that table**: the
`start_impersonation` / `end_impersonation` functions exist but no screen calls them ("Impersonate admin" only shows a
message, FIG-1446). The page is an empty log.

**API backs:** nothing as a log, but see section 1: a super admin can already act inside any school with full powers, at any
time, with no reason and no record the school can read. That is the real risk here, more than the missing page.

**Proposed (Q3 decides; nothing is built now):**

- Option A, no impersonation. Limit a super admin inside a school to what support needs (for example read-only, or the
  setup screens), and drop the page.
- Option B, explicit support sessions. `POST /v1/platform/schools/{id}/support-sessions` with `{reason, scope: read|write,
  minutes}` (at most 60), re-auth and MFA, audited in the school's own log; a super admin's `X-Tenant-Id` into a school only
  works while such a session is open and not past its end; `POST .../end`; the school admin can list their school's sessions
  (`GET /v1/tenants/{t}/support-sessions`); the platform page lists all of them (`platform.support_sessions.read`).
  Every write made during a session carries the session id in its audit detail.
- Either way, who may do it: `super_admin` only, never an org admin, never a delegated role.

### 3.8 `platform/audit` (pages.tsx `Audit`)

**Supabase does:** the last 200 audit events across every school with the school's name (1 call). The page says "retained
for seven years" and "immutable"; nothing in the code checks either.

**API backs:** nothing; `security_audit_events` has no read path for anyone.

**Proposed:** one owner function that reads `security_audit_events` with filters (school, event type prefix, time range),
keyset paging on `(occurred_at, id)`, and that returns only the event type, time, school, actor id and a fixed allowlist of
detail keys (never IPs, never free text). Exposed twice: per school for `admin/audit` (`area.audit`, slice S11 / C12) and
platform-wide for `platform/audit` (new `platform.audit.read`). Reading the platform log is itself audited. Build it with S11
so there is one function, not two. Retention needs Q5.

### 3.9 `platform/curriculum` (Curriculum.tsx)

**Supabase does:** one KICD catalogue for every school: learning areas and strand coverage (2), import strands from CSV (1),
mark a learning area verified (1), edit one (1). 5 calls.

**API backs:** a catalogue per school (`/v1/tenants/{t}/academics/cbe/curriculum-catalogue/*`: import batches with
provenance, review, supersede, history), verified with `resource.curriculum.verify`, which school admins hold. So the API's
model is "each school verifies its own copy", the Supabase one is "Figbloom verifies once for everyone". The verifier
question (D-5) is open: Q6.

**Proposed:** nothing until Q6. If Figbloom verifies: a platform catalogue (no `tenant_id`), `platform.curriculum.manage`,
and schools read from it.

### 3.10 `platform/health` (pages.tsx `Health`)

**Supabase does:** the last 200 checks (1) and "Check now", which pings Supabase and M-Pesa through the edge function
`check-services` and stores the result (1 edge call). 2 calls.

**API backs:** `GET /v1/platform/ops/status` (worker heartbeat, queue depth and lag, dead jobs, reconciliation backlog). This
is different content: no history, no live provider check. **Ready to port** as a page that shows ops status. Live checks of
M-Pesa, e-mail (Resend), storage and Bloom are Q7.

## 4. Risks

- **R1 Cross-school reads.** Every platform read crosses schools. Keep them to identity tables (`tenants`,
  `organizations`) or to owner functions that return counts or allowlisted fields. Never open a tenant transaction per school
  in a loop for a list (slow, and it turns a list into many "acting inside a school" reads). Every platform route takes no
  tenant: it ignores `X-Tenant-Id` and the session's school (`buildAuthzContext` with `tenantId: null`), so a school user
  cannot reach it by sending a header.
- **R2 Suspension.** On the API a suspension takes effect on the next request (no sessions to revoke). Two gaps, from reading
  the code (not tested): suspending an **organisation** does not lock out its schools' members, because
  `buildAuthzContext` checks only the school's status (Supabase cascades, migration `20261104910000`); and there is nowhere
  to keep the status a school had before it was suspended. If two consoles can both suspend, they will disagree: Q1.
- **R3 Impersonation.** See 3.7. The open acting-as path exists today and is the thing to close or bound.
- **R4 A super admin who is also an org admin** loses platform powers: with no school, `buildAuthzContext` picks `org_admin`
  before `super_admin`, so `platform.*` permissions are refused (`/v1/platform/ops/status` too). Recommendation: keep
  platform accounts separate from org accounts, or fix the order. Not changed here.
- **R5 Moving a school between organisations** will fail once the school has ever had an org-admin delegation:
  `org_admin_school_delegations (tenant_id, organization_id)` references `tenants (id, organization_id)` with no
  `ON UPDATE`, and revoked rows keep the reference. The function must close delegations first, or the FK must change.
- **R6 Invented figures.** Section 3.1 lists numbers and texts the Supabase screen makes up. The API build must not show them.
- **R7 Billing and personal data.** Invoices and admin e-mails are not school data but are still money and personal data:
  audit every change, re-auth on writes, no CSV export without a decision.

## 5. Proposed slice order

1. **P1 (clear, no product decision):** `GET /v1/platform/schools` and `/{tenantId}`, read-only, directory fields, existing
   permission `platform.tenants.read`, no migration. Built in the PR that follows this note.
2. **P2 web:** platform shell on the API build (own file, small hook in `ApiApp.tsx`), let `super_admin` sign in, then
   `platform/health` (ready) and `platform/tenants` read-only (list, detail, onboarding through `POST /v1/platform/schools`).
   Everything else hidden behind `capabilities.ts` with the reason.
3. **P3:** organisations read (`platform.organizations.read`, migration), school admins list; reuse S11's org-admin functions.
4. **P4:** usage counts (owner function, counts only).
5. **P5:** audit read, together with S11's school audit read.
6. After decisions only: suspend and reactivate (Q1), invoices (D3), impersonation or support sessions (Q3), incidents (Q4),
   curriculum (Q6), and live provider checks (Q7).

## 6. Questions for the owner

1. **Q1 Which console owns school and organisation lifecycle on the API?** This app's platform console, or console.figbloom.org
   (as on Supabase today, through `platform-schools` and the decisions webhook)? If the other console, the API needs a
   server-to-server endpoint and webhook like Supabase's, and this console only shows status.
2. **Q2 (answered D3, 2026-11-25):** the API owns Figbloom's billing of schools (plans, prices, trials, renewals and invoices), in
   KES, with staff marking invoices paid by hand. Overdue invoices do not suspend a school.
3. **Q3 Should impersonation exist at all?** If yes: read-only or write, longest session, and must the school be told (the
   Supabase page promised "schools can read their own entries")? If no: should a super admin keep full powers inside any
   school, as the API allows today, or be limited?
4. **Q4 Incidents:** keep a hand-typed incident list in this console, or use a status page or the ops tooling?
5. **Q5 Audit retention:** the Supabase page says seven years and immutable. Is that the rule for the API, and who may read
   the platform-wide log?
6. **Q6 Curriculum (D-5):** does Figbloom verify one KICD catalogue for every school, or does each school verify its own (the
   API's current model)?
7. **Q7 Health:** is worker and queue status enough, or do you want live checks of M-Pesa, e-mail, storage and Bloom?
8. **Q8 Org-and-platform accounts:** may one person be both a super admin and an org admin (risk R4)?

## 7. As built

### 7.2 Subscriptions and plan pricing (migration 122)

| What | As built |
|---|---|
| Tables | `platform_subscriptions` (school-keyed: plan, status, price override, trial end and renewal date) and `plan_pricing`; both are owner-only, forced-RLS, and have no runtime table grants. |
| Defaults | Existing and future API schools start on the documented `standard` plan and retain their current status. No price rows are seeded because the legacy numbers are placeholders, not approved KES prices. |
| Reads | `GET /v1/platform/subscriptions` returns school name/slug and terms, plus the configured price list, keyset-paginated by school name/id. Effective price is override, else the configured plan price, else zero (displayed as unset). |
| Writes | `PUT /v1/platform/subscriptions/{schoolId}` and `PUT /v1/platform/plan-pricing/{plan}` require `platform.billing.manage` and recent password confirmation. A changed record writes an immutable audit event in the same transaction; no-op updates add no event. |
| Separation | These terms do not change a school's access status. An overdue Figbloom invoice does not suspend a school. No MRR or licensed-seat count is invented. |
