# Organization administrator authorization policy (R2-05)

**Status (updated 2026-11-12):** policy APPROVED (Ancel) · **partially implemented**: aggregate access, explicit delegation consumed by org admins, the allowlist, audit and suspension rules are implemented and verified; **org admins granting/revoking delegations is approved but NOT implemented** (FIG-1609). Do not describe that capability as implemented until FIG-1609 is complete and independently verified.  
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
- **Observation (informational, F-3):** delegating a *management* permission such as `rbac.staff_areas.manage` lets the delegate set any admin areas on teachers, including ones the delegate does not hold. This is consistent with the clarification; there is no "cannot grant what you do not hold" rule.

---

## Approved policy versus currently implemented behaviour (2026-11-12)

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
