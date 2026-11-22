-- Stage 5: Health and Medication Module (health profiles, medication authorizations,
-- explicit guardian consent, schedules, immutable MAR + auditable corrections, incidents).
-- Forward-only.

INSERT INTO permissions (code, description) VALUES
  ('resource.medication.read', 'Read learner health profiles, medication authorizations, schedules, MAR and incidents'),
  ('resource.medication.write', 'Manage learner health profiles, medication authorizations, schedules and incidents'),
  ('resource.medication.administer', 'Record medication administrations and auditable MAR corrections'),
  ('resource.medication.consent', 'Grant or decline guardian consent for own linked learners medication authorizations')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'resource.medication.read'),
  ('school_admin', 'resource.medication.write'),
  ('school_admin', 'resource.medication.administer'),
  ('parent', 'resource.medication.consent'),
  ('super_admin', 'resource.medication.read'),
  ('super_admin', 'resource.medication.write'),
  ('super_admin', 'resource.medication.administer'),
  ('super_admin', 'resource.medication.consent')
ON CONFLICT DO NOTHING;

-- Helper: resolve active linked guardian user_ids for a learner in the current tenant (for notifications)
CREATE FUNCTION public.medication_learner_guardian_users(p_learner_id uuid)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT DISTINCT ga.user_id
    FROM public.guardian_links gl
    JOIN public.guardian_accounts ga
      ON ga.guardian_id = gl.guardian_id
     AND ga.tenant_id = gl.tenant_id
     AND ga.revoked_at IS NULL
    JOIN public.school_memberships sm
      ON sm.user_id = ga.user_id
     AND sm.tenant_id = gl.tenant_id
     AND sm.role = 'parent'
     AND sm.archived_at IS NULL
    JOIN public.users u
      ON u.id = ga.user_id
     AND u.status = 'active'
   WHERE gl.tenant_id = public.app_current_tenant_id()
     AND gl.learner_id = p_learner_id
     AND gl.archived_at IS NULL;
$$;
REVOKE ALL ON FUNCTION public.medication_learner_guardian_users(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.medication_learner_guardian_users(uuid) TO figbloom_app;

-- 1. Learner Health Profiles
CREATE TABLE learner_health_profiles (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  learner_id         uuid NOT NULL,
  blood_group        text,
  allergies          text[] NOT NULL DEFAULT ARRAY[]::text[],
  chronic_conditions text[] NOT NULL DEFAULT ARRAY[]::text[],
  dietary_notes      text,
  emergency_notes    text,
  updated_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  row_version        integer NOT NULL DEFAULT 1,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learner_health_profiles_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT learner_health_profiles_learner_uniq UNIQUE (tenant_id, learner_id),
  CONSTRAINT learner_health_profiles_learner_fk FOREIGN KEY (learner_id, tenant_id) REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT learner_health_profiles_blood_chk CHECK (blood_group IS NULL OR blood_group IN ('A+','A-','B+','B-','AB+','AB-','O+','O-','unknown')),
  CONSTRAINT learner_health_profiles_ver_chk CHECK (row_version >= 1)
);

ALTER TABLE learner_health_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE learner_health_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY learner_health_profiles_tenant ON learner_health_profiles FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY learner_health_profiles_owner ON learner_health_profiles FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'learner_health_profiles'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'learner_health_profiles'));

GRANT SELECT, INSERT ON learner_health_profiles TO figbloom_app;
GRANT UPDATE (blood_group, allergies, chronic_conditions, dietary_notes, emergency_notes, updated_by, row_version, updated_at) ON learner_health_profiles TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON learner_health_profiles FROM figbloom_app;

-- 2. Medication Authorizations (explicit separation of record, guardian consent, document, approval)
CREATE TABLE medication_authorizations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  learner_id              uuid NOT NULL,
  medication_name         text NOT NULL,
  dosage_instruction      text NOT NULL,
  frequency_instruction   text NOT NULL,
  route                   text NOT NULL DEFAULT 'oral',
  start_date              date NOT NULL,
  end_date                date NOT NULL,
  status                  text NOT NULL DEFAULT 'pending_consent',
  guardian_consent_status text NOT NULL DEFAULT 'pending',
  guardian_consent_by     uuid REFERENCES users (id) ON DELETE SET NULL,
  guardian_consent_at     timestamptz,
  guardian_consent_note   text,
  supporting_document_id  uuid,
  approved_by             uuid REFERENCES users (id) ON DELETE SET NULL,
  approved_at             timestamptz,
  rejection_reason        text,
  created_by              uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT med_auth_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT med_auth_learner_fk FOREIGN KEY (learner_id, tenant_id) REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT med_auth_doc_fk FOREIGN KEY (supporting_document_id, tenant_id) REFERENCES storage_objects (id, tenant_id) ON DELETE SET NULL (supporting_document_id),
  CONSTRAINT med_auth_dates_chk CHECK (end_date >= start_date),
  CONSTRAINT med_auth_status_chk CHECK (status IN ('draft', 'pending_consent', 'approved', 'rejected', 'expired', 'revoked')),
  CONSTRAINT med_auth_consent_chk CHECK (guardian_consent_status IN ('pending', 'granted', 'declined', 'revoked')),
  CONSTRAINT med_auth_route_chk CHECK (route IN ('oral', 'topical', 'inhaled', 'ophthalmic', 'otic', 'injection', 'other')),
  CONSTRAINT med_auth_name_len CHECK (char_length(btrim(medication_name)) BETWEEN 1 AND 200),
  CONSTRAINT med_auth_dosage_len CHECK (char_length(btrim(dosage_instruction)) BETWEEN 1 AND 200),
  CONSTRAINT med_auth_freq_len CHECK (char_length(btrim(frequency_instruction)) BETWEEN 1 AND 200)
);

