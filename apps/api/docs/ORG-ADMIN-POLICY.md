# Organization administrator authorization policy (R2-05)

**Status (updated 2026-11-17):** policy APPROVED (Ancel) · **FIG-1609 implemented locally, not yet independently accepted**: org admins grant and revoke through `POST` / `DELETE /v1/rbac/org-delegations` using the distinct, non-delegable permissions `org.delegations.grant` and `org.delegations.revoke` (migration 024, held by the `org_admin` role). Suspended-school rules, original-grantor audit and denial audits are implemented (`delegations.ts`, `withDelegationRequest`). Verification state is in `PHASE3-FINAL-AUDIT-REPORT.md` / the FIG-1609 Linear evidence; do not call it accepted until the DB-backed suite (`test/fig1609.orgDelegation.test.ts`) has been run and independently reviewed. Sections below headed "NOT implemented" describe the state before 2026-11-17 and are kept as history.  
**Allowlist: RESOLVED 2026-11-17 (owner).** The delegable set is exactly the approved five families (`tenant.read`, `rbac.staff_areas.manage`, `rbac.school_roles.manage`, `resource.learner.read`, `area.*`); `resource.learner.write`, `resource.guardian.*`, `resource.staff.*`, `resource.school_profile.*` and `resource.document.*` are NOT delegable. See "Allowlist resolution and legacy grants" at the end.  
**Decision:** Organization administrators do **not** automatically inherit school-administrator privileges.

## Approved policy

1. Organization administrators have organization-level access and authorized **aggregate** visibility across their schools (`GET /v1/org/schools`, `org.tenants.read`).
2. They do **not** automatically inherit full school-administrator privileges (`mayAdminister` is false for org-only acting).
3. They cannot grant or revoke school staff permissions by virtue of their organization role alone.
4. School-level administrative capabilities require **explicit delegation**.
5. Delegations are granular (permission codes), school-scoped, revocable, and auditable (`org_admin_school_delegations`).
6. Actions performed through delegated authority identify the acting organization administrator and school context (`actingVia: org_admin_delegation`, actor + tenant on audit events).
7. Existing tenant-isolation, membership and school-suspension protections remain mandatory.

## Explicit boundaries

| Actor | Aggregate org console | Inside member school (no delegation) | Staff area grants | Explicit school delegation |
|---|---|---|---|---|
| Platform super_admin | Yes | Full act (incl. suspended) | Yes | Yes |
| Organization admin | Yes (own orgs) | Select tenant + base org role perms only | No | Consume only (cannot self-grant) |
| School admin | No | Full for own school | Yes | Grant / revoke to org_admins of the school's org |
| Teacher / staff | No | Role + area grants | No | No |
| Parent / student / driver | No | Role permissions only | No | No |

## Delegable permission codes

Whitelist in `apps/api/src/modules/rbac/delegations.ts` (`DELEGABLE_PERMISSIONS`):

- `tenant.read`
- `rbac.staff_areas.manage`
- `rbac.school_roles.manage`
- `resource.learner.read`
- `area.*` (all admin areas)

Granting requires `rbac.org_delegations.manage` (school_admin / super_admin). Org admins cannot escalate by granting themselves or others.

## Effective access

- Loaded on every request from active rows (`revoked_at IS NULL`) joined to live org membership, active organization, and non-suspended school.
- Revocation and membership / suspension changes take effect on the next request.
- `GET /v1/rbac/permissions` returns `delegatedPermissions[]` and `actingVia` for UI metadata (hint only; server re-checks).

## Dual-run note

Legacy Supabase web/mobile still use `packages/shared` `adminAreas.ts` (`org_admin` → `"all"`). That surface is **unchanged** in this programme to avoid silently removing product capabilities in the dual-run apps. The **replacement API** (`apps/api`) enforces this approved policy. Phase 9 UI integration must switch clients to `GET /v1/rbac/permissions` / org aggregate endpoints.

## Migration

`005_org_admin_delegation.sql` — forward-only.

---

## Stage C note (2026-11-14)

No policy change. Stage C (accepted; FIG-1605 / FIG-1619) did not change delegation rules. The same checks now run inside the tenant transaction, after the tenant is authorised and `app.tenant_id` is set, as the `figbloom_app` runtime role. Denial audits for a missing permission are written after rollback; grant and revoke audits stay inside the transaction. Statements below that describe "commit `64b937c`" are historical and were verified before the runtime role change; the behaviours they describe are preserved by the Stage C suite. See `RUNTIME-DATABASE-SECURITY.md`.

