-- Platform console, fix for slice P3 (apps/api/docs/PLATFORM-CONSOLE.md):
-- GET /v1/platform/schools/{schoolId}/admins read school_memberships directly on the identity path. That table has
-- forced row-level security and its only policy for the runtime role needs a school in the request (migration 009),
-- so the read saw no rows and the list was always empty. The same read as a narrow SECURITY DEFINER function for super
-- administrators, as platform_usage_counts (112) and platform_audit_events (113) do for their tables.
-- Forward-only. Active school administrators only: name, e-mail and status. The route audits every read.

CREATE FUNCTION public.platform_school_admins(
  p_school_id uuid,
  p_after_since timestamptz,
  p_after_id uuid,
  p_limit integer
)
RETURNS TABLE (
  membership_id uuid,
  since timestamptz,
  user_id uuid,
  full_name text,
  email text,
  status text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 201);
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.platform_roles pr WHERE pr.user_id = v_actor AND pr.role = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'super administrator required' USING ERRCODE = '42501';
  END IF;

  IF (p_after_since IS NULL) <> (p_after_id IS NULL) THEN
    RAISE EXCEPTION 'cursor needs both a time and an id' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    SELECT sm.id,
           sm.created_at,
           u.id,
           u.full_name,
           u.email,
           u.status
      FROM public.school_memberships sm
      JOIN public.users u ON u.id = sm.user_id
     WHERE sm.tenant_id = p_school_id
       AND sm.role = 'school_admin'
       AND sm.archived_at IS NULL
       AND (p_after_since IS NULL OR (sm.created_at, sm.id) > (p_after_since, p_after_id))
     ORDER BY sm.created_at, sm.id
     LIMIT v_limit;
END
$$;

REVOKE ALL ON FUNCTION public.platform_school_admins(uuid, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_school_admins(uuid, timestamptz, uuid, integer) TO figbloom_app;
