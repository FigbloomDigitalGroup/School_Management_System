-- Platform console slice S5, incidents (apps/api/docs/PLATFORM-CONSOLE.md section 3.4 and its "as built" addendum).
-- The owner's decision D5 (2026-11-25): keep a hand-typed incident list in the platform console. Figbloom staff declare an
-- incident and resolve it by hand; nothing writes one automatically and no school sees them, as on Supabase
-- (20260914000000_platform_ops_tables.sql: platform_incidents, super_admin only).
--
--   * platform_incidents has NO tenant_id: an incident is Figbloom's own record, not school data.
--   * Owner-only, as finance_unmatched_cases (074): forced row-level security whose only policy is for the table owner, and
--     no privilege at all for figbloom_app or figbloom_worker. The runtime role reaches the rows only through the three
--     SECURITY DEFINER functions below, and each re-checks that the acting user (app.user_id) is a super administrator.
--   * Declaring and resolving write their security_audit_events row in the same transaction (platform.incident.declared,
--     platform.incident.resolved). The detail carries ids, the severity and counts, never the title or summary text.
--   * Resolving twice changes nothing the second time (no new time, no second audit row), where Supabase overwrote
--     resolved_at with the browser's clock. Nothing is ever deleted.
-- Forward-only.

INSERT INTO permissions (code, description) VALUES
  ('platform.incidents.manage', 'Platform: list, declare and resolve the hand-typed platform incident list (no school data)')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code) VALUES
  ('super_admin', 'platform.incidents.manage')
ON CONFLICT (role, permission_code) DO NOTHING;

CREATE TABLE public.platform_incidents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  severity         text NOT NULL CHECK (severity IN ('SEV-1', 'SEV-2', 'SEV-3')),
  title            text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  summary          text NOT NULL CHECK (char_length(btrim(summary)) BETWEEN 1 AND 2000),
  affected_schools integer NOT NULL DEFAULT 0 CHECK (affected_schools BETWEEN 0 AND 100000),
  -- fix_in_review is kept so the rows Supabase holds can be carried over; no route sets it (the Supabase screens never did)
  status           text NOT NULL DEFAULT 'investigating' CHECK (status IN ('investigating', 'fix_in_review', 'resolved')),
  opened_at        timestamptz NOT NULL DEFAULT now(),
  opened_by        uuid REFERENCES public.users (id) ON DELETE SET NULL,
  resolved_at      timestamptz,
  resolved_by      uuid REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT platform_incidents_resolved_chk CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  CONSTRAINT platform_incidents_resolved_order_chk CHECK (resolved_at IS NULL OR resolved_at >= opened_at)
);
CREATE INDEX platform_incidents_opened_idx ON public.platform_incidents (opened_at DESC, id);
CREATE INDEX platform_incidents_open_idx ON public.platform_incidents (opened_at DESC, id) WHERE status <> 'resolved';

ALTER TABLE public.platform_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_incidents FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_incidents_owner ON public.platform_incidents FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                          WHERE n.nspname = 'public' AND c.relname = 'platform_incidents'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                               WHERE n.nspname = 'public' AND c.relname = 'platform_incidents'));
REVOKE ALL ON public.platform_incidents FROM PUBLIC, figbloom_app, figbloom_worker;

