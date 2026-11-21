-- Stage 12: sick bay core (legacy 20261101300000 medical — visits + settings first). Forward-only.
-- Medication schedules/requests, inventory stock deduction, and FCM notify are deferred
-- (stock → Stage 13 inventory; FCM → ops). Guardians see notices in-app when linked.

CREATE TABLE medical_settings (
  tenant_id         uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  notify_guardians  text NOT NULL DEFAULT 'serious',
  updated_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT medical_settings_notify_chk CHECK (notify_guardians IN ('all', 'serious'))
);

CREATE FUNCTION public.medical_outcome_notifies(p_policy text, p_outcome text) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_outcome IS NOT NULL
     AND (coalesce(p_policy, 'serious') = 'all' OR p_outcome IN ('home', 'hospital', 'admitted'));
$$;
REVOKE ALL ON FUNCTION public.medical_outcome_notifies(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.medical_outcome_notifies(text, text) TO figbloom_app;

CREATE TABLE sick_bay_visits (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  learner_id           uuid NOT NULL,
  time_in              timestamptz NOT NULL DEFAULT now(),
  complaint            text NOT NULL,
  temperature_c        numeric(4, 1),
  pulse_bpm            integer,
  observations         text,
  assessment           text,
  treatment            text,
  outcome              text,
  referred_to          text,
  time_out             timestamptz,
  follow_up            text,
  attendance_mark      text,
  attendance_marked_at timestamptz,
  logged_by            uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sick_bay_visits_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT sick_bay_visits_learner_fk FOREIGN KEY (learner_id, tenant_id) REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT sick_bay_visits_complaint_chk CHECK (char_length(btrim(complaint)) BETWEEN 1 AND 300),
  CONSTRAINT sick_bay_visits_temp_chk CHECK (temperature_c IS NULL OR temperature_c BETWEEN 30 AND 45),
  CONSTRAINT sick_bay_visits_pulse_chk CHECK (pulse_bpm IS NULL OR pulse_bpm BETWEEN 20 AND 250),
  CONSTRAINT sick_bay_visits_outcome_chk CHECK (outcome IS NULL OR outcome IN ('class', 'rest', 'home', 'hospital', 'admitted')),
  CONSTRAINT sick_bay_visits_attendance_chk CHECK (attendance_mark IS NULL OR attendance_mark IN ('excused', 'absent')),
  CONSTRAINT sick_bay_visits_time_out_chk CHECK (time_out IS NULL OR time_out >= time_in)
);
CREATE INDEX sick_bay_visits_board_idx ON sick_bay_visits (tenant_id, time_in) WHERE time_out IS NULL;
CREATE INDEX sick_bay_visits_learner_idx ON sick_bay_visits (tenant_id, learner_id, time_in DESC);

CREATE TABLE medical_notices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  visit_id      uuid NOT NULL,
  guardian_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  learner_id    uuid NOT NULL,
  outcome       text NOT NULL,
  summary       text NOT NULL,
  read_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT medical_notices_visit_fk FOREIGN KEY (visit_id, tenant_id) REFERENCES sick_bay_visits (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT medical_notices_learner_fk FOREIGN KEY (learner_id, tenant_id) REFERENCES learners (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX medical_notices_guardian_idx ON medical_notices (tenant_id, guardian_user_id, created_at DESC);

CREATE FUNCTION public.sick_bay_visits_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.learner_id IS DISTINCT FROM OLD.learner_id
       OR NEW.logged_by IS DISTINCT FROM OLD.logged_by OR NEW.time_in IS DISTINCT FROM OLD.time_in THEN
      RAISE EXCEPTION 'sick bay visit identity is immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.complaint := btrim(NEW.complaint);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER sick_bay_visits_guard BEFORE INSERT OR UPDATE ON sick_bay_visits
  FOR EACH ROW EXECUTE FUNCTION public.sick_bay_visits_guard();
REVOKE ALL ON FUNCTION public.sick_bay_visits_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sick_bay_visits_guard() FROM figbloom_app;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['medical_settings', 'sick_bay_visits', 'medical_notices']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO figbloom_app USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())',
      t || '_tenant', t
    );
    EXECUTE format($f$
      CREATE POLICY %I ON %I FOR ALL TO PUBLIC
      USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))
      WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))
    $f$, t || '_owner', t, t, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON medical_settings TO figbloom_app;
GRANT SELECT, INSERT ON sick_bay_visits TO figbloom_app;
GRANT UPDATE (
  complaint, temperature_c, pulse_bpm, observations, assessment, treatment,
  outcome, referred_to, time_out, follow_up, attendance_mark, attendance_marked_at, updated_at
) ON sick_bay_visits TO figbloom_app;
GRANT SELECT, INSERT, UPDATE ON medical_notices TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON medical_settings FROM figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON sick_bay_visits FROM figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON medical_notices FROM figbloom_app;
