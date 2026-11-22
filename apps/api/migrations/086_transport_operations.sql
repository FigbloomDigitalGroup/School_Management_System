-- 086: complete school-transport operations: trip event ledger (pickup / boarding / drop-off / school arrival),
-- terminal-state guard, driver and guardian permissions, guardian notification ledger (provider-neutral,
-- truthful delivery status) and guardian-to-learner resolution. Forward-only; 001–085 untouched.

INSERT INTO permissions (code, description) VALUES
  ('resource.transport.drive', 'Operate own trips: start, report location, record boarding and drop-off events'),
  ('resource.transport.family_read', 'Read transport status and notifications of own linked children')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role, permission_code) VALUES
  ('driver', 'resource.transport.drive'),
  ('parent', 'resource.transport.family_read'),
  -- platform super administrators hold every catalogued permission (they still have no driver membership or linked children)
  ('super_admin', 'resource.transport.drive'),
  ('super_admin', 'resource.transport.family_read')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------
-- Trips: cancellation reason + terminal-state guard (completed / cancelled never resume).
-- ---------------------------------------------------------------------------------------------------------
ALTER TABLE trips ADD COLUMN cancel_reason text;
ALTER TABLE trips ADD CONSTRAINT trips_cancel_reason_chk
  CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL) AND (cancel_reason IS NULL OR char_length(btrim(cancel_reason)) BETWEEN 1 AND 500)) NOT VALID;
GRANT UPDATE (cancel_reason) ON trips TO figbloom_app;

CREATE FUNCTION public.trips_terminal_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status IN ('completed', 'cancelled') AND
     (NEW.status IS DISTINCT FROM OLD.status OR NEW.ended_at IS DISTINCT FROM OLD.ended_at
      OR NEW.route_id IS DISTINCT FROM OLD.route_id OR NEW.cancel_reason IS DISTINCT FROM OLD.cancel_reason) THEN
    RAISE EXCEPTION 'A completed or cancelled trip is final' USING ERRCODE = '23514';
  END IF;
  IF NEW.route_id IS DISTINCT FROM OLD.route_id AND EXISTS (
       SELECT 1 FROM public.trip_events e WHERE e.trip_id = OLD.id AND e.tenant_id = OLD.tenant_id AND e.event_type <> 'trip_started') THEN
    RAISE EXCEPTION 'The route of a trip cannot change once boarding events exist' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- Trip event ledger (append-only: no UPDATE / DELETE grant for the application role).
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE trip_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  trip_id       uuid NOT NULL,
  event_type    text NOT NULL,
  learner_id    uuid,
  stop_id       uuid,
  actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  note          text,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_events_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT trip_events_trip_fk FOREIGN KEY (trip_id, tenant_id) REFERENCES trips (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT trip_events_learner_fk FOREIGN KEY (learner_id, tenant_id) REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT trip_events_stop_fk FOREIGN KEY (stop_id, tenant_id) REFERENCES route_stops (id, tenant_id) ON DELETE SET NULL (stop_id),
  CONSTRAINT trip_events_type_chk CHECK (event_type IN (
    'trip_started', 'stop_arrived', 'learner_boarded', 'learner_alighted', 'learner_not_boarded',
    'school_arrived', 'delayed', 'incident', 'trip_completed', 'trip_cancelled')),
  CONSTRAINT trip_events_learner_required_chk CHECK (
    (event_type IN ('learner_boarded', 'learner_alighted', 'learner_not_boarded')) = (learner_id IS NOT NULL)),
  CONSTRAINT trip_events_note_chk CHECK (note IS NULL OR char_length(note) <= 500)
);
CREATE INDEX trip_events_trip_idx ON trip_events (tenant_id, trip_id, occurred_at, id);
-- Duplicate protection: one boarding / drop-off / no-show per learner per trip, one singleton per trip.
CREATE UNIQUE INDEX trip_events_learner_once ON trip_events (trip_id, learner_id, event_type) WHERE learner_id IS NOT NULL;
CREATE UNIQUE INDEX trip_events_singleton ON trip_events (trip_id, event_type)
  WHERE event_type IN ('trip_started', 'school_arrived', 'trip_completed', 'trip_cancelled');