---

## Clarification recorded 2026-11-12 (Ancel; FIG-1573 follow-up tracking)

> An organization administrator may delegate explicitly permitted school-level permissions within their organization **without personally holding every permission they delegate**. Delegation is restricted to an explicit allowlist; no platform-level or cross-organization privileges can be delegated; self-delegation and non-delegable permissions remain prohibited; all grants, revocations and delegated actions must be audited.

### Status against the code (verified by reading `delegations.ts`, `rbac.ts`, migration 005 on commit `64b937c`)

| Clarification element | Implemented? |
|---|---|
| Explicit allowlist of delegable permissions | **Yes**: `DELEGABLE_PERMISSIONS` (`tenant.read`, `rbac.staff_areas.manage`, `rbac.school_roles.manage`, `resource.learner.read`, `area.*`); any other code is rejected with 400 |
| The permission holder need not already hold what is delegated (org admins hold no school permissions by default) | **Yes**: probe showed a delegated `rbac.staff_areas.manage` lets the org admin set areas (`fees`, `medical`) it was never itself granted |
| No platform-level or cross-organization privileges | **Yes**: delegate must be an `org_admin` of the **school's own** organization (`assertOrgAdminOfTenantOrg`); platform codes are not on the allowlist; the delegation FK binds `(tenant_id, organization_id)` |
| Self-delegation and non-delegable permissions prohibited | **Yes** (`rbac.org_delegations.manage/read` are non-delegable; self-delegation 403) |
| Grants, revocations, delegated actions audited | **Yes**: `rbac.org_delegation.granted` / `.revoked`; `rbac.staff_areas.changed` carries `actingVia: org_admin_delegation` and `actorIsOrgAdmin` |
| **An org admin acting as the delegator** | **NOT implemented.** Today only a school administrator (or a platform super admin) of that school may grant or revoke a delegation, because `rbac.org_delegations.manage` is held only by `school_admin` / `super_admin` and is non-delegable |

**Resolved 2026-11-12:** Ancel approved interpretation (b): an org admin may themselves grant and revoke school-level delegations. The code implements only the older model (school admin / super admin grant). The gap is tracked as **FIG-1609**.

### Permission classes (reference)

| Class | Examples | Who may hold | Delegable? |
|---|---|---|---|
| Organization-level aggregate | `org.tenants.read` (`GET /v1/org/schools`) | `org_admin` of own active organizations | No (role grant, not school-scoped) |
| School-scoped delegated | `tenant.read`, `rbac.staff_areas.manage`, `rbac.school_roles.manage`, `resource.learner.read`, `area.<admin area>` | An `org_admin` of the school's organization, only through an active delegation | Yes (allowlist) |
| Non-delegable | `rbac.org_delegations.manage/read`, `rbac.permissions.read`, `identity.*`, `session.manage`, any `platform.*`, anything not on the allowlist | Role-based only | **No** |

### Grant, revocation and attribution

- **Grant / revoke:** `POST` / `DELETE /v1/rbac/org-delegations` (school admin or super admin of the school); `GET` lists active and revoked. Grants are granular, school-scoped, revocable (`revoked_at`, `revoked_by`) and take effect on the next request.
- **Attribution:** every delegated action records the acting user, the school (tenant) and `actingVia: org_admin_delegation` in `security_audit_events`; the grant and revoke events record who granted, the delegate, the organization and the permission codes.
- **Limits that always apply:** tenant isolation, school suspension (delegated permissions have no effect while suspended; the approved grant/revoke rules for suspended schools are in "Suspended schools" below), live org membership and an active organization.
- **Superseded observation (F-3):** an earlier note said a delegate holding `rbac.staff_areas.manage` could set any admin areas, "including ones the delegate does not hold". That is no longer true: since 2026-11-17 a delegate may assign only the `area.*` codes delegated to them (see "Staff-area and school-role assignment" below).

---

## Approved policy versus currently implemented behaviour (2026-11-12)

> **Historical snapshot.** The "implemented today" table and the "NOT implemented" labels in this section and in "Final decisions" below describe commit `64b937c` (2026-11-12). Since then FIG-1609 was implemented locally (migrations 024 and 025) and is **not yet independently accepted**. The current state is the status line at the top of this file and the "FIG-1609 review hardening" sections below.

