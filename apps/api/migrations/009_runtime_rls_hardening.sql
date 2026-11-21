-- FIG-1605 / AD-2 / AD-4 — runtime RLS hardening.
-- Forward-only. Migrations 001–008 are not edited.
--
-- Removes application-controlled bypass/owner mode policies.
-- Tenant policies are explicit, permissive, and default-deny:
--   tenant_id = app_current_tenant_id()
--   missing, empty, or malformed GUCs yield NULL and match no rows.
--
-- The only non-tenant path is a positive owner policy: current_user must be
-- the table owner (pg_class.relowner). It is not an application bypass.
-- FORCE stays on, so an accidental connection as the owner is still constrained
-- by that policy. The migrator and SECURITY DEFINER triggers keep working
-- because they run as the owner. Any other role, including a future worker
-- or a probe role that merely holds SELECT, sees zero rows.
--
-- school_memberships (AD-4):
--   * tenant policy — rows in the authorised tenant (staff administration
--     reads another member's role). Writes are not granted.
--   * self-read SELECT — user_id = app_current_user_id() AND no tenant GUC.
--     Used for "my memberships", /auth/me, and select-tenant.
--   * login-by-login-id sets the request tenant UUID as a scoping key with no
--     user id. That is not an authorisation claim; the password still decides.
--     While that short transaction is open the tenant policy can see membership
--     rows in that tenant. The statement filters by login_id.
-- Archived memberships are invisible to figbloom_app.

-- ---------------------------------------------------------------------------
-- Tenant policies (no mode GUC) and positive owner policies
-- ---------------------------------------------------------------------------
DO $policies$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'staff_area_grants',
    'school_role_assignments',
    'school_roles',
    'org_admin_school_delegations',
    'learners',
    'guardians',
    'guardian_links'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_isolation', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_owner', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO figbloom_app '
      || 'USING (tenant_id = app_current_tenant_id()) '
      || 'WITH CHECK (tenant_id = app_current_tenant_id())',
      t || '_tenant',
      t
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO PUBLIC '
      || 'USING (current_user = ('
      || '  SELECT pg_get_userbyid(c.relowner) FROM pg_class c '
      || '  JOIN pg_namespace n ON n.oid = c.relnamespace '
      || '  WHERE n.nspname = ''public'' AND c.relname = %L)) '
      || 'WITH CHECK (current_user = ('
      || '  SELECT pg_get_userbyid(c.relowner) FROM pg_class c '
      || '  JOIN pg_namespace n ON n.oid = c.relnamespace '
      || '  WHERE n.nspname = ''public'' AND c.relname = %L))',
      t || '_owner',
      t,
      t,
      t
    );
  END LOOP;
END
$policies$;

-- ---------------------------------------------------------------------------
-- school_memberships: self-read plus same-tenant read. No write grant.
-- ---------------------------------------------------------------------------
ALTER TABLE school_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE school_memberships FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS school_memberships_tenant ON school_memberships;
CREATE POLICY school_memberships_tenant ON school_memberships
  FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id() AND archived_at IS NULL)
  WITH CHECK (tenant_id = app_current_tenant_id() AND archived_at IS NULL);

DROP POLICY IF EXISTS school_memberships_self_read ON school_memberships;
CREATE POLICY school_memberships_self_read ON school_memberships
  FOR SELECT TO figbloom_app
  USING (
    user_id = app_current_user_id()
    AND app_current_tenant_id() IS NULL
    AND archived_at IS NULL
  );

DROP POLICY IF EXISTS school_memberships_owner ON school_memberships;
CREATE POLICY school_memberships_owner ON school_memberships
  FOR ALL TO PUBLIC
  USING (current_user = (
    SELECT pg_get_userbyid(c.relowner)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'school_memberships'
  ))
  WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner)
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'school_memberships'
  ));

-- ---------------------------------------------------------------------------
-- Grants derived from the application code audit.
-- security_audit_events is INSERT-only: the API never reads it.
-- schema_migrations and the checksum audit stay migrator-only.
-- ---------------------------------------------------------------------------
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM figbloom_app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM figbloom_app;

GRANT SELECT ON
  organizations,
  tenants,
  platform_roles,
  organization_memberships,
  permissions,
  role_permissions,
  school_memberships,
  school_roles,
  school_role_assignments
TO figbloom_app;

GRANT SELECT, UPDATE ON users TO figbloom_app;
GRANT SELECT, INSERT, UPDATE ON sessions TO figbloom_app;
GRANT SELECT, INSERT, UPDATE ON auth_rate_buckets TO figbloom_app;
GRANT SELECT, INSERT, UPDATE ON external_identities TO figbloom_app;
GRANT INSERT ON external_identity_link_events TO figbloom_app;

GRANT SELECT, INSERT, DELETE ON staff_area_grants TO figbloom_app;
GRANT SELECT, INSERT, UPDATE ON org_admin_school_delegations TO figbloom_app;
GRANT SELECT, INSERT ON learners TO figbloom_app;
GRANT SELECT, INSERT ON guardians TO figbloom_app;
GRANT SELECT, INSERT ON guardian_links TO figbloom_app;
GRANT INSERT ON security_audit_events TO figbloom_app;

-- No SELECT on security_audit_events. No DML on migration history.
REVOKE ALL ON TABLE security_audit_events FROM figbloom_app;
GRANT INSERT ON security_audit_events TO figbloom_app;
REVOKE ALL ON TABLE schema_migrations FROM figbloom_app;
REVOKE ALL ON TABLE schema_migration_checksum_audit FROM figbloom_app;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM figbloom_app;
GRANT USAGE ON SCHEMA public TO figbloom_app;

-- EXECUTE only for functions the API calls or that policies evaluate.
-- prune_rate_buckets is not an API call. Trigger functions stay revoked from PUBLIC.
REVOKE ALL ON FUNCTION prune_rate_buckets(interval) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION consume_rate_token(text, numeric, numeric, numeric, integer) TO figbloom_app;
GRANT EXECUTE ON FUNCTION app_current_tenant_id() TO figbloom_app;
GRANT EXECUTE ON FUNCTION app_current_user_id() TO figbloom_app;

-- TEMPORARY on the database is a cluster privilege. A managed RDS migrator
-- may not be allowed to revoke it. Tests must not depend on this succeeding.
DO $temp$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM figbloom_app', current_database());
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'TEMPORARY revoke skipped (insufficient privilege)';
END
$temp$;
