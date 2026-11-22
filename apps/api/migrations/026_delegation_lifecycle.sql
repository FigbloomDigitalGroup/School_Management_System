-- FIG-1609 / FIG-1614 delegation lifecycle (owner decisions, 2026-11-17). Forward-only; 001-025 untouched.
--
-- A. A material change to the authorization relationship INVALIDATES the affected grants. They are
--    revoked (final, audited), not left dormant, so restoring the user, the membership or the
--    organization can never bring them back: a fresh grant is required.
--      * user disabled (active -> anything else)          : org delegations AND guardian grants of that user
--      * org membership removed / moved / role changed     : that person's delegations in that organization
--      * organization leaves 'active'                      : every delegation in that organization
--      * school membership moved to another user / school  : guardian grants (025 already handles archive,
--                                                            role change and delete)
--    School SUSPENSION is deliberately NOT here. It stays temporary: grants cannot be exercised, may be
--    revoked, and resume on restoration if they remain valid (loaders filter on tenants.status).
--    These state changes are made outside the API (administration, sync, migrations), so the
--    enforcement lives in the database. Triggers fire only on a real transition, revoke only ACTIVE
--    rows and audit only what they revoked, so repeats and replays add nothing.
-- B. Delegations that are dormant TODAY (recipient already disabled, org membership gone, organization
--    not active; guardian grants without a live teacher/staff membership or an active user) are
--    revoked once here, so a later restoration cannot revive them. Each is audited.
-- C. area.people leaves the grantable set (owner decision): it carries learner, staff and document
--    writes. Existing active area.people delegations are NOT revoked (no silent loss of access);
--    they keep working, can still be revoked, and are recorded once for owner review.
-- Contract (docs/SECURITY-DEFINER-INVENTORY.md): owner = migrator, search_path = pg_catalog, pg_temp,
-- every reference schema-qualified, EXECUTE revoked from PUBLIC.

-- ---------------------------------------------------------------------------
-- 1. Revocation reason on delegations (the application role gets NO privilege on it)
-- ---------------------------------------------------------------------------
ALTER TABLE public.org_admin_school_delegations ADD COLUMN IF NOT EXISTS revoke_reason text;

-- A revocation is one atomic fact. By an administrator: revoked_at AND revoked_by. By the system (a
-- lifecycle trigger): revoked_at AND a reason, no actor. The runtime role cannot write revoke_reason
-- (column privileges are unchanged), so it can never record an unattributed revocation.
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
     OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by OR NEW.revoke_reason IS DISTINCT FROM OLD.revoke_reason) THEN
    RAISE EXCEPTION 'revocation_is_final' USING ERRCODE = '55000';
  END IF;
  IF OLD.revoked_at IS NULL AND (
       (NEW.revoked_at IS NULL AND (NEW.revoked_by IS NOT NULL OR NEW.revoke_reason IS NOT NULL))
       OR (NEW.revoked_at IS NOT NULL AND NEW.revoked_by IS NULL AND NEW.revoke_reason IS NULL)
       OR NEW.revoked_at > pg_catalog.clock_timestamp()) THEN
    RAISE EXCEPTION 'revocation_incomplete' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.org_delegation_immutable_guard() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 2. Invalidation helpers (internal; not callable by the runtime role)