### Approved policy (binding for future work)

An organization administrator: has organization-level access to authorized aggregate information; does **not** automatically receive school-administrator privileges; **may grant and revoke** explicitly permitted school-level administrative permissions to other eligible users within their organization; does **not** need to personally hold every permission they delegate; cannot delegate outside the delegable-permission allowlist; cannot delegate platform-level or cross-organization privileges; cannot delegate to themselves; cannot bypass school suspension, tenant isolation or resource ownership restrictions.

Every delegation: school-scoped; identifies the granting org admin and the recipient; records the permission, the organization and the school; revocable; produces an audit event; enforced by the backend.

"Eligible users" is kept at the existing rule (an org admin of the same organization, other than the grantor). **Widening eligibility, or broadening the allowlist, needs Ancel's separate explicit approval** and must not happen silently.

### Implemented today (commit `64b937c`)

| Capability | State |
|---|---|
| Aggregate org console `GET /v1/org/schools` (own active organizations) | Implemented, verified |
| School-level power for org admins only through explicit delegation | Implemented, verified |
| Allowlist (`DELEGABLE_PERMISSIONS`), self-delegation refusal, same-organization recipient, suspension/isolation limits | Implemented, verified |
| Audit of grants, revocations, delegated actions with `actingVia` and actor/school | Implemented, verified |
| **Granting / revoking performed by a school admin or super admin** | Implemented, verified |
| **Granting / revoking performed by an organization admin** | **NOT implemented.** Needs a new org-scoped, non-delegable permission and authorisation path. Tracked: **FIG-1609** (Backlog, not authorised) |
| Revocation of any delegation in their organization by an org admin, including ones a school admin granted | **Approved 2026-11-12** (see below); **NOT implemented**, FIG-1609 |

Audit `actingVia` today takes only `super_admin` or `school_admin` for grant/revoke events; FIG-1609 adds `org_admin`.

---

## Final decisions (Ancel, 2026-11-12) - revocation and authority separation

These **refine and supersede** the earlier default ("only their own grants"). All of this is **approved policy, NOT implemented** until FIG-1609 is completed and independently verified.

1. **Granting.** An org admin may grant explicitly allowlisted school-level permissions to eligible users within their organization without personally holding them. Eligibility (an org admin of the same organization, other than the grantor) and the allowlist are **unchanged**.
2. **Revoking.** An org admin may revoke **any** delegation within their organization, **including delegations originally granted by a school administrator**. A school admin or super admin keeps the right to revoke too.
3. **Granting authority and revocation authority are distinct:** two separate org-scoped, non-delegable permissions (for example `org.delegations.grant` and `org.delegations.revoke`), never reused for the school-scoped `rbac.org_delegations.*`, and neither delegable.
4. **Restrictions that always apply:** no self-delegation; nothing outside the allowlist; no cross-organization delegation; no platform-level privilege; school and tenant boundaries and suspension enforced; **revocation immediately invalidates authorization** (delegations are re-read on every request).
5. **Every revocation must record:** acting administrator, original grantor, recipient, organization, school, permission, timestamp and revocation outcome. Today's revoke event does **not** yet record the original grantor, organization or outcome.
6. **Suspended schools: decided (Ancel, 2026-11-12).** See "Suspended schools" below.

| Element | State |
|---|---|
| Org admin grants allowlisted delegations | Approved, **not implemented** |
| Org admin revokes any delegation in their organization | Approved, **not implemented** |
| Distinct grant and revoke permissions | Approved, **not implemented** |
| Full revoke audit attribution (original grantor, organization, outcome) | Approved, **not implemented** |
| Immediate invalidation after revoke (next request) | **Implemented and verified** for revocations made today |

---

## Suspended schools (final decision, Ancel 2026-11-12)

**Approved policy. Not implemented as a whole until FIG-1609 is completed and independently verified.**

| Operation | Suspended school | Active school |
|---|---|---|
| Grant delegation | **Prohibited** | Allowed with authorization |
| Revoke delegation | **Allowed** | Allowed with authorization |
| Exercise delegated permissions | **Prohibited** | Allowed if otherwise authorized |

Security rationale:

1. Suspension must never introduce new privileges.
2. Existing delegations must stay revocable during suspension.
3. Revocation reduces access, so it stays available to authorized administrators.
4. Suspension immediately stops delegated permissions being exercised.
5. Revocation immediately invalidates the affected authorization.

When a school is restored to active, a delegation works again only if it is still valid (not revoked, recipient still an org admin of the organization, organization active). A delegation revoked during suspension stays revoked. The allowlist, recipient eligibility and organization boundaries are unchanged.

### Suspended schools: actors (final, Ancel 2026-11-12)

**Grants.** No administrator may grant a new delegation on a suspended school: **school admin, org admin and super admin alike**. Every attempt is refused with HTTP 403, creates no delegation record, and produces an audit event with reason `school_suspended`.

**Revocation** stays available during suspension because it reduces privileges:

| Actor | Revocation authority |
|---|---|
| School administrator | Delegations within their own school, subject to their authorization scope |
| Organization administrator | Delegations within their organization, including ones created by school administrators |
| Super administrator | Delegations across schools within their explicitly authorized platform scope |

Every revocation records the acting administrator, original grantor, recipient, organization, school, permission, timestamp and outcome.

**Use.** No delegated permission may be exercised while its school is suspended, even on an existing authenticated session, even when the delegation was created before suspension and is otherwise valid. After restoration, access resumes only if the delegation is still valid and not revoked. A revocation made during suspension is permanent; access returns only through a new grant made after restoration.

Nothing in this section widens any actor's scope beyond what it states.

### Suspended schools: implemented today (commit `64b937c`, static reading; not separately tested for delegations)

| Element | Today | Matches policy? |
|---|---|---|
| Exercising a delegated permission in a suspended school | Refused: the delegation loader requires `t.status <> 'suspended'` (`delegations.ts`), and org admins of a suspended school get 403 (`authorize.ts`, `tenancy/context.ts`) | **Yes** (no delegation-specific regression test yet) |
| Granting in a suspended school | School admins and org admins: refused (403 on every request). **Super admin: probably allowed** (a super admin may act in a suspended school and the grant path has no suspension check; inferred, not tested). The resulting grant could not be exercised while suspended | **No** for super admin |
| Revoking in a suspended school | Only a super admin can. School admins and org admins are locked out by the general suspended-school 403 | **No** (org-admin revoke is FIG-1609 anyway) |
| Audit `denied` event with reason `school_suspended` for a refused grant | Not implemented | **No** |
| School admin revoking in their own suspended school | Not possible (locked out by the general suspended-school 403) | **No**: needs a narrowly scoped revoke-only path that reopens nothing else |
| Access resuming after restoration only for unrevoked, still-valid delegations | Follows from the per-request loader (`revoked_at IS NULL`, live membership, active organization, non-suspended school) | Probably yes; **not tested** |

All of the above is **approved policy, not fully implemented**, until FIG-1609 (acceptance-criteria group 9) is completed and independently verified.


---

## FIG-1609 review hardening and allowlist assessment (2026-11-17)

### Implemented (migration 025, `delegations.ts`, `rbac.ts`)

| Item | Behaviour | Evidence |
|---|---|---|
| Grant versus suspension race | `org_delegation_guard` (BEFORE INSERT, `SECURITY DEFINER`) takes `FOR SHARE` on the school row. A suspension that commits first makes the grant refuse (403, `school_suspended`, audited); a grant that commits first makes the suspension wait and then proceed, leaving an inert delegation. Grants share the lock, so they do not serialise each other and cannot deadlock with it. | `fig1609.hardening.test.ts` A: lock held from a second connection forces each interleaving; fails (6 tests) with the trigger disabled |
| Idempotent replay | The suspension check and the actor's authority run **before** the idempotency lookup. A replay after the delegation was revoked answers 409, not a stale 200. A legitimate replay still returns the stored 200 with `Idempotent-Replayed: true`. | `fig1609.hardening.test.ts` B |
| Disabled recipients | The same trigger takes `FOR SHARE` on the user row; a disabled recipient is refused (400, audited `ineligible_recipient`), including one disabled while the grant is in flight. An **existing** delegation of a user disabled later is left on record (not silently rewritten) but is unusable because the user's session is dead; re-enabling restores it. | `fig1609.hardening.test.ts` C |
| Listing by org admins | **Not implemented, deliberately.** FIG-1609 requires grant, revoke, audit and immediate invalidation; it never requires listing, and `rbac.org_delegations.read` is school-scoped and not given to `org_admin`. Org admins already see their own effective delegations in `GET /v1/rbac/permissions` (`delegatedPermissions`). Granting a read permission only for symmetry would widen exposure of other administrators' access. If the owner wants it, it is a separate narrowly scoped, organisation-scoped read permission. | `fig1609.hardening.test.ts` D |
| Database allowlist | `is_delegable_permission(text)` (pure function) and the guard trigger reject any code outside the set below on INSERT. **Existing rows are not re-validated**, so no old record can break the migration or revocation. A test compares the database predicate with `isDelegablePermission` for every catalogue code, every area and junk codes (guardrail 5: TypeScript and SQL must change together). The set is now exactly the approved five families (see the resolution section). | `fig1609.hardening.test.ts` E |

