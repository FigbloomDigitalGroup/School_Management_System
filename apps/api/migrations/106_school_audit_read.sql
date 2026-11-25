-- 106: the school's audit log, read by its administrators. Forward-only; 001-105 untouched. Design: docs/SCHOOL-AUDIT.md.
--
-- security_audit_events keeps NO SELECT grant for figbloom_app (migration 001; asserted by phase3.runtimeIsolation), so a
-- school cannot read its own log through a table. This migration adds the one narrow read, as a SECURITY DEFINER function
-- (the same pattern as org_my_audit_events, 105), and the permission that guards the route.
--
-- What a school may read (decided here, in the database, so no route can widen it by mistake):
--   * only rows whose tenant_id is the school of the request (app_current_tenant_id(), set by the API after it authorised
--     the request; there is no tenant argument, so nobody can ask about another school);
--   * only business events: people and setup, access changes, academic, financial, health, transport, communication and
--     operations. Sign-in, session and two-step events, refusals ("denied"), read events ("viewed"), personal settings,
--     private chat starts, storage transfers and every event of a domain this list does not name are NEVER returned. A new
--     kind of event is therefore hidden until it is added here on purpose;
--   * never the `detail` column and never the `ip` column: the row says what happened, who did it and when, not what the
--     record held (detail may carry names, amounts or health information, and its shape differs by event);
--   * newest first, keyset on (occurred_at, id), at most 201 rows.

INSERT INTO permissions (code, description) VALUES
  ('resource.audit.read', 'Read the school audit log: what happened, who did it and when (no detail, no IP address)')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'resource.audit.read'),
  -- platform super administrators hold every catalogued permission
  ('super_admin', 'resource.audit.read')
ON CONFLICT DO NOTHING;

CREATE FUNCTION public.school_audit_events(
  p_category text,
  p_since timestamptz,
  p_search text,
  p_before_at timestamptz,
  p_before_id uuid,
  p_limit integer
)
RETURNS TABLE (id uuid, occurred_at_text text, event_type text, category text, actor_user_id uuid, actor_name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.app_current_tenant_id();
  v_actor uuid := public.app_current_user_id();
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 201);
  v_search text := lower(nullif(btrim(coalesce(p_search, '')), ''));
BEGIN
  -- The API checks the permission first; the database still needs a school and an account, and refuses without them.
  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'no school or account in this request' USING ERRCODE = '42501';
  END IF;
  IF (p_before_at IS NULL) <> (p_before_id IS NULL) THEN
    RAISE EXCEPTION 'cursor needs both a time and an id' USING ERRCODE = '22023';
  END IF;
  IF p_category IS NOT NULL AND p_category NOT IN
     ('provisioning', 'access', 'academic', 'financial', 'health', 'transport', 'communication', 'operations') THEN
    RAISE EXCEPTION 'unknown category' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT x.id,
           to_char(x.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
           x.event_type,
           x.cat,
           x.actor_user_id,
           u.full_name
      FROM (
        SELECT e.id, e.occurred_at, e.event_type, e.actor_user_id,
               CASE
                 -- never shown: sign-in and session events, refusals, read events, personal and internal ones
                 WHEN e.event_type ~ '^(auth|family|ai|notifications|identity)\.' THEN NULL
                 WHEN e.event_type ~ '[._](denied|viewed)$' THEN NULL
                 WHEN e.event_type IN ('finance.mpesa.operator_inconclusive', 'communications.chat.started',
                                       'communications.notification_preferences.updated',
                                       'attendance.register.stale_ignored') THEN NULL
                 WHEN e.event_type ~ '^storage\.' AND e.event_type <> 'storage.object.deleted' THEN NULL
                 -- shown, by category (the web console's eight)
                 WHEN e.event_type ~ '^(directory|import)\.' THEN 'provisioning'
                 WHEN e.event_type ~ '^academics\.(year|term|subject|class|teaching_assignment|membership)\.' THEN 'provisioning'
                 WHEN e.event_type ~ '^attendance\.settings\.' THEN 'provisioning'
                 WHEN e.event_type ~ '^rbac\.' THEN 'access'
                 WHEN e.event_type ~ '^(academics|curriculum)\.' THEN 'academic'
                 WHEN e.event_type ~ '^reporting\.teacher_report\.' THEN 'academic'
                 WHEN e.event_type ~ '^finance\.' THEN 'financial'
                 WHEN e.event_type ~ '^(health|medication)\.' THEN 'health'
                 WHEN e.event_type ~ '^transport\.' THEN 'transport'
                 WHEN e.event_type ~ '^communications\.visit\.' THEN 'operations'
                 WHEN e.event_type ~ '^communications\.' OR e.event_type = 'admin.manual_notice' THEN 'communication'
                 WHEN e.event_type ~ '^(inventory|activities|attendance|hr|storage|reporting)\.' THEN 'operations'
                 ELSE NULL
               END AS cat
          FROM public.security_audit_events e
         WHERE e.tenant_id = v_tenant
           AND (p_since IS NULL OR e.occurred_at >= p_since)
           AND (p_before_at IS NULL
                OR e.occurred_at < p_before_at
                OR (e.occurred_at = p_before_at AND e.id > p_before_id))
      ) x
      LEFT JOIN public.users u ON u.id = x.actor_user_id
     WHERE x.cat IS NOT NULL
       AND (p_category IS NULL OR x.cat = p_category)
       AND (v_search IS NULL
            OR position(v_search IN lower(coalesce(u.full_name, ''))) > 0
            OR position(v_search IN replace(replace(x.event_type, '_', ' '), '.', ' ')) > 0)
     ORDER BY x.occurred_at DESC, x.id
     LIMIT v_limit;
END
$$;
REVOKE ALL ON FUNCTION public.school_audit_events(text, timestamptz, text, timestamptz, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.school_audit_events(text, timestamptz, text, timestamptz, uuid, integer) TO figbloom_app;
