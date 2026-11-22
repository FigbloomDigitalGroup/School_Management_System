-- FIG-1573 closure programme (WS1/WS6/WS7/WS8)
-- Forward-only. Does not modify 001–003 bodies.
-- Runtime role separation, auditable membership archive, external identity
-- mapping, hybrid tenant isolation (RLS on authz tables + session context).

-- ---------------------------------------------------------------------------
-- Runtime application role (non-owner). Production DATABASE_URL should use
-- figbloom_app. Local tests SET ROLE for privilege checks (docs/DB-ROLES.md).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'figbloom_app') THEN
    CREATE ROLE figbloom_app NOINHERIT;
  END IF;
END
$$;

GRANT figbloom_app TO CURRENT_USER;

-- ---------------------------------------------------------------------------
-- Migration history columns (R2-09 runner also uses advisory lock + checksum)
-- ---------------------------------------------------------------------------
ALTER TABLE schema_migrations
  ADD COLUMN IF NOT EXISTS checksum text,
  ADD COLUMN IF NOT EXISTS applied_by text NOT NULL DEFAULT CURRENT_USER;

-- ---------------------------------------------------------------------------
-- Append-only audit privilege boundary (R2-04 / AUD-08 / R3-07)
-- Trust boundary: PostgreSQL superusers and table owners can still disable
-- triggers — not claimed as superuser-proof.
-- ---------------------------------------------------------------------------
REVOKE ALL ON TABLE security_audit_events FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE security_audit_events TO figbloom_app;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE security_audit_events FROM figbloom_app;

-- Replace 002 guard with SECURITY DEFINER equivalent (same FK null-out rule).
CREATE OR REPLACE FUNCTION security_audit_events_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND ROW(NEW.id, NEW.occurred_at, NEW.event_type, NEW.detail, NEW.ip)
         IS NOT DISTINCT FROM ROW(OLD.id, OLD.occurred_at, OLD.event_type, OLD.detail, OLD.ip)
     AND (NEW.actor_user_id IS NULL OR NEW.actor_user_id = OLD.actor_user_id)
     AND (NEW.tenant_id IS NULL OR NEW.tenant_id = OLD.tenant_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'security_audit_events is append-only' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS security_audit_events_append_only ON security_audit_events;
CREATE TRIGGER security_audit_events_append_only
  BEFORE UPDATE OR DELETE ON security_audit_events
  FOR EACH ROW EXECUTE FUNCTION security_audit_events_guard();

-- ---------------------------------------------------------------------------
-- Membership archival lifecycle (R3-01)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION school_memberships_on_archive() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_areas text[];
  v_role_ids uuid[];
BEGIN
  IF NEW.archived_at IS NOT NULL
     AND (OLD.archived_at IS NULL OR OLD.archived_at IS DISTINCT FROM NEW.archived_at) THEN
    SELECT COALESCE(array_agg(area ORDER BY area), ARRAY[]::text[])
      INTO v_areas
      FROM staff_area_grants
     WHERE user_id = NEW.user_id AND tenant_id = NEW.tenant_id;

    SELECT COALESCE(array_agg(role_id), ARRAY[]::uuid[])
      INTO v_role_ids
      FROM school_role_assignments
     WHERE user_id = NEW.user_id AND tenant_id = NEW.tenant_id;

    DELETE FROM staff_area_grants
     WHERE user_id = NEW.user_id AND tenant_id = NEW.tenant_id;
    DELETE FROM school_role_assignments
     WHERE user_id = NEW.user_id AND tenant_id = NEW.tenant_id;

    INSERT INTO security_audit_events (event_type, actor_user_id, tenant_id, detail)
    VALUES (
      'membership.archived.authz_revoked',
      NEW.user_id,
      NEW.tenant_id,
      jsonb_build_object(
        'membershipId', NEW.id,
        'revokedAreas', to_jsonb(v_areas),
        'revokedRoleAssignmentIds', to_jsonb(v_role_ids),
        'note', 'Restoring membership does not restore these grants; explicit re-grant required'
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS school_memberships_archive_clears_authz ON school_memberships;
CREATE TRIGGER school_memberships_archive_clears_authz
  AFTER UPDATE OF archived_at ON school_memberships
  FOR EACH ROW EXECUTE FUNCTION school_memberships_on_archive();

-- ---------------------------------------------------------------------------
-- External identity linking (D-14)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS external_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('supabase_auth')),
  subject text NOT NULL,
  email_at_link text,
  linked_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'pending_verification')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (provider, subject)
);

CREATE UNIQUE INDEX IF NOT EXISTS external_identities_one_active_supabase
  ON external_identities (user_id)
  WHERE provider = 'supabase_auth' AND status = 'active';