### Allowlist discrepancy: history (superseded by the resolution below)

The earlier phases accepted `resource.learner.write` (VS-1, `60c75be`), `resource.guardian.*` (VS-2, `df1a2dd`) and `resource.staff.*`, `resource.school_profile.*`, `resource.document.*` (Phase 3 work). None had a recorded owner approval.

## Allowlist resolution and legacy grants (owner decision, 2026-11-17)

**Decision.** Organization-admin delegation enforces only the original approved families. The later codes are not approved for delegation. Historical implementation is not owner approval. M-2 must not let delegation bypass the explicit guardian model (FIG-1614 Option D).

| Layer | Enforcement |
|---|---|
| Application | `DELEGABLE_PERMISSIONS` / `isDelegablePermission` (`delegations.ts`): 4 codes plus the 12 admin areas |
| Database | `public.is_delegable_permission(text)` and the BEFORE INSERT guard on `org_admin_school_delegations` (migration 025): identical set; direct writes of any other code are refused (`permission_not_delegable`) |
| Drift | `fig1609.hardening.test.ts` compares both for the approved codes, every unapproved family and every catalogue code |
| Exercise | `loadActiveDelegations` filters with the same SQL predicate, so a grant whose code is not delegable confers **nothing** |

**Legacy grants (rows created while the wider list was accepted).** Compatibility assessment, from the code and the migration history: any `org_admin_school_delegations` row with `permission_code` in `resource.learner.write`, `resource.guardian.read/write`, `resource.staff.read/write`, `resource.school_profile.read/write`, `resource.document.read/write` was created by a school administrator or super administrator through `POST /v1/rbac/org-delegations` after 2026-11-13. This repository's disposable databases hold none, and **no hosted database was inspected** (none is accessible), so the number of affected schools, users and records is **unknown and must be taken from the target database before rollout** with:

```sql
SELECT tenant_id, delegate_user_id, permission_code, granted_by, created_at
  FROM org_admin_school_delegations
 WHERE revoked_at IS NULL
   AND NOT public.is_delegable_permission(permission_code)
   AND permission_code <> 'area.people'   -- still honoured; reviewed with docs/sql/area-people-delegation-review.sql
 ORDER BY tenant_id, created_at;
```

Handling implemented (no invented revocation policy, nothing destroyed):

1. Rows are never deleted or rewritten; they stay on record and stay revocable (revocation is unchanged and still attributed).
2. They are **inert**: the effective-permission loader ignores them, so they cannot be used and cannot undermine the explicit guardian model. Customer impact: an org admin who held, for example, learner-write through such a grant loses that access immediately on deployment. This follows directly from the owner decisions; if any school depends on one, a school administrator must use the approved mechanisms instead (for example `area.people`, which implies learner/staff/document access under its own rules).
3. Migration 025 records each active legacy row once as `rbac.org_delegation.legacy_inert` (delegation, organisation, school, recipient, code, original grantor) so the owner can review them; re-running adds nothing.
4. A revoked legacy grant cannot be restored: re-granting is refused at the API and the database, replay of the refused request is refused again, and `revoked_at` cannot return to NULL (immutability trigger).
5. Existing grants are not renewed or expanded: any new grant must pass the approved list.

`area.*` follows the existing area rules: delegating `area.people` implies the People set (`PEOPLE_AREA_IMPLIED`: learner read/write, staff read/write, school-profile read, document read/write) but **never** guardian access or school-profile write. That implication is the approved `area.*` rule, unchanged by this decision.

