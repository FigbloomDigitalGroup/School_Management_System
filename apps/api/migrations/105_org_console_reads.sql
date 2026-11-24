-- S11: organisation console reads (docs/ORG-CONSOLE.md). Forward-only.
--
-- Two organisation-level READ permissions for the org_admin ROLE, and one narrow SECURITY DEFINER reader of the caller's
-- own audit events. Nothing here gives an org admin any school-level power (ORG-ADMIN-POLICY.md points 2 to 4), and no
-- table, policy or table grant changes: security_audit_events keeps no SELECT grant for figbloom_app.
--
-- Neither permission is delegable: they are not school-scoped and are not in is_delegable_permission (migration 026) or
-- DELEGABLE_PERMISSIONS (delegations.ts); the drift test compares the two over every catalogue code.

INSERT INTO permissions (code, description) VALUES
  ('org.admins.read', 'Organization: list the administrators of an organization the caller administers'),
  ('org.audit.read',  'Organization: read the caller''s own audit events in an organization the caller administers')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code) VALUES
  ('org_admin', 'org.admins.read'),
  ('org_admin', 'org.audit.read')
ON CONFLICT (role, permission_code) DO NOTHING;

-- The caller's OWN audit events that concern one organisation: events they caused in one of its schools, or whose detail
-- names the organisation (delegation grant, revoke and refusal events carry detail.organizationId).
--   * The actor is app_current_user_id(), set by the API from the verified session; there is no actor argument, so the
--     function cannot be asked about anyone else.
--   * The database re-checks that the actor is an org_admin of p_org and that the organisation is active (the API checks
--     first; this is defence in depth). Otherwise: 42501, nothing returned.
--   * Newest first, keyset on (occurred_at, id) strictly after the given cursor; at most 200 rows; the ip column is never
--     returned.
CREATE FUNCTION public.org_my_audit_events(p_org uuid, p_before_at timestamptz, p_before_id uuid, p_limit integer)
RETURNS TABLE (id uuid, occurred_at_text text, event_type text, tenant_id uuid, tenant_name text, detail jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 201);
BEGIN
  IF v_actor IS NULL OR p_org IS NULL OR NOT EXISTS (
      SELECT 1
        FROM public.organization_memberships om
        JOIN public.organizations o ON o.id = om.organization_id
       WHERE om.user_id = v_actor AND om.organization_id = p_org AND om.role = 'org_admin' AND o.status = 'active') THEN
    RAISE EXCEPTION 'not an administrator of this organization' USING ERRCODE = '42501';
  END IF;
  IF (p_before_at IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION 'cursor needs both a time and an id' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT e.id,
           to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           e.event_type,
           e.tenant_id,
           t.name,
           e.detail
      FROM public.security_audit_events e
      LEFT JOIN public.tenants t ON t.id = e.tenant_id
     WHERE e.actor_user_id = v_actor
       AND (
         (e.tenant_id IS NOT NULL AND t.organization_id = p_org)
         OR (e.detail ->> 'organizationId') = p_org::text
       )
       AND (p_before_at IS NULL
            OR e.occurred_at < p_before_at
            OR (e.occurred_at = p_before_at AND e.id > p_before_id))
     ORDER BY e.occurred_at DESC, e.id
     LIMIT v_limit;
END
$$;
REVOKE ALL ON FUNCTION public.org_my_audit_events(uuid, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.org_my_audit_events(uuid, timestamptz, uuid, integer) TO figbloom_app;