CREATE UNIQUE INDEX trip_events_stop_once ON trip_events (trip_id, stop_id) WHERE event_type = 'stop_arrived' AND stop_id IS NOT NULL;

CREATE FUNCTION public.trip_events_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  t public.trips%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.trips WHERE id = NEW.trip_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Trip not found' USING ERRCODE = '23503';
  END IF;
  -- terminal events are written in the same transaction that closes the trip
  IF NEW.event_type NOT IN ('trip_completed', 'trip_cancelled') AND t.status <> 'active' THEN
    RAISE EXCEPTION 'The trip is not active' USING ERRCODE = '23514';
  END IF;
  IF NEW.event_type = 'school_arrived' AND t.direction <> 'to_school' THEN
    RAISE EXCEPTION 'school_arrived is only valid on a to_school trip' USING ERRCODE = '23514';
  END IF;
  IF NEW.stop_id IS NOT NULL AND (t.route_id IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.route_stops s WHERE s.id = NEW.stop_id AND s.tenant_id = NEW.tenant_id AND s.route_id = t.route_id)) THEN
    RAISE EXCEPTION 'The stop does not belong to the trip route' USING ERRCODE = '23514';
  END IF;
  IF NEW.learner_id IS NOT NULL THEN
    IF t.route_id IS NULL OR NOT EXISTS (
         SELECT 1 FROM public.learner_transport lt
          WHERE lt.learner_id = NEW.learner_id AND lt.tenant_id = NEW.tenant_id AND lt.route_id = t.route_id) THEN
      RAISE EXCEPTION 'The learner is not assigned to this trip route' USING ERRCODE = '23514';
    END IF;
    IF NEW.event_type = 'learner_alighted' AND NOT EXISTS (
         SELECT 1 FROM public.trip_events b
          WHERE b.trip_id = NEW.trip_id AND b.learner_id = NEW.learner_id AND b.event_type = 'learner_boarded') THEN
      RAISE EXCEPTION 'A learner cannot be dropped off before boarding' USING ERRCODE = '23514';
    END IF;
    IF NEW.event_type = 'learner_boarded' AND EXISTS (
         SELECT 1 FROM public.trip_events b
          WHERE b.trip_id = NEW.trip_id AND b.learner_id = NEW.learner_id AND b.event_type = 'learner_not_boarded') THEN
      RAISE EXCEPTION 'The learner was already recorded as not boarded' USING ERRCODE = '23514';
    END IF;
    IF NEW.event_type = 'learner_not_boarded' AND EXISTS (
         SELECT 1 FROM public.trip_events b
          WHERE b.trip_id = NEW.trip_id AND b.learner_id = NEW.learner_id AND b.event_type IN ('learner_boarded', 'learner_alighted')) THEN
      RAISE EXCEPTION 'The learner already boarded this trip' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trips_terminal_guard BEFORE UPDATE ON trips FOR EACH ROW EXECUTE FUNCTION public.trips_terminal_guard();
CREATE TRIGGER trip_events_guard BEFORE INSERT ON trip_events FOR EACH ROW EXECUTE FUNCTION public.trip_events_guard();