-- ---------------------------------------------------------------------------
-- Revoke the ACTIVE delegations of one user and/or one organization, one audit event per school.
CREATE OR REPLACE FUNCTION public.invalidate_org_delegations(p_user uuid, p_org uuid, p_reason text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  r record;
  v_actor uuid;
  v_n integer := 0;
BEGIN
  IF p_user IS NULL AND p_org IS NULL THEN
    RAISE EXCEPTION 'invalidate_org_delegations needs a user or an organization' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_actor := NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  EXCEPTION WHEN others THEN
    v_actor := NULL;
  END;
  FOR r IN
    WITH revoked AS (
      UPDATE public.org_admin_school_delegations d
         SET revoked_at = pg_catalog.now(), revoke_reason = p_reason
       WHERE d.revoked_at IS NULL
         AND (p_user IS NULL OR d.delegate_user_id = p_user)
         AND (p_org IS NULL OR d.organization_id = p_org)
      RETURNING d.tenant_id, d.organization_id, d.delegate_user_id, d.permission_code, d.granted_by
    )
    SELECT tenant_id, organization_id, delegate_user_id,
           pg_catalog.array_agg(permission_code ORDER BY permission_code) AS codes,
           pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('permissionCode', permission_code, 'grantedBy', granted_by)
                                ORDER BY permission_code) AS grantors
      FROM revoked
     GROUP BY tenant_id, organization_id, delegate_user_id
     ORDER BY tenant_id, delegate_user_id
  LOOP
    BEGIN
      INSERT INTO public.security_audit_events (event_type, actor_user_id, tenant_id, detail)
      VALUES ('rbac.org_delegation.revoked', v_actor, r.tenant_id,
              pg_catalog.jsonb_build_object(
                'operation', 'revoke', 'outcome', 'invalidated', 'reason', p_reason, 'actingVia', 'system',
                'delegateUserId', r.delegate_user_id, 'organizationId', r.organization_id,
                'permissionCodes', pg_catalog.to_jsonb(r.codes), 'originalGrantors', r.grantors));
    EXCEPTION WHEN foreign_key_violation THEN
      -- The school or the acting user is being deleted in the same statement: keep the event.
      INSERT INTO public.security_audit_events (event_type, actor_user_id, tenant_id, detail)
      VALUES ('rbac.org_delegation.revoked', NULL, NULL,
              pg_catalog.jsonb_build_object(
                'operation', 'revoke', 'outcome', 'invalidated', 'reason', p_reason, 'actingVia', 'system',
                'delegateUserId', r.delegate_user_id, 'organizationId', r.organization_id,
                'permissionCodes', pg_catalog.to_jsonb(r.codes), 'originalGrantors', r.grantors));
    END;
    v_n := v_n + pg_catalog.cardinality(r.codes);
  END LOOP;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.invalidate_org_delegations(uuid, uuid, text) FROM PUBLIC;

