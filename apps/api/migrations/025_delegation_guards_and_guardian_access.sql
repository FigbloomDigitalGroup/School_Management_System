-- FIG-1609 hardening (race, disabled recipient, database allowlist) and FIG-1614 Option D
-- (explicit per-person guardian read/write grants). Forward-only; 001-024 are untouched.
--
-- Why triggers that lock rows: the application role has SELECT only on tenants and users, and a
-- SELECT ... FOR SHARE needs UPDATE privilege (same constraint as migration 008). These functions
-- run as the table owner (SECURITY DEFINER), take FOR SHARE on the row they depend on and so:
--   * a suspension / disabling (an UPDATE) that commits first makes the insert refuse;
--   * an insert that commits first makes the suspension / disabling wait, then proceed (the
--     grant exists but is inert while the school is suspended, exactly as policy says);
--   * two grants share the lock, so grants do not serialise each other.
-- Contract (docs/SECURITY-DEFINER-INVENTORY.md): owner = migrator, search_path = pg_catalog, pg_temp
-- (pg_temp last), every reference schema-qualified, EXECUTE revoked from PUBLIC.

-- ---------------------------------------------------------------------------
-- 1. Database allowlist for org-admin delegations (FIG-1609)
-- ---------------------------------------------------------------------------
-- EXACTLY the owner-approved policy (2026-11-12, re-confirmed 2026-11-17): tenant.read,
-- rbac.staff_areas.manage, rbac.school_roles.manage, resource.learner.read and the admin areas.
-- Earlier phases also accepted resource.learner.write, resource.guardian.*, resource.staff.*,
-- resource.school_profile.* and resource.document.*; the owner has NOT approved those for
-- organization-admin delegation. Changing this list later is a new migration plus a code change;
-- test/fig1609.hardening.test.ts fails if this function and delegations.ts drift.
CREATE OR REPLACE FUNCTION public.is_delegable_permission(code text) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT code = ANY (ARRAY[
    'tenant.read',
    'rbac.staff_areas.manage',
    'rbac.school_roles.manage',
    'resource.learner.read',
    'area.people', 'area.fees', 'area.academics', 'area.attendance', 'area.transport',
    'area.communication', 'area.inventory', 'area.activities', 'area.visitors',
    'area.medical', 'area.leave', 'area.audit'
  ]::text[]);
$$;
REVOKE ALL ON FUNCTION public.is_delegable_permission(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_delegable_permission(text) TO figbloom_app;

CREATE OR REPLACE FUNCTION public.org_delegation_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_school_status text;
  v_user_status text;
BEGIN
  IF NOT public.is_delegable_permission(NEW.permission_code) THEN
    RAISE EXCEPTION 'permission_not_delegable' USING ERRCODE = '23514';
  END IF;

  SELECT t.status INTO v_school_status FROM public.tenants t WHERE t.id = NEW.tenant_id FOR SHARE;
  IF v_school_status IS NULL OR v_school_status = 'suspended' THEN
    RAISE EXCEPTION 'school_suspended' USING ERRCODE = '55000';
  END IF;

  SELECT u.status INTO v_user_status FROM public.users u WHERE u.id = NEW.delegate_user_id FOR SHARE;
  IF v_user_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'recipient_not_active' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.org_delegation_guard() FROM PUBLIC;

-- INSERT only: rows that already exist are not re-validated, so no existing record can break
-- this migration or the application. A delegation's permission_code is never updated by the API.
DROP TRIGGER IF EXISTS org_admin_school_delegations_guard ON public.org_admin_school_delegations;
CREATE TRIGGER org_admin_school_delegations_guard
  BEFORE INSERT ON public.org_admin_school_delegations
  FOR EACH ROW EXECUTE FUNCTION public.org_delegation_guard();

-- Legacy delegations (rows created while the wider list was accepted). They are NEVER deleted or
-- rewritten: they stay on record and stay revocable. The application and this database treat a
-- row whose code is not delegable as INERT (it confers nothing; see loadActiveDelegations), so
-- the explicit guardian model cannot be bypassed through an old grant, and no one needs a
-- revocation policy invented for them. Each ACTIVE one is recorded once in the audit log so the
-- owner can review (and revoke) them; the migration is deterministic and a re-run adds nothing.
DO $legacy$
DECLARE
  r record;
  n integer := 0;
BEGIN
  FOR r IN
    SELECT d.id, d.tenant_id, d.organization_id, d.delegate_user_id, d.permission_code, d.granted_by
      FROM public.org_admin_school_delegations d
     WHERE d.revoked_at IS NULL AND NOT public.is_delegable_permission(d.permission_code)
     ORDER BY d.created_at, d.id
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.security_audit_events e
       WHERE e.event_type = 'rbac.org_delegation.legacy_inert' AND e.detail->>'delegationId' = r.id::text
    ) THEN
      INSERT INTO public.security_audit_events (event_type, actor_user_id, tenant_id, detail)
      VALUES ('rbac.org_delegation.legacy_inert', NULL, r.tenant_id,
              pg_catalog.jsonb_build_object(
                'delegationId', r.id, 'organizationId', r.organization_id,
                'delegateUserId', r.delegate_user_id, 'permissionCode', r.permission_code,
                'originalGrantor', r.granted_by,
                'note', 'Code is not approved for delegation; the grant is inert and revocable'));
      n := n + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'legacy org-admin delegations made inert and recorded: %', n;