**M-2 (resolved).** `resource.guardian.read/write`, `rbac.guardian_access.manage` and `org.delegations.*` are not delegable, delegation recipients remain exactly as owner-approved (an org admin of the school's own organization, other than the grantor; unchanged), the separate explicit guardian grant of FIG-1614 goes only to school-office teachers/staff and never through a delegation, and `rbac.staff_areas.manage` / `rbac.school_roles.manage` carry only admin areas, so no delegation path reaches guardian records. Tests: `fig1609.hardening.test.ts` ("M-2", "legacy rows").

### Rollout ordering (review finding)

Deploy the **new application first, then apply migration 025**, or apply 025 only after every old instance is gone. Application code from before this change does not filter inert legacy delegations, so during a rolling deploy an old instance would still honour a legacy guardian or learner-write grant until it is replaced, and legacy rows an old instance inserts after the audit block runs would not be recorded. Run the legacy-row query above on the target database before rollout and revoke what the school administrators do not need.

### Owner decision: `area.people` is not grantable by delegation (2026-11-17, IMPLEMENTED, migration 026)

Delegating `area.people` makes the People set effective (`resource.learner.write`, `resource.staff.*`, `resource.document.*`, school-profile read; never guardian, never profile write). The owner does not approve that reach for delegation.

* **New grants are refused:** `area.people` is out of the allowlist in TypeScript (`DELEGABLE_PERMISSIONS`) and in SQL (`is_delegable_permission`, migration 026). The API answers 400 `not_delegable`; the database guard refuses a direct insert. The other 11 `area.*` codes and the four named codes are unchanged. Tests: `fig1609.hardening.test.ts` (allowlist drift) and `fig1609.lifecycle.test.ts`.
* **Existing grants are not revoked.** Whether any exist cannot be known from the repository: no hosted database was inspected, and this repository's disposable databases hold none; **no production count exists and none is claimed here.** Existing active `area.people` delegations can carry the learner, staff and document writes above (verified by test). To avoid a silent loss of access they **keep working**, stay revocable, and migration 026 records each active one once as `rbac.org_delegation.review_required`. The complete read-only review script is `apps/api/docs/sql/area-people-delegation-review.sql` (procedure below).
* **Proxy path (closed 2026-11-17):** a delegate holding `rbac.staff_areas.manage` could assign the `people` area to school staff without holding it. That is now refused; see the next section.
* **Future direction (not implemented, not authorized here):** granular delegable capabilities such as `resource.learner.read` / `.write`, `resource.staff.read` / `.write`, `resource.document.read` / `.write`, so that a People-style delegation can be expressed without the whole implied set.
* **Compatibility during rollout:** a new application against a database still at 025 behaves correctly (it refuses new `area.people` grants itself). An OLD application against a 026 database would treat existing `area.people` rows as inert, because its loader filters with the new `is_delegable_permission`; deploy the application first.

### Staff-area and school-role assignment (owner principle, 2026-11-17, IMPLEMENTED for staff areas)

Principle: an administrator may not assign capabilities exceeding the authority they are permitted to administer. These are four different things and are not interchangeable:

| Pathway | Who may do it | Maximum authority the actor can assign | Finding |
|---|---|---|---|
| **Delegating authority** to an org admin (`/v1/rbac/org-delegations`) | school admin, super admin, or an org admin of the school's organization | only allowlisted codes, never `area.people`, never guardian or delegation-management codes; to an org admin of the same organization; never to oneself | Bounded by the allowlist (FIG-1609); an org admin may grant codes they do not hold, by owner decision |
| **Assigning a staff functional area** (`PUT /v1/rbac/staff-areas`, `rbac.staff_areas.manage`) | school admin and super admin (administer every area); a delegate holding the permission | school admin / super admin: any of the 12 areas. **Delegate: only the `area.*` codes delegated to them** | **Defect fixed 2026-11-17** (below) |
| **Assigning a predefined school role** (`rbac.school_roles.manage`) | nobody, through the API | none | **No write path exists** (below) |
| **Granting direct resource permissions** | guardian access only (`/v1/rbac/guardian-access`): school admin and super admin | `resource.guardian.read/write` to an individual teacher or staff member of that school | Not reachable from either management permission |

**Staff areas, traced end to end.** `rbac.staff_areas.manage` comes from the `school_admin` and `super_admin` roles, or from an active delegation (it is on the allowlist). The route takes the school from the session or an `X-Tenant-Id` the caller proves access to (a delegate's authority is re-derived from the organization that owns that school, so it cannot reach another organization's school; tested), accepts only an existing teacher or staff membership in that school (404 otherwise, 403 for other roles), refuses self-assignment, validates the areas, serialises concurrent edits per person, replaces the person's areas, and audits `rbac.staff_areas.changed` (previous and new areas, `actingVia`, `actorIsOrgAdmin`, and now also the delegate's scope). **Provenance (owner decision 2026-11-17).** The authority to make NEW assignments ends the moment the delegation is revoked (the next request gets 403). Assignments already made while the actor was authorized become school-level staff assignments: they are **not** revoked with the delegation (no cascade), stay under the school's normal administration (a school administrator can change or remove them), and stay attributable. Each `staff_area_grants` row keeps `granted_by` and `granted_at` of the person who assigned it, and the route applies only the *difference* between the old and new areas, so a later edit by anyone does not re-stamp the areas that were kept (an earlier version deleted and re-inserted everything, which would have overwritten the original assigner). Each `rbac.staff_areas.changed` event records who (`actor_user_id`), when (`occurred_at`), the school (`tenant_id`), the target, the previous, added, removed and resulting areas, `actingVia`, and for a delegate the delegated areas and `authorizingDelegationIds` (the delegations of `rbac.staff_areas.manage` and of the area codes touched; the delegation rows are never deleted, so they stay available after a revocation). The review query for this is in the procedure below. `people` expands to exactly `resource.learner.read/write`, `resource.staff.read/write`, `resource.document.read/write` and `resource.school_profile.read`; it never implies guardian access or school-profile write (tested). Nothing crosses a school or tenant boundary.