-- Revoke the ACTIVE explicit guardian grants of one user, in one school or in every school.
CREATE OR REPLACE FUNCTION public.invalidate_guardian_grants(p_user uuid, p_tenant uuid, p_reason text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  r record;
  v_actor uuid;
  v_n integer := 0;
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'invalidate_guardian_grants needs a user' USING ERRCODE = '22023';
  END IF;
  BEGIN
    v_actor := NULLIF(pg_catalog.current_setting('app.user_id', true), '')::uuid;
  EXCEPTION WHEN others THEN
    v_actor := NULL;
  END;
  FOR r IN
    WITH revoked AS (
      UPDATE public.staff_resource_grants g
         SET revoked_at = pg_catalog.now(), revoke_reason = p_reason
       WHERE g.user_id = p_user AND g.revoked_at IS NULL
         AND (p_tenant IS NULL OR g.tenant_id = p_tenant)
      RETURNING g.tenant_id, g.permission_code, g.granted_by
    )
    SELECT tenant_id,
           pg_catalog.array_agg(permission_code ORDER BY permission_code) AS codes,
           pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('permissionCode', permission_code, 'grantedBy', granted_by)
                                ORDER BY permission_code) AS grantors
      FROM revoked
     GROUP BY tenant_id
     ORDER BY tenant_id
  LOOP
    BEGIN
      INSERT INTO public.security_audit_events (event_type, actor_user_id, tenant_id, detail)
      VALUES ('rbac.guardian_access.revoked', v_actor, r.tenant_id,
              pg_catalog.jsonb_build_object(
                'operation', 'revoke', 'outcome', 'invalidated', 'reason', p_reason, 'actingVia', 'system',
                'targetUserId', p_user, 'permissionCodes', pg_catalog.to_jsonb(r.codes), 'originalGrantors', r.grantors));
    EXCEPTION WHEN foreign_key_violation THEN
      INSERT INTO public.security_audit_events (event_type, actor_user_id, tenant_id, detail)
      VALUES ('rbac.guardian_access.revoked', NULL, NULL,
              pg_catalog.jsonb_build_object(
                'operation', 'revoke', 'outcome', 'invalidated', 'reason', p_reason, 'actingVia', 'system',
                'targetUserId', p_user, 'permissionCodes', pg_catalog.to_jsonb(r.codes), 'originalGrantors', r.grantors));
    END;
    v_n := v_n + pg_catalog.cardinality(r.codes);
  END LOOP;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.invalidate_guardian_grants(uuid, uuid, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 3. Triggers
-- ---------------------------------------------------------------------------
-- User disabled: every delegation and every guardian grant of that user, in every school.
CREATE OR REPLACE FUNCTION public.users_status_invalidates_grants() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.invalidate_org_delegations(NEW.id, NULL, 'user_disabled');
  PERFORM public.invalidate_guardian_grants(NEW.id, NULL, 'user_disabled');
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.users_status_invalidates_grants() FROM PUBLIC;
DROP TRIGGER IF EXISTS users_status_invalidates_grants ON public.users;
CREATE TRIGGER users_status_invalidates_grants
  AFTER UPDATE OF status ON public.users
  FOR EACH ROW
  WHEN (OLD.status = 'active' AND NEW.status IS DISTINCT FROM 'active')
  EXECUTE FUNCTION public.users_status_invalidates_grants();

-- Organization membership removed, moved to another user/organization, or its role changed.
CREATE OR REPLACE FUNCTION public.org_membership_invalidates_delegations() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.invalidate_org_delegations(OLD.user_id, OLD.organization_id, 'org_membership_removed');
    RETURN OLD;
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    PERFORM public.invalidate_org_delegations(OLD.user_id, OLD.organization_id, 'org_membership_transferred');
  ELSIF NEW.role IS DISTINCT FROM OLD.role THEN
    PERFORM public.invalidate_org_delegations(OLD.user_id, OLD.organization_id, 'org_membership_role_changed');
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.org_membership_invalidates_delegations() FROM PUBLIC;
DROP TRIGGER IF EXISTS org_membership_delete_invalidates_delegations ON public.organization_memberships;
CREATE TRIGGER org_membership_delete_invalidates_delegations
  AFTER DELETE ON public.organization_memberships
  FOR EACH ROW EXECUTE FUNCTION public.org_membership_invalidates_delegations();
DROP TRIGGER IF EXISTS org_membership_change_invalidates_delegations ON public.organization_memberships;
CREATE TRIGGER org_membership_change_invalidates_delegations
  AFTER UPDATE OF user_id, organization_id, role ON public.organization_memberships
  FOR EACH ROW EXECUTE FUNCTION public.org_membership_invalidates_delegations();

-- Organization leaves 'active' (suspended, rejected, pending): every delegation in it.
CREATE OR REPLACE FUNCTION public.organizations_status_invalidates_delegations() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.invalidate_org_delegations(NULL, NEW.id, 'organization_inactive');
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.organizations_status_invalidates_delegations() FROM PUBLIC;
DROP TRIGGER IF EXISTS organizations_status_invalidates_delegations ON public.organizations;
CREATE TRIGGER organizations_status_invalidates_delegations
  AFTER UPDATE OF status ON public.organizations
  FOR EACH ROW
  WHEN (OLD.status = 'active' AND NEW.status IS DISTINCT FROM 'active')
  EXECUTE FUNCTION public.organizations_status_invalidates_delegations();

-- School membership: 025 revokes guardian grants on archive, role change and delete. A membership
-- moved to another user or school (tenant_id / user_id changed) also revokes the grants it carried.
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
  ELSIF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    -- What the grants were attached to is the OLD (user, school) pair.
    v_reason := 'membership_transferred'; v_user := OLD.user_id; v_tenant := OLD.tenant_id; v_membership := OLD.id;
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
DROP TRIGGER IF EXISTS school_memberships_change_revokes_resource_grants ON public.school_memberships;
CREATE TRIGGER school_memberships_change_revokes_resource_grants
  AFTER UPDATE OF archived_at, role, tenant_id, user_id ON public.school_memberships
  FOR EACH ROW EXECUTE FUNCTION public.staff_resource_grants_on_membership_change();

-- ---------------------------------------------------------------------------
-- 4. One-time sweep of grants that are already dormant (so restoration cannot revive them)
-- ---------------------------------------------------------------------------
DO $sweep$
DECLARE
  r record;
  n_deleg integer := 0;
  n_guard integer := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT d.delegate_user_id AS user_id, d.organization_id
      FROM public.org_admin_school_delegations d
      LEFT JOIN public.users u ON u.id = d.delegate_user_id
      LEFT JOIN public.organizations o ON o.id = d.organization_id
     WHERE d.revoked_at IS NULL
       AND (u.status IS DISTINCT FROM 'active'
            OR o.status IS DISTINCT FROM 'active'
            OR NOT EXISTS (SELECT 1 FROM public.organization_memberships om
                            WHERE om.user_id = d.delegate_user_id AND om.organization_id = d.organization_id
                              AND om.role = 'org_admin'))
     ORDER BY 1, 2
  LOOP
    n_deleg := n_deleg + public.invalidate_org_delegations(r.user_id, r.organization_id, 'invalidated_at_migration');
  END LOOP;

  FOR r IN
    SELECT DISTINCT g.user_id, g.tenant_id
      FROM public.staff_resource_grants g
      LEFT JOIN public.users u ON u.id = g.user_id
     WHERE g.revoked_at IS NULL
       AND (u.status IS DISTINCT FROM 'active'
            OR NOT EXISTS (SELECT 1 FROM public.school_memberships m
                            WHERE m.user_id = g.user_id AND m.tenant_id = g.tenant_id
                              AND m.archived_at IS NULL AND m.role IN ('teacher', 'staff')))
     ORDER BY 1, 2
  LOOP
    n_guard := n_guard + public.invalidate_guardian_grants(r.user_id, r.tenant_id, 'invalidated_at_migration');
  END LOOP;
  RAISE NOTICE 'dormant delegations revoked: %, dormant guardian grants revoked: %', n_deleg, n_guard;
END
$sweep$;

-- ---------------------------------------------------------------------------
-- 5. area.people is no longer grantable by delegation
-- ---------------------------------------------------------------------------
-- Delegating it makes the People set effective (learner write, staff write, document write). The
-- owner does not approve that reach. New grants are refused by the guard below (it calls this
-- function); the TypeScript allowlist is identical. Existing ACTIVE area.people delegations keep
-- working (the loader accepts exactly that one code in addition), so no access is silently removed.
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
    'area.fees', 'area.academics', 'area.attendance', 'area.transport',
    'area.communication', 'area.inventory', 'area.activities', 'area.visitors',
    'area.medical', 'area.leave', 'area.audit'
  ]::text[]);
$$;

-- Record every existing ACTIVE area.people delegation once, for the owner's review.
INSERT INTO public.security_audit_events (event_type, actor_user_id, tenant_id, detail)
SELECT 'rbac.org_delegation.review_required', NULL, d.tenant_id,
       pg_catalog.jsonb_build_object(
         'delegationId', d.id, 'organizationId', d.organization_id, 'delegateUserId', d.delegate_user_id,
         'permissionCode', d.permission_code, 'originalGrantor', d.granted_by,
         'note', 'area.people is no longer grantable by delegation; this existing grant still works and is revocable')
  FROM public.org_admin_school_delegations d
 WHERE d.revoked_at IS NULL AND d.permission_code = 'area.people'
   AND NOT EXISTS (SELECT 1 FROM public.security_audit_events e
                    WHERE e.event_type = 'rbac.org_delegation.review_required'
                      AND e.detail->>'delegationId' = d.id::text)
 ORDER BY d.created_at, d.id;