CREATE TABLE IF NOT EXISTS external_identity_link_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_identity_id uuid REFERENCES external_identities(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Hybrid tenant isolation (D-3)
-- Decision: hybrid — (1) mandatory tenant-scoped application access,
-- (2) RLS on authorization tables for figbloom_app,
-- (3) FORCE RLS so the app role cannot bypass,
-- (4) identity bootstrap tables stay app-layer filtered (login lists all
--     memberships; sessions looked up by token hash) — learner tables in
--     Phase 3 must ship with RLS+FORCE from day one.
-- Context: SET LOCAL app.tenant_id / app.user_id / app.authz_mode.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_current_tenant_id() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE v text;
BEGIN
  v := current_setting('app.tenant_id', true);
  IF v IS NULL OR btrim(v) = '' THEN RETURN NULL; END IF;
  RETURN v::uuid;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE v text;
BEGIN
  v := current_setting('app.user_id', true);
  IF v IS NULL OR btrim(v) = '' THEN RETURN NULL; END IF;
  RETURN v::uuid;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END;
$$;

-- Authorization grant tables: tenant-scoped for app role.
ALTER TABLE staff_area_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_area_grants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS staff_area_grants_isolation ON staff_area_grants;
CREATE POLICY staff_area_grants_isolation ON staff_area_grants
  FOR ALL TO figbloom_app
  USING (
    current_setting('app.authz_mode', true) = 'bypass'
    OR tenant_id = app_current_tenant_id()
  )
  WITH CHECK (
    current_setting('app.authz_mode', true) = 'bypass'
    OR tenant_id = app_current_tenant_id()
  );

ALTER TABLE school_role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_role_assignments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS school_role_assignments_isolation ON school_role_assignments;
CREATE POLICY school_role_assignments_isolation ON school_role_assignments
  FOR ALL TO figbloom_app
  USING (
    current_setting('app.authz_mode', true) = 'bypass'
    OR tenant_id = app_current_tenant_id()
  )
  WITH CHECK (
    current_setting('app.authz_mode', true) = 'bypass'
    OR tenant_id = app_current_tenant_id()
  );

ALTER TABLE school_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS school_roles_isolation ON school_roles;
CREATE POLICY school_roles_isolation ON school_roles
  FOR ALL TO figbloom_app
  USING (
    current_setting('app.authz_mode', true) = 'bypass'
    OR tenant_id = app_current_tenant_id()
  )
  WITH CHECK (
    current_setting('app.authz_mode', true) = 'bypass'
    OR tenant_id = app_current_tenant_id()
  );

-- Owner/migrator is not figbloom_app — without FORCE affecting owner via
-- role-targeted policies: FORCE applies to all roles, and policies TO
-- figbloom_app leave other roles with default-deny under FORCE.
-- Mitigate: permissive policy for table owners (CURRENT_USER at migrate time
-- is typically postgres) via BYPASS using a dedicated setting only the
-- migrator uses, plus a policy for PUBLIC when authz_mode=owner.
DROP POLICY IF EXISTS staff_area_grants_owner ON staff_area_grants;
CREATE POLICY staff_area_grants_owner ON staff_area_grants
  FOR ALL TO PUBLIC
  USING (current_setting('app.authz_mode', true) = 'owner' OR current_user <> 'figbloom_app')
  WITH CHECK (current_setting('app.authz_mode', true) = 'owner' OR current_user <> 'figbloom_app');

DROP POLICY IF EXISTS school_role_assignments_owner ON school_role_assignments;
CREATE POLICY school_role_assignments_owner ON school_role_assignments
  FOR ALL TO PUBLIC
  USING (current_setting('app.authz_mode', true) = 'owner' OR current_user <> 'figbloom_app')
  WITH CHECK (current_setting('app.authz_mode', true) = 'owner' OR current_user <> 'figbloom_app');

DROP POLICY IF EXISTS school_roles_owner ON school_roles;
CREATE POLICY school_roles_owner ON school_roles
  FOR ALL TO PUBLIC
  USING (current_setting('app.authz_mode', true) = 'owner' OR current_user <> 'figbloom_app')
  WITH CHECK (current_setting('app.authz_mode', true) = 'owner' OR current_user <> 'figbloom_app');

-- ---------------------------------------------------------------------------
-- Privileges for figbloom_app
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO figbloom_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  organizations, tenants, users, school_memberships, platform_roles,
  organization_memberships, sessions, permissions, role_permissions,
  staff_area_grants, school_roles, school_role_assignments, auth_rate_buckets,
  external_identities, external_identity_link_events
TO figbloom_app;

GRANT SELECT, INSERT ON security_audit_events TO figbloom_app;

REVOKE ALL ON TABLE schema_migrations FROM PUBLIC;
GRANT SELECT ON TABLE schema_migrations TO figbloom_app;

GRANT EXECUTE ON FUNCTION consume_rate_token(text, numeric, numeric, numeric, integer) TO figbloom_app;
GRANT EXECUTE ON FUNCTION prune_rate_buckets(interval) TO figbloom_app;
GRANT EXECUTE ON FUNCTION app_current_tenant_id() TO figbloom_app;
GRANT EXECUTE ON FUNCTION app_current_user_id() TO figbloom_app;

REVOKE ALL ON FUNCTION security_audit_events_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION school_memberships_on_archive() FROM PUBLIC;
