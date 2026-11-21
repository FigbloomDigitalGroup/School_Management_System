-- Stage 12: gate / reception visitor log (legacy 20261027010001_gate_reception). Forward-only.
-- Rebuild: learners (not students), users (not profiles). Front-desk authority is
-- area.visitors / resource.visitor.* (no separate handles_visitors flag yet — owner
-- may later add a staff flag; area grant is the approved rebuild path).

CREATE TABLE gate_visits (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  visitor_name          text NOT NULL,
  visitor_phone         text,
  id_number             text,
  vehicle_plate         text,
  purpose               text NOT NULL,
  host_kind             text NOT NULL,
  host_user_id          uuid REFERENCES users (id) ON DELETE SET NULL,
  learner_id            uuid,
  host_name             text,
  learner_name          text,
  entry_point           text NOT NULL DEFAULT 'gate',
  status                text NOT NULL DEFAULT 'expected',
  escalated             boolean NOT NULL DEFAULT false,
  escalated_at          timestamptz,
  note                  text,
  recorded_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  arrived_at            timestamptz NOT NULL DEFAULT now(),
  reception_at          timestamptz,
  with_host_at          timestamptz,
  left_at               timestamptz,
  host_notified_at      timestamptz,
  escalation_notified_at timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gate_visits_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT gate_visits_visitor_name_chk CHECK (char_length(btrim(visitor_name)) BETWEEN 1 AND 120),
  CONSTRAINT gate_visits_purpose_chk CHECK (char_length(btrim(purpose)) BETWEEN 1 AND 300),
  CONSTRAINT gate_visits_phone_chk CHECK (visitor_phone IS NULL OR char_length(visitor_phone) <= 30),
  CONSTRAINT gate_visits_id_number_chk CHECK (id_number IS NULL OR char_length(id_number) <= 40),
  CONSTRAINT gate_visits_plate_chk CHECK (vehicle_plate IS NULL OR char_length(vehicle_plate) <= 20),
  CONSTRAINT gate_visits_note_chk CHECK (note IS NULL OR char_length(note) <= 500),
  CONSTRAINT gate_visits_host_kind_chk CHECK (host_kind IN ('office', 'principal', 'teacher', 'learner')),
  CONSTRAINT gate_visits_entry_chk CHECK (entry_point IN ('gate', 'reception')),
  CONSTRAINT gate_visits_status_chk CHECK (status IN ('expected', 'at_reception', 'with_host', 'left')),
  CONSTRAINT gate_visits_learner_fk FOREIGN KEY (learner_id, tenant_id) REFERENCES learners (id, tenant_id) ON DELETE SET NULL
);
CREATE INDEX gate_visits_tenant_arrived_idx ON gate_visits (tenant_id, arrived_at DESC);
CREATE INDEX gate_visits_host_idx ON gate_visits (tenant_id, host_user_id, arrived_at DESC);
CREATE INDEX gate_visits_open_idx ON gate_visits (tenant_id, status) WHERE status <> 'left';

