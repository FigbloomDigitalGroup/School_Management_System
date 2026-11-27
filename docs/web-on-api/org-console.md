# Organisation console

Part of [the web app on the new API](../WEB_ON_THE_NEW_API.md), which explains why each area has its own file.

Pages: `org/dashboard`, `org/schools`, `org/schools/:id`, `org/admins`, `org/audit` (screens `screens/org/*`) and `/org-picker`
(`screens/OrgPicker.tsx`). The API side is in PR #386 (`apps/api/docs/ORG-CONSOLE.md`); the authority for what an org admin
may do is `apps/api/docs/ORG-ADMIN-POLICY.md`.

## What works

- **Sign-in.** An org admin who signs in goes to their organisation's dashboard, or to the picker when they run several
  (`continueSignIn`, `orgHomePath`). They answer two-step first: the API requires it for org admins. Before this change they
  were told "not on the new system yet" and signed out.
- **The shell** (`apps/web/src/api/ApiOrg.tsx`): the same gate as the Supabase app's OrgRoutes. The organisation at the
  address must be one of the person's own (`GET /v1/org/organizations`); anyone else (a school admin, a teacher) is sent back
  through sign-in, which takes them to their own console. A suspended, pending or rejected organisation gets a page that says
  so instead of empty lists. The session guard's sign-out, idle and expiry handling now covers `/org/...` and `/org-picker`.
- **Dashboard and Schools:** each school's name, web address and status, the school count and how many need attention
  (`GET /v1/org/schools`).
- **School page:** name, address and status, and **Access in this school**: what the signed-in admin holds there
  (`delegatedPermissions` of `GET /v1/rbac/permissions` with the school), giving another admin of the organisation access
  (`POST /v1/rbac/org-delegations`) and taking all of their access away (`DELETE`). Both changes ask for the password again
  (the session guard's prompt, `reauth_required`).
- **Delegated school console:** the Open school console button appears only when the signed-in admin holds `tenant.read` in
  that school. The API session finds the school through the caller's own organizations, rechecks the tenant record, and
  loads only delegated `area.*` permissions. The shell shows an organization banner and an exit link; the API still checks
  every screen request. With no delegated areas, the admin gets the school overview and no admin pages. School-profile
  fields stay hidden when the delegate cannot read them, and the HR handoff is offered only to a delegate with `area.fees`.
- **Admins:** the organisation's admins, with "(you)" on the signed-in person (`GET /v1/org/organizations/{id}/admins`).
- **Audit log:** the signed-in admin's own recorded actions in the organisation and its schools, the latest 200
  (`GET /v1/org/organizations/{id}/audit-events`), with the school's name.
- **Picker:** every organisation the person runs, with its status, and the school count.

## What the API cannot do yet (hidden, with the reason)

`orgCapabilities()` in `packages/shared/src/capabilities.ts`; the shared functions behind the missing parts throw
`NotOnApiError`.

| Hidden on the API build | Why |
|---|---|
| Learners, attendance today, fees billed and collected, per school and in total (dashboard, schools, school page, picker) | The API gives an org admin no per-school figures. Owner decision 4 in `ORG-CONSOLE.md` (finding org-1) |
| K-12 or higher-ed, delivery mode, "last updated", and the K-12 / Higher-ed filters | Not in `GET /v1/org/schools`; an org admin cannot read the school profile without delegated access (org-1) |
| "+ Add school", and adding a school's first administrator | School provisioning is a super-admin act on the API (`POST /v1/platform/schools`) |
| "Open for sign-in" | On the API a school opens when its first administrator accepts the invitation |
| A school's own administrators on its page | A school-level read an org admin does not hold |
| "+ Invite admin", and removing an admin | Owner decisions 1 and 2: who may add or remove an org admin (org-2) |
| Other admins' actions in the Audit log, and the page-view log | Owner decision 3; the API records actions, not page views (org-4). `logOrganizationAccess` and `fetchTenantOrgAccessLog` throw `NotOnApiError` |
| What another admin holds in a school | Listing delegations by org admins is still open in the policy (org-3) |
| "+ Create new organization" in the workspace switcher | No self-service organisations on the API (C15) |

On the API the numeric fields of an `OrganizationTenantSummary` are 0 and never shown; nothing is filled in from other data.

## Where the code is

- `packages/shared/src/api/orgApi.ts`: the API side of `organizations.ts` (organisations, schools, admins, own audit), of
  `session.ts` `loadOrgSession` and `loadMyWorkspaces`, the post-sign-in path for org admins, and the school-access calls.
- `packages/shared/src/api/sessionApi.ts`: finds an org school by slug only inside the caller's organizations and enables
  the limited school session only when `tenant.read` is delegated.
- `apps/web/src/api/ApiOrg.tsx` (shell, gate, on-hold page) and `ApiOrgRoutes.tsx` (the two routes, lazy; one line in
  `ApiApp.tsx`).
- `apps/web/src/screens/org/SchoolAccessPanel.tsx`: Access in this school (API build only).

## API findings: organisation console (numbered org-1 to org-6, so that no other area shares a number)

- **org-1. No per-school figures or kinds for an org admin.** `GET /v1/org/schools` has name, slug and status only. The
  Supabase console showed learners, attendance today and fees per school. Which aggregates an org admin may see is open
  (owner decision 4 in `apps/api/docs/ORG-CONSOLE.md`); the school's kind and delivery mode could be added to the list
  without that decision.
- **org-2. Nobody can add or remove an org admin through the API.** Not even a super admin: there is no endpoint. Whether
  org admins may do it themselves is owner decisions 1 and 2 (an org admin who can add admins can add a second account and
  delegate to it). The platform console (S12) will need the super-admin side.
- **org-3. An org admin can give and take away access in a school but cannot list it.** By design in the policy
  ("Listing by org admins: not implemented, deliberately"). The panel shows only the signed-in admin's own access and offers
  "take away all access" per person.
- **org-4. The audit read is the caller's own actions only** (owner decision 3). There is no page-view log on the API, and a
  member school cannot see its organisation's visits (the Supabase `organization_access_log` had both).
- **org-5. Resolved in W0.6:** the web finds a school through the org admin's own organization list, requires delegated
  `tenant.read`, and limits the console to delegated `area.*` permissions. Every server request rechecks the delegation;
  the client permission list only controls navigation and presentation.
- **org-6. `rbac.school_roles.manage` is delegable but gives nothing** (no API route uses it; `ORG-ADMIN-POLICY.md`, "School
  roles"). It is left out of the access picker.