END
$legacy$;

-- ---------------------------------------------------------------------------
-- 2. Explicit per-person guardian access (FIG-1614, Option D, owner-approved)
-- ---------------------------------------------------------------------------
-- A person in the school office holds resource.guardian.read and/or resource.guardian.write only
-- through an explicit, individually revocable grant made by a school administrator. area.people
-- implies neither. The grant is school-wide (guardian contact records are not learner-scoped in
-- this API); it never crosses a school.
INSERT INTO permissions (code, description) VALUES
  ('rbac.guardian_access.manage', 'Grant or revoke explicit per-person guardian read/write access')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'rbac.guardian_access.manage'),
  ('super_admin', 'rbac.guardian_access.manage')
ON CONFLICT (role, permission_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.staff_resource_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants (id),
  user_id uuid NOT NULL REFERENCES public.users (id),
  permission_code text NOT NULL
    CHECK (permission_code IN ('resource.guardian.read', 'resource.guardian.write')),
  granted_by uuid NOT NULL REFERENCES public.users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES public.users (id),
  revoke_reason text
);

CREATE UNIQUE INDEX IF NOT EXISTS staff_resource_grants_active_uq
  ON public.staff_resource_grants (tenant_id, user_id, permission_code)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS staff_resource_grants_user_idx
  ON public.staff_resource_grants (tenant_id, user_id) WHERE revoked_at IS NULL;

ALTER TABLE public.staff_resource_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_resource_grants FORCE ROW LEVEL SECURITY;

CREATE POLICY staff_resource_grants_tenant ON public.staff_resource_grants
  FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY staff_resource_grants_owner ON public.staff_resource_grants
  FOR ALL TO PUBLIC
  USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'staff_resource_grants'
  ))
  WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'staff_resource_grants'
  ));

-- INSERT and SELECT as a table; UPDATE only on the revocation columns, so no statement run as the
-- runtime role can change who holds a grant, which code it carries or who granted it.
GRANT SELECT, INSERT ON public.staff_resource_grants TO figbloom_app;
GRANT UPDATE (revoked_at, revoked_by, revoke_reason) ON public.staff_resource_grants TO figbloom_app;

-- Eligibility, enforced where it cannot be raced: the grantee must be an ACTIVE user with a live
-- teacher/staff membership in THIS school. Parents, students and drivers can never hold it.
CREATE OR REPLACE FUNCTION public.staff_resource_grants_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_role text;
  v_status text;
BEGIN
  SELECT m.role INTO v_role
    FROM public.school_memberships m
   WHERE m.user_id = NEW.user_id AND m.tenant_id = NEW.tenant_id AND m.archived_at IS NULL
   FOR SHARE;
  IF v_role IS NULL OR v_role NOT IN ('teacher', 'staff') THEN
    RAISE EXCEPTION 'grantee_not_eligible' USING ERRCODE = '55000';
  END IF;
  SELECT u.status INTO v_status FROM public.users u WHERE u.id = NEW.user_id FOR SHARE;
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'grantee_not_active' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.staff_resource_grants_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS staff_resource_grants_guard ON public.staff_resource_grants;
CREATE TRIGGER staff_resource_grants_guard
  BEFORE INSERT ON public.staff_resource_grants
  FOR EACH ROW EXECUTE FUNCTION public.staff_resource_grants_guard();

-- A membership that is archived, deleted, or whose role changes can no longer carry guardian
-- grants. They are revoked (not left dormant), so restoring or recreating the membership cannot
-- bring them back: explicit re-grant required (same rule as staff_area_grants, migration 004).
-- The audit actor is the user in app.user_id when the change came through the API, else NULL;
-- the person whose grants were revoked is always in detail.
CREATE OR REPLACE FUNCTION public.staff_resource_grants_on_membership_change() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_codes text[];
  v_reason text;
  v_user uuid;
  v_tenant uuid;
  v_membership uuid;
  v_actor uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_reason := 'membership_deleted'; v_user := OLD.user_id; v_tenant := OLD.tenant_id; v_membership := OLD.id;
  ELSIF NEW.archived_at IS NOT NULL AND (OLD.archived_at IS NULL OR OLD.archived_at IS DISTINCT FROM NEW.archived_at) THEN
    v_reason := 'membership_archived'; v_user := NEW.user_id; v_tenant := NEW.tenant_id; v_membership := NEW.id;
  ELSIF NEW.role IS DISTINCT FROM OLD.role THEN
    v_reason := 'role_changed'; v_user := NEW.user_id; v_tenant := NEW.tenant_id; v_membership := NEW.id;
  ELSE
    RETURN NEW;
  END IF;

  WITH revoked AS (
    UPDATE public.staff_resource_grants g
       SET revoked_at = pg_catalog.now(), revoke_reason = v_reason
     WHERE g.user_id = v_user AND g.tenant_id = v_tenant AND g.revoked_at IS NULL
    RETURNING g.permission_code
  )
  SELECT COALESCE(pg_catalog.array_agg(permission_code ORDER BY permission_code), ARRAY[]::text[])
    INTO v_codes FROM revoked;

  IF pg_catalog.cardinality(v_codes) > 0 THEN
    BEGIN
      v_actor := NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid;
    EXCEPTION WHEN others THEN
      v_actor := NULL;
    END;
    INSERT INTO public.security_audit_events (event_type, actor_user_id, tenant_id, detail)
    VALUES ('rbac.guardian_access.revoked', v_actor, v_tenant,
            pg_catalog.jsonb_build_object(
              'operation', 'revoke', 'outcome', 'revoked', 'reason', v_reason,
              'targetUserId', v_user, 'permissionCodes', pg_catalog.to_jsonb(v_codes),
              'membershipId', v_membership));
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.staff_resource_grants_on_membership_change() FROM PUBLIC;