CREATE FUNCTION public.gate_visits_stamp() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_host_name text;
  v_host_role text;
  v_learner_name text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'A visit cannot be moved to another school' USING ERRCODE = '42501';
  END IF;

  NEW.visitor_name := btrim(NEW.visitor_name);
  NEW.purpose := btrim(NEW.purpose);

  IF NEW.host_kind = 'teacher' THEN
    IF TG_OP = 'INSERT' OR NEW.host_user_id IS DISTINCT FROM OLD.host_user_id OR OLD.host_kind IS DISTINCT FROM 'teacher' THEN
      SELECT u.full_name, m.role::text INTO v_host_name, v_host_role
        FROM public.users u
        JOIN public.school_memberships m ON m.user_id = u.id AND m.tenant_id = NEW.tenant_id AND m.archived_at IS NULL
       WHERE u.id = NEW.host_user_id AND u.status = 'active';
      IF v_host_name IS NULL OR v_host_role NOT IN ('teacher', 'school_admin') THEN
        RAISE EXCEPTION 'Pick a member of staff at this school' USING ERRCODE = '22023';
      END IF;
      NEW.host_name := v_host_name;
    END IF;
  ELSE
    NEW.host_user_id := NULL;
    NEW.host_name := CASE NEW.host_kind
      WHEN 'office' THEN 'the office'
      WHEN 'principal' THEN 'the principal'
      ELSE NULL
    END;
  END IF;

  IF NEW.host_kind = 'learner' THEN
    IF TG_OP = 'INSERT' OR NEW.learner_id IS DISTINCT FROM OLD.learner_id OR OLD.host_kind IS DISTINCT FROM 'learner' THEN
      SELECT l.full_name INTO v_learner_name
        FROM public.learners l
       WHERE l.id = NEW.learner_id AND l.tenant_id = NEW.tenant_id AND l.archived_at IS NULL;
      IF v_learner_name IS NULL THEN
        RAISE EXCEPTION 'Pick a learner at this school' USING ERRCODE = '22023';
      END IF;
      NEW.learner_name := v_learner_name;
    END IF;
  ELSE
    NEW.learner_id := NULL;
    NEW.learner_name := NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.arrived_at := now();
    NEW.escalated_at := NULL;
    NEW.escalated := (NEW.host_kind = 'principal');
    IF NEW.escalated THEN NEW.escalated_at := now(); END IF;
    IF NEW.entry_point = 'reception' AND NEW.status = 'expected' THEN
      NEW.status := 'at_reception';
      NEW.reception_at := now();
    END IF;
  ELSE
    NEW.recorded_by := OLD.recorded_by;
    NEW.arrived_at := OLD.arrived_at;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF OLD.status = 'left' THEN
        RAISE EXCEPTION 'A signed-out visit is final' USING ERRCODE = '23514';
      END IF;
      IF NEW.status = 'at_reception' AND OLD.status = 'expected' THEN
        NEW.reception_at := coalesce(NEW.reception_at, now());
      ELSIF NEW.status = 'with_host' AND OLD.status IN ('expected', 'at_reception') THEN
        NEW.with_host_at := coalesce(NEW.with_host_at, now());
        NEW.reception_at := coalesce(NEW.reception_at, OLD.reception_at, now());
      ELSIF NEW.status = 'left' AND OLD.status IN ('expected', 'at_reception', 'with_host') THEN
        NEW.left_at := coalesce(NEW.left_at, now());
      ELSE
        RAISE EXCEPTION 'Invalid visit status transition' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.host_kind = 'principal' AND NOT OLD.escalated THEN
      NEW.escalated := true;
      NEW.escalated_at := coalesce(NEW.escalated_at, now());
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER gate_visits_stamp BEFORE INSERT OR UPDATE ON gate_visits
  FOR EACH ROW EXECUTE FUNCTION public.gate_visits_stamp();
REVOKE ALL ON FUNCTION public.gate_visits_stamp() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gate_visits_stamp() FROM figbloom_app;

ALTER TABLE gate_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE gate_visits FORCE ROW LEVEL SECURITY;
CREATE POLICY gate_visits_tenant ON gate_visits FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY gate_visits_owner ON gate_visits FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gate_visits'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'gate_visits'));

GRANT SELECT, INSERT ON gate_visits TO figbloom_app;
GRANT UPDATE (
  visitor_name, visitor_phone, id_number, vehicle_plate, purpose,
  host_kind, host_user_id, learner_id, host_name, learner_name,
  entry_point, status, escalated, escalated_at, note,
  reception_at, with_host_at, left_at, host_notified_at, escalation_notified_at, updated_at
) ON gate_visits TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON gate_visits FROM figbloom_app;

-- Device token reclaim: move a globally unique FCM token to the signing-in user.
CREATE FUNCTION public.device_tokens_register(p_user uuid, p_token text, p_platform text) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_user IS NULL OR p_user IS DISTINCT FROM public.app_current_user_id() THEN
    RAISE EXCEPTION 'device token registration requires the signed-in user' USING ERRCODE = '42501';
  END IF;
  IF p_platform NOT IN ('android', 'ios') THEN
    RAISE EXCEPTION 'invalid platform' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.device_tokens WHERE token = p_token;
  INSERT INTO public.device_tokens (user_id, token, platform)
  VALUES (p_user, p_token, p_platform)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.device_tokens_register(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.device_tokens_register(uuid, text, text) TO figbloom_app;