**The defect.** Before this change the route checked only that the actor held `rbac.staff_areas.manage`. A delegate with no area authority of their own could therefore set any of the 12 areas, including `people`, on any teacher or staff member of the school. That is an assignment beyond the actor's own authority and a way around the decision that `area.people` must not be delegated. Corrected, narrowly: an actor who is not a school administrator or super administrator may assign, and remove, only the areas delegated to them (`area.*`). A request containing any other area is refused whole with 403 and an audited `rbac.staff_areas.denied` (`area_beyond_authority`, listing the areas requested beyond authority); areas the person already holds outside the actor's authority are kept. School administrators and super administrators are unchanged. A delegate who holds an existing `area.people` delegation can still assign `people` (it is inside their authority; reviewing those holders is the purpose of the procedure below). Tests: `fig1609.staffAreas.test.ts` (10; five fail with the rule disabled).

**Note on provenance:** this is an application of the owner's stated principle, not a quoted owner decision on `rbac.staff_areas.manage`. The earlier observation F-3 had treated "any area" as consistent with the delegation clarification. If the owner wants the earlier behaviour back, it is one block in `PUT /v1/rbac/staff-areas`.

**School roles.** `rbac.school_roles.manage` is delegable and held by school admins, but **no route creates or assigns school roles**, and the runtime database role has `SELECT` only on `school_roles` and `school_role_assignments` (grants-matrix test; the new test also checks that `INSERT`, `UPDATE`, `DELETE` and `TRUNCATE` are all refused for that role). The earlier statement that it "assigns areas through school roles" was wrong: it can do nothing today. Rows in those tables can only be written by owner-run administration; if any exist, `loadEffectiveAreas` honours the areas they carry, and no delegate can create or change them. If an API for school roles is ever built, it must apply the same rule (assign only what the actor administers).

### Production review procedure for existing `area.people` delegations

Nothing in this procedure was run against production. The count and identities are unknown until it is run; do not take a count from the rehearsal databases.

