# Organisation console on the API (S11, migration 105)

Written 2026-11-24. The authority for who may do what is `ORG-ADMIN-POLICY.md`. This note says what the web org console
(`org/dashboard`, `org/schools`, `org/schools/:id`, `org/admins`, `org/audit`, `/org-picker`) needs, what this change
adds, and what it leaves for an owner decision because the policy does not settle it.

## What the console needs, and what backs it

| Console need | Backed by | Who |
|---|---|---|
| Which organisations am I an administrator of (the picker, the shell header) | **new** `GET /v1/org/organizations` | `org.tenants.read` (org_admin) |
| The schools of my organisations, with status | `GET /v1/org/schools` (existing, unchanged) | `org.tenants.read` |
| Who else administers my organisation | **new** `GET /v1/org/organizations/{organizationId}/admins` | **new** `org.admins.read` (org_admin) |
| What I did in my organisation (audit) | **new** `GET /v1/org/organizations/{organizationId}/audit-events` | **new** `org.audit.read` (org_admin) |
| Give a co-admin access inside one school, take it away | `POST` / `DELETE /v1/rbac/org-delegations` with `X-Tenant-Id` (existing, FIG-1609) | `org.delegations.grant` / `.revoke` |
| What access I hold inside one school | `GET /v1/rbac/permissions` with `X-Tenant-Id` (existing; `delegatedPermissions`) | `rbac.permissions.read` |

Nothing here gives an org admin any school-level power. Policy points 2 to 4 are unchanged: school powers come only from
delegations.

## The three new endpoints

All three run on the identity path (no tenant context) and authenticate through `requireSessionAuth`, so the password
gate, the MFA gate (org admins must use two-step) and the idle and absolute session limits apply as on every route.

1. **`GET /v1/org/organizations`.** The caller's own organisation memberships (`organization_memberships`, role
   `org_admin`), every status, so the picker can say "Suspended" instead of hiding an organisation. Id, name, slug, kind
   and status. Only the caller's own rows; another person's memberships are never read.
2. **`GET /v1/org/organizations/{organizationId}/admins`.** The org admins of ONE organisation: user id, full name,
   e-mail, account status, since when, and `isYou`. Allowed only when the caller is an org admin of that organisation
   and the organisation is `active` (the same rule `/v1/org/schools` already uses). Another organisation, an unknown id
   and a non-active organisation all answer the same `403`, so the endpoint does not reveal which organisations exist.
   No contact field other than the e-mail the person signs in with; no phone.
3. **`GET /v1/org/organizations/{organizationId}/audit-events`.** The caller's OWN audit events that concern that
   organisation: events they caused (`actor_user_id` = the caller) in one of its schools, or whose detail names the
   organisation (delegation grants, revokes and refusals). Newest first, keyset-paged on `(occurred_at, id)`. The `ip`
   column is never returned. Same organisation rule and the same `403` as above.

`security_audit_events` stays without any `SELECT` grant for `figbloom_app`. The read goes through one new
`SECURITY DEFINER` function, `org_my_audit_events(uuid, timestamptz, uuid, integer)`, the same pattern as the credential
readers: owner the migrator, `search_path = pg_catalog, pg_temp`, schema-qualified, `EXECUTE` for `figbloom_app` only.
It takes the actor from `app_current_user_id()` (set by the server from the verified session, never from the request),
re-checks in the database that the actor is an org admin of an active organisation, and returns at most 200 rows. It
cannot be asked about anyone else's events.

## Migration 105

- Permissions `org.admins.read` and `org.audit.read`, granted to the `org_admin` role only. They are organisation-level,
  not school-scoped, and NOT delegable (they are not in `DELEGABLE_PERMISSIONS` or `is_delegable_permission`, and the
  drift test compares the two).
- The definer function above.
- No new table, so no new RLS policy and no table grant. `organization_memberships`, `organizations`, `tenants` and the
  non-secret `users` columns were already readable by `figbloom_app` (identity tables, application-filtered,
  `TENANT-ISOLATION.md` "identity bootstrap tables").

## Tests (`test/orgConsole.test.ts`)

Positive reads for an org admin, and the negative cases: another organisation's admins and audit (`403`), a school
admin, a plain teacher, a parent and a super admin with no organisation (`403`, no permission), a non-active
organisation (`403`), an unknown id (`403`, same body), another person's events never returned, the caller's events in
another organisation's school never returned, a cursor from another organisation refused, `mfa_required` for an org
admin without two-step when enforcement is on. Catalogue tests: the definer inventory, the grants matrix and the
permission registry list the new function and codes.

## Open owner decisions (NOT built)

The policy does not settle these. Nothing was built for them; the web console hides each control with a written reason.

1. **Who may add an org admin?** Options: (a) a super admin only, the same as a school administrator invitation today
   (`ACCOUNT-LIFECYCLE.md`); (b) any org admin of the same organisation. Risk with (b): an org admin who can add org admins
   can add a second account they control and then delegate to it, which gets round "no self-delegation", and it widens
   the set of delegation recipients, which the policy says needs explicit approval ("Widening eligibility ... must not
   happen silently"). Once decided, the build is an organisation invitation (token, accept path, audit) plus a
   permission grant.
2. **Who may remove or suspend an org admin, and may the last one be removed?** Removing a membership already revokes the
   person's delegations (migration 026 trigger, `org_membership_removed`). The question is who may do it: a super admin
   only, or any org admin of the organisation (which lets one admin lock the others out).
3. **May an org admin read other people's audit events in the organisation** (delegations granted by school admins or
   other org admins, actions in member schools)? The policy already treats listing other administrators' delegations as
   a separate decision ("Listing by org admins: not implemented, deliberately"). This change returns only the caller's
   own events.
4. **Which per-school figures may the console show?** The Supabase console shows learners, attendance today and fees
   billed and collected per school. The policy grants "aggregate visibility" but does not say which aggregates; fees in
   particular are finance data an org admin cannot otherwise read on the API. `GET /v1/org/schools` stays name, slug and
   status.
5. **Listing delegations by org admins** (already open in `ORG-ADMIN-POLICY.md`): an org admin can grant and revoke but
   cannot list what is granted in a school. The console shows only the caller's own access in a school.

Also not built, because the policy and the account rules already answer them: adding a school (school provisioning is a
super-administrator act) and opening a school for sign-in (a school becomes active when its first administrator accepts
the invitation).
