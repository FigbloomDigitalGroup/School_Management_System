# Organization administrator authorization policy (R2-05)

**Status:** APPROVED · IMPLEMENTED · VERIFIED (Ancel policy decision 2026-11-12)  
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