1. **Confirm the target.** `SELECT current_database(), inet_server_addr(), current_user;` and the latest applied migrations (`SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 3;`). Record them with the date. The script also works on a database still at 025.
2. **Run the read-only script** `apps/api/docs/sql/area-people-delegation-review.sql` as a read-only user. It runs in a `READ ONLY` transaction, contains no write or DDL statement, and returns names and ids only (no e-mail, phone, password or session data).
3. **Record the summary** (second result): active total, active and currently effective, invalidated, revoked, distinct recipients, distinct schools. Active rows that are not currently effective (suspended school, disabled recipient, inactive organization) still need a decision.
4. **Review each active row** (first result): organization, school, recipient and grantor names, `granted_at`, whether it works today, the capabilities (learner, staff and document read/write), whether the recipient also holds `rbac.staff_areas.manage`, and `staff_areas_assigned_by_recipient` (areas they have already given to staff, which persist). Ask the school administrator and the organization owner for the business justification.
5. **Decide per grant** (the owner or the delegated approver): revoke, or keep with a recorded justification. Do not revoke in bulk and do not use SQL to change the table.
6. **Revoke what is not approved through the API** (`DELETE /v1/rbac/org-delegations` with `delegateUserId` and `permissionCodes: ["area.people"]`, as a school administrator, the organization administrator or a super administrator). That records the actor and the original grantor in the audit trail and takes effect on the next request.
7. **Preserve approved grants** with the justification stored in the change record; they stay revocable at any time.
8. **Verify.** Re-run the script (revoked rows show `state = revoked`), check one `rbac.org_delegation.revoked` event per revocation, and check the recipient no longer holds the People capabilities (`GET /v1/rbac/permissions`). For recipients who also assigned areas, review those assignments: `SELECT occurred_at, tenant_id, actor_user_id, detail FROM security_audit_events WHERE event_type = 'rbac.staff_areas.changed' AND detail->>'actingVia' = 'org_admin_delegation' ORDER BY occurred_at;`
9. **Order.** Do the review before applying 026 if possible, and before the grants matter to a rollout decision. After 026, each active row carries a `review_required` event, reported by the script as `flagged_for_review_at`.

### Owner decision: delegation lifecycle (2026-11-17, IMPLEMENTED, migration 026)

A material change to the authorization relationship **invalidates** the affected grants: they are revoked (final, audited), not left dormant, and restoration never revives them. A fresh grant is required.

| Event | Effect |
|---|---|
| User disabled (active to anything else) | All delegations and all guardian grants of that user, in every school, are revoked (`user_disabled`) |
| Organization membership removed (`org_membership_removed`), moved to another user or organization (`org_membership_transferred`) or its role changed (`org_membership_role_changed`) | That person's delegations in that organization are revoked |
| Organization leaves `active` (suspended, rejected, pending) | Every delegation in that organization is revoked (`organization_inactive`); guardian grants are unaffected (they depend on the school membership, not the organization's status) |
| School membership archived, deleted, role changed (025) or moved to another user or school (026, `membership_transferred`) | The guardian grants it carried are revoked |
| **School suspended** | **Not an invalidation.** Grants cannot be exercised, may be revoked, and resume on restoration if they remain valid and unrevoked (unchanged) |

Implementation: SECURITY DEFINER triggers and two internal helpers (`invalidate_org_delegations`, `invalidate_guardian_grants`) because these changes are made outside the API. They fire only on a real transition, revoke only active rows, and write one `outcome: "invalidated"` audit event per school with `reason`, `actingVia: "system"`, the recipient, the permission codes and the original grantors; repeats add nothing. The revocation records `revoke_reason` instead of a `revoked_by` (a new column on `org_admin_school_delegations`, with no privilege for the runtime role, so the application cannot record an unattributed revocation). The loaders keep their joins as defence in depth. Grants that were already dormant when 026 is applied (disabled user, missing membership, inactive organization, no live teacher/staff membership) are revoked once by the migration (`invalidated_at_migration`); it is repeatable.

Limitations: a school moved to another organization is blocked by the existing composite foreign key while delegations reference it (fails closed, not handled); the organization-membership role can only be `org_admin` today, so a role-change branch exists but cannot yet be exercised; no API path performs these state changes, so the triggers are tested at the database level and through the HTTP effects. Tests: `fig1609.lifecycle.test.ts` (11).

Also recorded from the review: `GET /v1/rbac/org-delegations` is school-scoped, so an org admin can revoke any delegation in the organization but cannot list them (deliberate); legacy inert rows show as `active` in that list without a flag.

### Consolidated review fixes (2026-11-17)

* Concurrent grants of the same code no longer produce several audit events that each claim to have newly granted it: grant and revoke now take a per-person advisory lock and the insert's row count is checked (`delegations.ts`; `fig1609.orgDelegation.test.ts`, mutation-checked).
* `DELETE /v1/rbac/org-delegations` with `permissionCodes: []` is refused with 400 instead of revoking everything; omit the field to revoke all (OpenAPI `minItems: 1`).