CREATE INDEX med_auth_tenant_learner_idx ON medication_authorizations (tenant_id, learner_id, created_at DESC, id);

-- Guard: an authorization can NEVER be approved without explicit guardian consent
CREATE FUNCTION public.medication_authorizations_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.status = 'approved' AND NEW.guardian_consent_status <> 'granted' THEN
    RAISE EXCEPTION 'Medication authorization cannot be approved without explicit guardian consent' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.medication_authorizations_guard() FROM PUBLIC;

CREATE TRIGGER medication_authorizations_guard BEFORE INSERT OR UPDATE ON medication_authorizations
  FOR EACH ROW EXECUTE FUNCTION public.medication_authorizations_guard();

ALTER TABLE medication_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE medication_authorizations FORCE ROW LEVEL SECURITY;
CREATE POLICY medication_authorizations_tenant ON medication_authorizations FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY medication_authorizations_owner ON medication_authorizations FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'medication_authorizations'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'medication_authorizations'));

GRANT SELECT, INSERT ON medication_authorizations TO figbloom_app;
GRANT UPDATE (status, guardian_consent_status, guardian_consent_by, guardian_consent_at, guardian_consent_note, supporting_document_id, approved_by, approved_at, rejection_reason, updated_at) ON medication_authorizations TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON medication_authorizations FROM figbloom_app;

-- 3. Medication Schedules (only allowed for approved + consented authorizations)
CREATE TABLE medication_schedules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  authorization_id uuid NOT NULL,
  learner_id       uuid NOT NULL,
  schedule_times   text[] NOT NULL,
  window_minutes   integer NOT NULL DEFAULT 30,
  active           boolean NOT NULL DEFAULT true,
  cancelled_at     timestamptz,
  cancelled_reason text,
  created_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT med_sched_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT med_sched_auth_fk FOREIGN KEY (authorization_id, tenant_id) REFERENCES medication_authorizations (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT med_sched_learner_fk FOREIGN KEY (learner_id, tenant_id) REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT med_sched_times_chk CHECK (cardinality(schedule_times) BETWEEN 1 AND 12),
  CONSTRAINT med_sched_window_chk CHECK (window_minutes BETWEEN 5 AND 180)
);

CREATE INDEX med_sched_tenant_learner_idx ON medication_schedules (tenant_id, learner_id, active);

CREATE FUNCTION public.medication_schedules_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_auth public.medication_authorizations%ROWTYPE;
  v_active boolean;
BEGIN
  IF NEW.active THEN
    SELECT * INTO v_auth FROM public.medication_authorizations WHERE id = NEW.authorization_id AND tenant_id = NEW.tenant_id;
    IF NOT FOUND OR v_auth.status <> 'approved' OR v_auth.guardian_consent_status <> 'granted' THEN
      RAISE EXCEPTION 'Cannot activate a schedule for an unapproved or unconsented medication authorization' USING ERRCODE = '23514';
    END IF;
    IF v_auth.learner_id IS DISTINCT FROM NEW.learner_id THEN
      RAISE EXCEPTION 'Schedule learner must match authorization learner' USING ERRCODE = '23514';
    END IF;
    SELECT (archived_at IS NULL AND active = true) INTO v_active FROM public.learners WHERE id = NEW.learner_id AND tenant_id = NEW.tenant_id;
    IF NOT COALESCE(v_active, false) THEN
      RAISE EXCEPTION 'Cannot schedule medication for an inactive or archived learner' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.medication_schedules_guard() FROM PUBLIC;

CREATE TRIGGER medication_schedules_guard BEFORE INSERT OR UPDATE ON medication_schedules
  FOR EACH ROW EXECUTE FUNCTION public.medication_schedules_guard();

ALTER TABLE medication_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE medication_schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY medication_schedules_tenant ON medication_schedules FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY medication_schedules_owner ON medication_schedules FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'medication_schedules'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'medication_schedules'));

