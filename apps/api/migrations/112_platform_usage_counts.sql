-- Platform console slice P4 (apps/api/docs/PLATFORM-CONSOLE.md):
-- Counts-only cross-school usage summary for super administrators. No names, no IDs of people.
-- Forward-only.

INSERT INTO permissions (code, description) VALUES
  ('platform.usage.read', 'Platform: read per-school active learner, staff, and guardian link counts (no PII)')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code) VALUES
  ('super_admin', 'platform.usage.read')
ON CONFLICT (role, permission_code) DO NOTHING;

CREATE FUNCTION public.platform_usage_counts()
RETURNS TABLE (
  tenant_id uuid,
  tenant_name text,
  tenant_slug text,
  tenant_status text,
  active_learners integer,
  active_staff_memberships integer,
  active_guardian_links integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.platform_roles pr WHERE pr.user_id = v_actor AND pr.role = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'super administrator required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT t.id,
           t.name,
           t.slug,
           t.status,
           (SELECT count(*)::integer
              FROM public.learners l
             WHERE l.tenant_id = t.id AND l.active = true) AS active_learners,
           (SELECT count(*)::integer
              FROM public.school_memberships sm
             WHERE sm.tenant_id = t.id
               AND sm.archived_at IS NULL
               AND sm.role IN ('school_admin', 'teacher', 'driver', 'staff')) AS active_staff_memberships,
           (SELECT count(*)::integer
              FROM public.guardian_links gl
              JOIN public.learners l ON l.id = gl.learner_id AND l.tenant_id = gl.tenant_id
             WHERE gl.tenant_id = t.id AND l.active = true) AS active_guardian_links
      FROM public.tenants t
     ORDER BY t.name COLLATE "C", t.id;
END
$$;

REVOKE ALL ON FUNCTION public.platform_usage_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_usage_counts() TO figbloom_app;
