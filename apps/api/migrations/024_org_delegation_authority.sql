-- FIG-1609 — organization administrators grant and revoke school delegations (Ancel, 2026-11-12).
-- Forward-only. Two DISTINCT organization-scoped permissions, never reused from the
-- school-scoped rbac.org_delegations.* pair, and NOT on the delegable allowlist
-- (apps/api/src/modules/rbac/delegations.ts), so no delegate can ever pass them on.
--
-- Held by the org_admin ROLE (like org.tenants.read). They authorise an action only for
-- schools of the organization the caller administers; the application re-derives that
-- scope on every request (resolveDelegationActor). Nothing here changes a table, a policy
-- or a grant, so the runtime-role / RLS guarantees of migrations 009-015 are untouched.

INSERT INTO permissions (code, description) VALUES
  ('org.delegations.grant',  'Organization: grant allowlisted school delegations to org admins of the same organization'),
  ('org.delegations.revoke', 'Organization: revoke any school delegation within the organization')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code) VALUES
  ('org_admin', 'org.delegations.grant'),
  ('org_admin', 'org.delegations.revoke')
ON CONFLICT (role, permission_code) DO NOTHING;