GRANT SELECT, INSERT ON medication_schedules TO figbloom_app;
GRANT UPDATE (active, cancelled_at, cancelled_reason) ON medication_schedules TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON medication_schedules FROM figbloom_app;

-- 4. Medication Administration Records (MAR — append-only, immutable, idempotent per schedule+slot)
CREATE TABLE medication_administration_records (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  schedule_id      uuid NOT NULL,
  authorization_id uuid NOT NULL,
  learner_id       uuid NOT NULL,
  scheduled_for    timestamptz NOT NULL,
  administered_at  timestamptz,
  administered_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  outcome          text NOT NULL,
  exception_reason text,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mar_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT mar_schedule_slot_uniq UNIQUE (schedule_id, scheduled_for),
  CONSTRAINT mar_schedule_fk FOREIGN KEY (schedule_id, tenant_id) REFERENCES medication_schedules (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT mar_auth_fk FOREIGN KEY (authorization_id, tenant_id) REFERENCES medication_authorizations (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT mar_learner_fk FOREIGN KEY (learner_id, tenant_id) REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT mar_outcome_chk CHECK (outcome IN ('administered', 'missed', 'delayed', 'refused', 'held', 'exception')),
  CONSTRAINT mar_exception_req_chk CHECK (
    outcome = 'administered' OR (exception_reason IS NOT NULL AND char_length(btrim(exception_reason)) >= 3)
  )
);

CREATE INDEX mar_tenant_learner_idx ON medication_administration_records (tenant_id, learner_id, scheduled_for DESC, id);

ALTER TABLE medication_administration_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE medication_administration_records FORCE ROW LEVEL SECURITY;
CREATE POLICY mar_tenant ON medication_administration_records FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY mar_owner ON medication_administration_records FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'medication_administration_records'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'medication_administration_records'));

-- Append-only: NO UPDATE or DELETE grant for figbloom_app! Corrections go to medication_administration_corrections.
GRANT SELECT, INSERT ON medication_administration_records TO figbloom_app;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON medication_administration_records FROM figbloom_app;

-- 5. Auditable MAR Corrections (append-only)
CREATE TABLE medication_administration_corrections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  mar_id            uuid NOT NULL,
  corrected_outcome text NOT NULL,
  correction_reason text NOT NULL,
  corrected_by      uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mar_corr_mar_fk FOREIGN KEY (mar_id, tenant_id) REFERENCES medication_administration_records (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT mar_corr_outcome_chk CHECK (corrected_outcome IN ('administered', 'missed', 'delayed', 'refused', 'held', 'exception')),
  CONSTRAINT mar_corr_reason_len CHECK (char_length(btrim(correction_reason)) BETWEEN 3 AND 500)
);

CREATE INDEX mar_corr_mar_idx ON medication_administration_corrections (tenant_id, mar_id, created_at ASC);

ALTER TABLE medication_administration_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE medication_administration_corrections FORCE ROW LEVEL SECURITY;
CREATE POLICY mar_corr_tenant ON medication_administration_corrections FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY mar_corr_owner ON medication_administration_corrections FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'medication_administration_corrections'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'medication_administration_corrections'));

GRANT SELECT, INSERT ON medication_administration_corrections TO figbloom_app;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON medication_administration_corrections FROM figbloom_app;

-- 6. Medication Incidents
CREATE TABLE medication_incidents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  learner_id       uuid NOT NULL,
  authorization_id uuid,
  mar_id           uuid,
  severity         text NOT NULL,
  summary          text NOT NULL,
  reported_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  acknowledged_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  acknowledged_at  timestamptz,
  resolution_note  text,
  resolved_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT med_inc_learner_fk FOREIGN KEY (learner_id, tenant_id) REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT med_inc_auth_fk FOREIGN KEY (authorization_id, tenant_id) REFERENCES medication_authorizations (id, tenant_id) ON DELETE SET NULL (authorization_id),
  CONSTRAINT med_inc_mar_fk FOREIGN KEY (mar_id, tenant_id) REFERENCES medication_administration_records (id, tenant_id) ON DELETE SET NULL (mar_id),
  CONSTRAINT med_inc_sev_chk CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  CONSTRAINT med_inc_summary_len CHECK (char_length(btrim(summary)) BETWEEN 3 AND 1000)
);

CREATE INDEX med_inc_tenant_idx ON medication_incidents (tenant_id, created_at DESC, id);

ALTER TABLE medication_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE medication_incidents FORCE ROW LEVEL SECURITY;
CREATE POLICY med_inc_tenant ON medication_incidents FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY med_inc_owner ON medication_incidents FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'medication_incidents'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'medication_incidents'));

GRANT SELECT, INSERT ON medication_incidents TO figbloom_app;
GRANT UPDATE (acknowledged_by, acknowledged_at, resolution_note, resolved_at) ON medication_incidents TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON medication_incidents FROM figbloom_app;