DROP TRIGGER IF EXISTS school_memberships_archive_revokes_resource_grants ON public.school_memberships;
DROP TRIGGER IF EXISTS school_memberships_change_revokes_resource_grants ON public.school_memberships;
CREATE TRIGGER school_memberships_change_revokes_resource_grants
  AFTER UPDATE OF archived_at, role ON public.school_memberships
  FOR EACH ROW EXECUTE FUNCTION public.staff_resource_grants_on_membership_change();
DROP TRIGGER IF EXISTS school_memberships_delete_revokes_resource_grants ON public.school_memberships;
CREATE TRIGGER school_memberships_delete_revokes_resource_grants
  BEFORE DELETE ON public.school_memberships
  FOR EACH ROW EXECUTE FUNCTION public.staff_resource_grants_on_membership_change();

-- ---------------------------------------------------------------------------
-- 3. UPDATE hardening (independent review M-1)
-- ---------------------------------------------------------------------------
-- The INSERT guards above are not enough if the runtime role may UPDATE the protected columns.
-- (a) Column-level UPDATE: only the revocation columns. (b) Immutability triggers, for every role:
-- identity, code and grantor never change, and a revocation is final (revoked_at never returns to
-- NULL). A re-grant is a NEW row, which passes through the INSERT guard again.
REVOKE UPDATE ON public.org_admin_school_delegations FROM figbloom_app;
GRANT UPDATE (revoked_at, revoked_by) ON public.org_admin_school_delegations TO figbloom_app;

CREATE OR REPLACE FUNCTION public.org_delegation_immutable_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.delegate_user_id IS DISTINCT FROM OLD.delegate_user_id
     OR NEW.permission_code IS DISTINCT FROM OLD.permission_code OR NEW.granted_by IS DISTINCT FROM OLD.granted_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'delegation_immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by) THEN
    RAISE EXCEPTION 'revocation_is_final' USING ERRCODE = '55000';
  END IF;
  -- A revocation is one atomic fact: both columns together, and never dated in the future
  -- (an active row cannot carry a half-written or falsified revocation).
  IF OLD.revoked_at IS NULL AND (
       (NEW.revoked_at IS NULL) <> (NEW.revoked_by IS NULL)
       OR NEW.revoked_at > pg_catalog.clock_timestamp()) THEN
    RAISE EXCEPTION 'revocation_incomplete' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.org_delegation_immutable_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS org_admin_school_delegations_immutable ON public.org_admin_school_delegations;
CREATE TRIGGER org_admin_school_delegations_immutable
  BEFORE UPDATE ON public.org_admin_school_delegations
  FOR EACH ROW EXECUTE FUNCTION public.org_delegation_immutable_guard();

CREATE OR REPLACE FUNCTION public.staff_resource_grants_immutable_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.permission_code IS DISTINCT FROM OLD.permission_code
     OR NEW.granted_by IS DISTINCT FROM OLD.granted_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'grant_immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
    RAISE EXCEPTION 'revocation_is_final' USING ERRCODE = '55000';
  END IF;
  -- revoked_by / revoke_reason only accompany a revocation date, which is never in the future.
  IF OLD.revoked_at IS NULL AND (
       (NEW.revoked_at IS NULL AND (NEW.revoked_by IS NOT NULL OR NEW.revoke_reason IS NOT NULL))
       OR NEW.revoked_at > pg_catalog.clock_timestamp()) THEN
    RAISE EXCEPTION 'revocation_incomplete' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.staff_resource_grants_immutable_guard() FROM PUBLIC;
DROP TRIGGER IF EXISTS staff_resource_grants_immutable ON public.staff_resource_grants;
CREATE TRIGGER staff_resource_grants_immutable
  BEFORE UPDATE ON public.staff_resource_grants
  FOR EACH ROW EXECUTE FUNCTION public.staff_resource_grants_immutable_guard();
