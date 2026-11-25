-- Platform console slice P5 (apps/api/docs/PLATFORM-CONSOLE.md):
-- Platform-wide audit trail read for super administrators via a narrow SECURITY DEFINER function.
-- security_audit_events keeps NO SELECT grant for figbloom_app; ip and detail columns are never returned.
-- Forward-only.

INSERT INTO permissions (code, description) VALUES
  ('platform.audit.read', 'Platform: read platform-wide audit events across all schools (no IP, no detail, read-audited)')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code) VALUES
  ('super_admin', 'platform.audit.read')
ON CONFLICT (role, permission_code) DO NOTHING;

CREATE FUNCTION public.platform_audit_events(
  p_tenant_id uuid,
  p_event_prefix text,
  p_since timestamptz,
  p_before_at timestamptz,
  p_before_id uuid,
  p_limit integer
)
RETURNS TABLE (
  id uuid,
  occurred_at_text text,
  event_type text,
  tenant_id uuid,
  tenant_name text,
  actor_user_id uuid,
  actor_name text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 201);
  v_prefix text := nullif(btrim(coalesce(p_event_prefix, '')), '');
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.platform_roles pr WHERE pr.user_id = v_actor AND pr.role = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'super administrator required' USING ERRCODE = '42501';
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
           e.actor_user_id,
           u.full_name
      FROM public.security_audit_events e
      LEFT JOIN public.tenants t ON t.id = e.tenant_id
      LEFT JOIN public.users u ON u.id = e.actor_user_id
     WHERE (p_tenant_id IS NULL OR e.tenant_id = p_tenant_id)
       AND (v_prefix IS NULL OR left(e.event_type, char_length(v_prefix)) = v_prefix)
       AND (p_since IS NULL OR e.occurred_at >= p_since)
       AND (p_before_at IS NULL
            OR e.occurred_at < p_before_at
            OR (e.occurred_at = p_before_at AND e.id > p_before_id))
     ORDER BY e.occurred_at DESC, e.id
     LIMIT v_limit;
END
$$;

REVOKE ALL ON FUNCTION public.platform_audit_events(uuid, text, timestamptz, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_audit_events(uuid, text, timestamptz, timestamptz, uuid, integer) TO figbloom_app;
