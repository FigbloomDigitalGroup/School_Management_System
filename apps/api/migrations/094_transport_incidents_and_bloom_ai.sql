-- Stage 7 & 8: Transport Incident Lifecycle + Central Notification Bridge. Forward-only.
-- (Bloom AI shared rate limiting reuses existing PG consume_rate_token / auth_rate_buckets.)

-- 1. Transport Incidents table (acknowledgement, escalation, resolution with full audit history)
CREATE TABLE transport_incidents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  trip_id           uuid NOT NULL,
  event_id          uuid NOT NULL,
  severity          text NOT NULL DEFAULT 'medium',
  summary           text NOT NULL,
  status            text NOT NULL DEFAULT 'open',
  reported_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  acknowledged_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  acknowledged_at   timestamptz,
  escalated_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  escalated_at      timestamptz,
  escalation_reason text,
  resolved_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  resolved_at       timestamptz,
  resolution_note   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transport_incidents_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT transport_incidents_event_uniq UNIQUE (event_id),
  CONSTRAINT transport_incidents_trip_fk FOREIGN KEY (trip_id, tenant_id) REFERENCES trips (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT transport_incidents_event_fk FOREIGN KEY (event_id, tenant_id) REFERENCES trip_events (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT transport_incidents_severity_chk CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT transport_incidents_status_chk CHECK (status IN ('open', 'acknowledged', 'escalated', 'resolved')),
  CONSTRAINT transport_incidents_summary_len CHECK (char_length(btrim(summary)) BETWEEN 1 AND 500)
);

CREATE INDEX transport_incidents_trip_idx ON transport_incidents (tenant_id, trip_id, created_at DESC, id);

ALTER TABLE transport_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE transport_incidents FORCE ROW LEVEL SECURITY;

CREATE POLICY transport_incidents_tenant ON transport_incidents FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY transport_incidents_owner ON transport_incidents FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'transport_incidents'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'transport_incidents'));

GRANT SELECT, INSERT ON transport_incidents TO figbloom_app;
GRANT UPDATE (status, severity, acknowledged_by, acknowledged_at, escalated_by, escalated_at, escalation_reason, resolved_by, resolved_at, resolution_note)
  ON transport_incidents TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON transport_incidents FROM figbloom_app;

-- 2. Helper: resolve guardian recipients for a trip event (used to bridge transport fanout into central notification_outbox)
CREATE FUNCTION public.transport_event_recipients(p_event_id uuid)
RETURNS TABLE (recipient_user_id uuid, title text, body text, kind text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT DISTINCT tn.recipient_user_id, tn.title, tn.body, tn.kind
    FROM public.transport_notifications tn
   WHERE tn.tenant_id = public.app_current_tenant_id()
     AND tn.event_id = p_event_id;
$$;
REVOKE ALL ON FUNCTION public.transport_event_recipients(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transport_event_recipients(uuid) TO figbloom_app;

-- 3. Helper: resolve guardian recipients for all learners on a trip's route (for explicit admin incident escalation notices)
CREATE FUNCTION public.transport_trip_guardian_users(p_trip_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT DISTINCT ga.user_id
    FROM public.trips t
    JOIN public.learner_transport lt
      ON lt.tenant_id = t.tenant_id
     AND lt.route_id = t.route_id
    JOIN public.guardian_links gl
      ON gl.tenant_id = lt.tenant_id
     AND gl.learner_id = lt.learner_id
     AND gl.archived_at IS NULL
    JOIN public.guardian_accounts ga
      ON ga.tenant_id = gl.tenant_id
     AND ga.guardian_id = gl.guardian_id
     AND ga.revoked_at IS NULL
    JOIN public.school_memberships sm
      ON sm.tenant_id = ga.tenant_id
     AND sm.user_id = ga.user_id
     AND sm.role = 'parent'
     AND sm.archived_at IS NULL
   WHERE t.tenant_id = public.app_current_tenant_id()
     AND t.id = p_trip_id;
$$;
REVOKE ALL ON FUNCTION public.transport_trip_guardian_users(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transport_trip_guardian_users(uuid) TO figbloom_app;