-- ---------------------------------------------------------------------------------------------------------
-- Guardian notification ledger. delivery_status is truthful: no provider is configured, so every row is
-- 'not_configured' (readable in-app by the recipient) until a delivery worker with a real provider exists.
-- ---------------------------------------------------------------------------------------------------------
CREATE TABLE transport_notifications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  trip_id           uuid NOT NULL,
  event_id          uuid NOT NULL,
  learner_id        uuid NOT NULL,
  recipient_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind              text NOT NULL,
  title             text NOT NULL,
  body              text NOT NULL,
  delivery_status   text NOT NULL DEFAULT 'not_configured',
  in_app_read_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transport_notifications_event_fk FOREIGN KEY (event_id, tenant_id) REFERENCES trip_events (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT transport_notifications_trip_fk FOREIGN KEY (trip_id, tenant_id) REFERENCES trips (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT transport_notifications_learner_fk FOREIGN KEY (learner_id, tenant_id) REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT transport_notifications_status_chk CHECK (delivery_status IN ('not_configured', 'queued', 'sent', 'failed')),
  CONSTRAINT transport_notifications_dedupe UNIQUE (event_id, recipient_user_id, learner_id)
);
CREATE INDEX transport_notifications_recipient_idx ON transport_notifications (tenant_id, recipient_user_id, created_at DESC, id);

-- Resolve the learners the calling guardian account is legitimately linked to (guardian_accounts is owner-only).
CREATE FUNCTION public.transport_my_children() RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT DISTINCT gl.learner_id
    FROM public.guardian_accounts ga
    JOIN public.guardian_links gl ON gl.guardian_id = ga.guardian_id AND gl.tenant_id = ga.tenant_id AND gl.archived_at IS NULL
    JOIN public.learners le ON le.id = gl.learner_id AND le.tenant_id = gl.tenant_id AND le.archived_at IS NULL
    JOIN public.school_memberships m ON m.user_id = ga.user_id AND m.tenant_id = ga.tenant_id AND m.archived_at IS NULL AND m.role = 'parent'
   WHERE ga.user_id = public.app_current_user_id()
     AND ga.tenant_id = public.app_current_tenant_id()
     AND ga.revoked_at IS NULL
$$;

-- Fan a trip event out to the linked guardian accounts (deduplicated). Returns the number of new rows.
-- No automatic emergency notification: incident events are recorded only (policy is an owner decision).
CREATE FUNCTION public.transport_fanout_notifications(p_event uuid) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.app_current_tenant_id();
  e public.trip_events%ROWTYPE;
  t public.trips%ROWTYPE;
  v_kind text; v_title text; v_body text; v_n integer;
BEGIN
  IF v_tenant IS NULL OR public.app_current_user_id() IS NULL THEN
    RAISE EXCEPTION 'transport_fanout_notifications requires an authenticated tenant context' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO e FROM public.trip_events WHERE id = p_event AND tenant_id = v_tenant;
  IF NOT FOUND THEN RETURN 0; END IF;
  SELECT * INTO t FROM public.trips WHERE id = e.trip_id AND tenant_id = v_tenant;

  IF e.event_type = 'trip_started' THEN
    v_kind := 'trip_started';
    v_title := CASE t.direction WHEN 'to_school' THEN 'Morning bus trip started' ELSE 'Afternoon bus trip started' END;
    v_body := 'The school bus trip for your child''s route has started.';
  ELSIF e.event_type = 'learner_boarded' THEN
    v_kind := 'learner_boarded';
    v_title := CASE t.direction WHEN 'to_school' THEN 'Picked up' ELSE 'Boarded the bus' END;
    v_body := CASE t.direction WHEN 'to_school' THEN 'Your child has been picked up by the school bus.' ELSE 'Your child has boarded the school bus for the journey home.' END;
  ELSIF e.event_type = 'learner_alighted' THEN
    v_kind := 'learner_dropped_off';
    v_title := CASE t.direction WHEN 'to_school' THEN 'Got off the bus' ELSE 'Dropped off' END;
    v_body := CASE t.direction WHEN 'to_school' THEN 'Your child has got off the school bus.' ELSE 'Your child has been dropped off by the school bus.' END;
  ELSIF e.event_type = 'learner_not_boarded' THEN
    v_kind := 'learner_not_boarded';
    v_title := 'Not on the bus';
    v_body := 'Your child was not picked up on this bus trip.';
  ELSIF e.event_type = 'school_arrived' THEN
    v_kind := 'school_arrived';
    v_title := 'Bus arrived at school';
    v_body := 'The school bus has arrived at school.';
  ELSIF e.event_type = 'delayed' THEN
    v_kind := 'trip_delayed';
    v_title := 'Bus delayed';
    v_body := 'The school bus on your child''s route is delayed.';
  ELSIF e.event_type = 'trip_cancelled' THEN
    v_kind := 'trip_cancelled';
    v_title := 'Bus trip cancelled';
    v_body := 'The school bus trip for your child''s route was cancelled.';
  ELSE
    RETURN 0;
  END IF;

  INSERT INTO public.transport_notifications (tenant_id, trip_id, event_id, learner_id, recipient_user_id, kind, title, body)
  SELECT DISTINCT v_tenant, t.id, e.id, r.learner_id, ga.user_id, v_kind, v_title, v_body
    FROM (
      SELECT e.learner_id AS learner_id WHERE e.learner_id IS NOT NULL
      UNION
      SELECT lt.learner_id
        FROM public.learner_transport lt
       WHERE e.learner_id IS NULL AND lt.tenant_id = v_tenant AND lt.route_id = t.route_id
         AND (e.event_type <> 'school_arrived' OR EXISTS (
               SELECT 1 FROM public.trip_events b
                WHERE b.trip_id = t.id AND b.learner_id = lt.learner_id AND b.event_type = 'learner_boarded'))
    ) r
    JOIN public.learners le ON le.id = r.learner_id AND le.tenant_id = v_tenant AND le.archived_at IS NULL
    JOIN public.guardian_links gl ON gl.learner_id = r.learner_id AND gl.tenant_id = v_tenant AND gl.archived_at IS NULL
    JOIN public.guardian_accounts ga ON ga.guardian_id = gl.guardian_id AND ga.tenant_id = v_tenant AND ga.revoked_at IS NULL
    JOIN public.school_memberships m ON m.user_id = ga.user_id AND m.tenant_id = v_tenant AND m.archived_at IS NULL AND m.role = 'parent'
  ON CONFLICT (event_id, recipient_user_id, learner_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.transport_my_children() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transport_fanout_notifications(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.transport_my_children() TO figbloom_app;
GRANT EXECUTE ON FUNCTION public.transport_fanout_notifications(uuid) TO figbloom_app;

-- ---------------------------------------------------------------------------------------------------------
-- RLS / grants
-- ---------------------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trip_events', 'transport_notifications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO figbloom_app USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())',
      t || '_tenant', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I FOR ALL TO PUBLIC
      USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))
      WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))
    $f$, t || '_owner', t, t, t);
  END LOOP;
END $$;

-- A recipient can only ever see / mark their own notifications, even if the application layer forgot a filter.
CREATE POLICY transport_notifications_recipient_read ON transport_notifications AS RESTRICTIVE FOR SELECT TO figbloom_app
  USING (recipient_user_id = app_current_user_id());
CREATE POLICY transport_notifications_recipient_update ON transport_notifications AS RESTRICTIVE FOR UPDATE TO figbloom_app
  USING (recipient_user_id = app_current_user_id()) WITH CHECK (recipient_user_id = app_current_user_id());

GRANT SELECT, INSERT ON trip_events TO figbloom_app;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON trip_events FROM figbloom_app;
GRANT SELECT ON transport_notifications TO figbloom_app;
GRANT UPDATE (in_app_read_at) ON transport_notifications TO figbloom_app;
REVOKE INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER ON transport_notifications FROM figbloom_app;
REVOKE ALL ON trip_events, transport_notifications FROM figbloom_worker;

-- A driver operates only their own trips (drive permission). Fleet-wide location history is not a driver
-- capability: remove the blanket read grant introduced in 057 (admins keep read + write).
DELETE FROM role_permissions WHERE role = 'driver' AND permission_code = 'resource.transport.read';