-- ---------------------------------------------------------------------------------------------------------------------
-- List, newest first, keyset on (opened_at, id). p_id returns that one incident (no paging). p_state: NULL (all), 'open'
-- (not resolved) or 'resolved'. At most 201 rows (the route asks for limit + 1).
CREATE FUNCTION public.platform_incidents_list(
  p_id uuid,
  p_state text,
  p_before_at timestamptz,
  p_before_id uuid,
  p_limit integer
)
RETURNS TABLE (
  id uuid,
  severity text,
  title text,
  summary text,
  affected_schools integer,
  status text,
  opened_at_text text,
  opened_by uuid,
  opened_by_name text,
  resolved_at_text text,
  resolved_by uuid,
  resolved_by_name text
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
  IF p_state IS NOT NULL AND p_state NOT IN ('open', 'resolved') THEN
    RAISE EXCEPTION 'state must be open or resolved' USING ERRCODE = '22023';
  END IF;
  IF (p_before_at IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION 'cursor needs both a time and an id' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    SELECT i.id,
           i.severity,
           i.title,
           i.summary,
           i.affected_schools,
           i.status,
           to_char(i.opened_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           i.opened_by,
           uo.full_name,
           to_char(i.resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           i.resolved_by,
           ur.full_name
      FROM public.platform_incidents i
      LEFT JOIN public.users uo ON uo.id = i.opened_by
      LEFT JOIN public.users ur ON ur.id = i.resolved_by
     WHERE (p_id IS NULL OR i.id = p_id)
       AND (p_state IS NULL
            OR (p_state = 'open' AND i.status <> 'resolved')
            OR (p_state = 'resolved' AND i.status = 'resolved'))
       AND (p_before_at IS NULL
            OR i.opened_at < p_before_at
            OR (i.opened_at = p_before_at AND i.id > p_before_id))
     ORDER BY i.opened_at DESC, i.id
     LIMIT v_limit;
END
$$;

REVOKE ALL ON FUNCTION public.platform_incidents_list(uuid, text, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_incidents_list(uuid, text, timestamptz, uuid, integer) TO figbloom_app;

-- ---------------------------------------------------------------------------------------------------------------------
-- Declare: a new incident, 'investigating', opened now by the acting super administrator. Returns its id.
CREATE FUNCTION public.platform_incident_declare(
  p_severity text,
  p_title text,
  p_summary text,
  p_affected_schools integer
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
  v_id uuid;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.platform_roles pr WHERE pr.user_id = v_actor AND pr.role = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'super administrator required' USING ERRCODE = '42501';
  END IF;
  IF coalesce(p_severity, '') NOT IN ('SEV-1', 'SEV-2', 'SEV-3')
     OR char_length(btrim(coalesce(p_title, ''))) NOT BETWEEN 1 AND 200
     OR char_length(btrim(coalesce(p_summary, ''))) NOT BETWEEN 1 AND 2000
     OR p_affected_schools IS NULL OR p_affected_schools NOT BETWEEN 0 AND 100000 THEN
    RAISE EXCEPTION 'invalid incident' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.platform_incidents (severity, title, summary, affected_schools, opened_by)
  VALUES (p_severity, btrim(p_title), btrim(p_summary), p_affected_schools, v_actor)
  RETURNING id INTO v_id;

  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, NULL, 'platform.incident.declared',
          jsonb_build_object('incidentId', v_id, 'severity', p_severity, 'affectedSchools', p_affected_schools));
  RETURN v_id;
END
$$;

REVOKE ALL ON FUNCTION public.platform_incident_declare(text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_incident_declare(text, text, text, integer) TO figbloom_app;

-- ---------------------------------------------------------------------------------------------------------------------
-- Resolve: true when this call resolved it, false when it was already resolved (nothing changes, nothing is audited).
-- P0002 for an unknown id. The row is locked, so two resolves at once write one time and one audit row.
CREATE FUNCTION public.platform_incident_resolve(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
  v_row public.platform_incidents%ROWTYPE;
BEGIN
  IF v_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.platform_roles pr WHERE pr.user_id = v_actor AND pr.role = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'super administrator required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM public.platform_incidents i WHERE i.id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'incident not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status = 'resolved' THEN
    RETURN false;
  END IF;

  UPDATE public.platform_incidents
     SET status = 'resolved', resolved_at = greatest(now(), v_row.opened_at), resolved_by = v_actor
   WHERE id = p_id;

  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, NULL, 'platform.incident.resolved',
          jsonb_build_object('incidentId', p_id, 'severity', v_row.severity, 'previousStatus', v_row.status));
  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION public.platform_incident_resolve(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_incident_resolve(uuid) TO figbloom_app;
