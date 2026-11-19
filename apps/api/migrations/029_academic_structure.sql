-- Stage 9 — Academic structure foundations (years, terms, classes, subjects,
-- class membership, teaching assignments, timetable slots).
-- Forward-only. Migrations 001–028 are not edited.
-- Directory continues to own learners/staff; this module references them.
-- Does not seed curriculum catalogue content (D-5 provenance remains open).

INSERT INTO permissions (code, description) VALUES
  ('resource.academics.read', 'Read academic structure, assessments and CBC records in tenant'),
  ('resource.academics.write', 'Create and update academic structure, assessments and CBC records in tenant')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'resource.academics.read'),
  ('school_admin', 'resource.academics.write')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- academic years
CREATE TABLE academic_years (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  label text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  is_current boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT academic_years_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT academic_years_label_len CHECK (char_length(trim(label)) BETWEEN 1 AND 32),
  CONSTRAINT academic_years_range CHECK (ends_on >= starts_on)
);

CREATE UNIQUE INDEX academic_years_tenant_label_uidx
  ON academic_years (tenant_id, lower(trim(label)));

-- At most one current year per tenant.
CREATE UNIQUE INDEX academic_years_tenant_current_uidx
  ON academic_years (tenant_id)
  WHERE is_current = true;

CREATE INDEX academic_years_tenant_id_idx ON academic_years (tenant_id);

ALTER TABLE academic_years ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic_years FORCE ROW LEVEL SECURITY;

CREATE POLICY academic_years_tenant ON academic_years
  FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY academic_years_owner ON academic_years
  FOR ALL TO PUBLIC
  USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'academic_years'
  ))
  WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'academic_years'
  ));

GRANT SELECT, INSERT ON academic_years TO figbloom_app;
GRANT UPDATE (label, starts_on, ends_on, is_current, updated_at) ON academic_years TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON academic_years FROM figbloom_app;

-- ---------------------------------------------------------------- terms
CREATE TABLE academic_terms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  academic_year_id uuid NOT NULL,
  index smallint NOT NULL,
  label text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  is_current boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT academic_terms_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT academic_terms_year_fk
    FOREIGN KEY (academic_year_id, tenant_id)
    REFERENCES academic_years (id, tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT academic_terms_index_range CHECK (index BETWEEN 1 AND 4),
  CONSTRAINT academic_terms_label_len CHECK (char_length(trim(label)) BETWEEN 1 AND 64),
  CONSTRAINT academic_terms_range CHECK (ends_on >= starts_on)
);

CREATE UNIQUE INDEX academic_terms_year_index_uidx
  ON academic_terms (tenant_id, academic_year_id, index);

CREATE UNIQUE INDEX academic_terms_tenant_current_uidx
  ON academic_terms (tenant_id)
  WHERE is_current = true;

CREATE INDEX academic_terms_tenant_year_idx
  ON academic_terms (tenant_id, academic_year_id);

ALTER TABLE academic_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE academic_terms FORCE ROW LEVEL SECURITY;

CREATE POLICY academic_terms_tenant ON academic_terms
  FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY academic_terms_owner ON academic_terms
  FOR ALL TO PUBLIC
  USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'academic_terms'
  ))
  WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'academic_terms'
  ));

GRANT SELECT, INSERT ON academic_terms TO figbloom_app;
GRANT UPDATE (label, starts_on, ends_on, is_current, updated_at) ON academic_terms TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON academic_terms FROM figbloom_app;

-- ---------------------------------------------------------------- subjects
CREATE TABLE subjects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  code text NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subjects_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT subjects_code_len CHECK (char_length(trim(code)) BETWEEN 1 AND 32),
  CONSTRAINT subjects_name_len CHECK (char_length(trim(name)) BETWEEN 1 AND 120),
  CONSTRAINT subjects_archive_consistency CHECK (
    (active = true AND archived_at IS NULL)
    OR (active = false AND archived_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX subjects_tenant_code_uidx
  ON subjects (tenant_id, lower(trim(code)));

CREATE INDEX subjects_tenant_active_name_idx
  ON subjects (tenant_id, active, lower(name));

ALTER TABLE subjects ENABLE ROW LEVEL SECURITY;
ALTER TABLE subjects FORCE ROW LEVEL SECURITY;

CREATE POLICY subjects_tenant ON subjects
  FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY subjects_owner ON subjects
  FOR ALL TO PUBLIC
  USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'subjects'
  ))
  WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'subjects'
  ));

GRANT SELECT, INSERT ON subjects TO figbloom_app;
GRANT UPDATE (code, name, active, archived_at, updated_at) ON subjects TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON subjects FROM figbloom_app;

-- ---------------------------------------------------------------- classes (ClassGroup)
CREATE TABLE classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  academic_year_id uuid NOT NULL,
  name text NOT NULL,
  form_level smallint,
  stream text,
  class_teacher_staff_id uuid,
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT classes_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT classes_year_fk
    FOREIGN KEY (academic_year_id, tenant_id)
    REFERENCES academic_years (id, tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT classes_teacher_fk
    FOREIGN KEY (class_teacher_staff_id, tenant_id)
    REFERENCES staff_members (id, tenant_id)
    ON DELETE SET NULL,
  CONSTRAINT classes_name_len CHECK (char_length(trim(name)) BETWEEN 1 AND 64),
  CONSTRAINT classes_stream_len CHECK (stream IS NULL OR char_length(trim(stream)) BETWEEN 1 AND 32),
  CONSTRAINT classes_form_level_range CHECK (form_level IS NULL OR form_level BETWEEN 1 AND 12),
  CONSTRAINT classes_archive_consistency CHECK (
    (active = true AND archived_at IS NULL)
    OR (active = false AND archived_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX classes_tenant_year_name_uidx
  ON classes (tenant_id, academic_year_id, lower(trim(name)));

CREATE INDEX classes_tenant_year_idx ON classes (tenant_id, academic_year_id);
CREATE INDEX classes_tenant_teacher_idx ON classes (tenant_id, class_teacher_staff_id)
  WHERE class_teacher_staff_id IS NOT NULL;

ALTER TABLE classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE classes FORCE ROW LEVEL SECURITY;

CREATE POLICY classes_tenant ON classes
  FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY classes_owner ON classes
  FOR ALL TO PUBLIC
  USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'classes'
  ))
  WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'classes'
  ));

GRANT SELECT, INSERT ON classes TO figbloom_app;
GRANT UPDATE (
  name, form_level, stream, class_teacher_staff_id, active, archived_at, updated_at
) ON classes TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON classes FROM figbloom_app;

-- ---------------------------------------------------------------- class membership (learner ↔ class)
CREATE TABLE class_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  learner_id uuid NOT NULL,
  class_id uuid NOT NULL,
  academic_year_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT class_memberships_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT class_memberships_learner_fk
    FOREIGN KEY (learner_id, tenant_id)
    REFERENCES learners (id, tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT class_memberships_class_fk
    FOREIGN KEY (class_id, tenant_id)
    REFERENCES classes (id, tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT class_memberships_year_fk
    FOREIGN KEY (academic_year_id, tenant_id)
    REFERENCES academic_years (id, tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT class_memberships_archive_consistency CHECK (
    (active = true AND archived_at IS NULL)
    OR (active = false AND archived_at IS NOT NULL)
  )
);

-- One active membership per learner per academic year.
CREATE UNIQUE INDEX class_memberships_learner_year_active_uidx
  ON class_memberships (tenant_id, learner_id, academic_year_id)
  WHERE active = true;

CREATE UNIQUE INDEX class_memberships_learner_class_year_uidx
  ON class_memberships (tenant_id, learner_id, class_id, academic_year_id);

CREATE INDEX class_memberships_class_active_idx
  ON class_memberships (tenant_id, class_id)
  WHERE active = true;

ALTER TABLE class_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_memberships FORCE ROW LEVEL SECURITY;

CREATE POLICY class_memberships_tenant ON class_memberships
  FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY class_memberships_owner ON class_memberships
  FOR ALL TO PUBLIC
  USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'class_memberships'
  ))
  WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'class_memberships'
  ));

GRANT SELECT, INSERT ON class_memberships TO figbloom_app;
GRANT UPDATE (active, archived_at, updated_at) ON class_memberships TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON class_memberships FROM figbloom_app;

-- Membership must target a class in the same academic year; learner must be active.
CREATE OR REPLACE FUNCTION public.class_memberships_integrity_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_class_year uuid;
  v_learner_active boolean;
BEGIN
  SELECT c.academic_year_id INTO v_class_year
  FROM public.classes c
  WHERE c.id = NEW.class_id AND c.tenant_id = NEW.tenant_id;

  IF v_class_year IS NULL THEN
    RAISE EXCEPTION 'class membership references unknown class' USING ERRCODE = '23503';
  END IF;
  IF v_class_year IS DISTINCT FROM NEW.academic_year_id THEN
    RAISE EXCEPTION 'class membership academic year must match the class year' USING ERRCODE = '23514';
  END IF;

  SELECT l.active INTO v_learner_active
  FROM public.learners l
  WHERE l.id = NEW.learner_id AND l.tenant_id = NEW.tenant_id;

  IF v_learner_active IS NULL THEN
    RAISE EXCEPTION 'class membership references unknown learner' USING ERRCODE = '23503';
  END IF;
  IF NEW.active = true AND v_learner_active IS NOT TRUE THEN
    RAISE EXCEPTION 'cannot assign an inactive learner to a class' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.class_memberships_integrity_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.class_memberships_integrity_guard() FROM figbloom_app;

CREATE TRIGGER class_memberships_integrity_biu
  BEFORE INSERT OR UPDATE OF learner_id, class_id, academic_year_id, tenant_id, active
  ON class_memberships
  FOR EACH ROW
  EXECUTE FUNCTION public.class_memberships_integrity_guard();

-- ---------------------------------------------------------------- teaching assignments
CREATE TABLE teaching_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  staff_member_id uuid NOT NULL,
  class_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT teaching_assignments_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT teaching_assignments_staff_fk
    FOREIGN KEY (staff_member_id, tenant_id)
    REFERENCES staff_members (id, tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT teaching_assignments_class_fk
    FOREIGN KEY (class_id, tenant_id)
    REFERENCES classes (id, tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT teaching_assignments_subject_fk
    FOREIGN KEY (subject_id, tenant_id)
    REFERENCES subjects (id, tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT teaching_assignments_archive_consistency CHECK (
    (active = true AND archived_at IS NULL)
    OR (active = false AND archived_at IS NOT NULL)
  )
);

-- One active teacher per class+subject (legacy unique key preserved).
CREATE UNIQUE INDEX teaching_assignments_class_subject_active_uidx
  ON teaching_assignments (tenant_id, class_id, subject_id)
  WHERE active = true;

CREATE INDEX teaching_assignments_staff_idx
  ON teaching_assignments (tenant_id, staff_member_id)
  WHERE active = true;

ALTER TABLE teaching_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE teaching_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY teaching_assignments_tenant ON teaching_assignments
  FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY teaching_assignments_owner ON teaching_assignments
  FOR ALL TO PUBLIC
  USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'teaching_assignments'
  ))
  WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'teaching_assignments'
  ));

GRANT SELECT, INSERT ON teaching_assignments TO figbloom_app;
GRANT UPDATE (staff_member_id, active, archived_at, updated_at) ON teaching_assignments TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON teaching_assignments FROM figbloom_app;

-- ---------------------------------------------------------------- timetable slots
CREATE TABLE timetable_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  class_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  teaching_assignment_id uuid,
  day_of_week smallint NOT NULL,
  starts_at time NOT NULL,
  ends_at time NOT NULL,
  room text,
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT timetable_slots_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT timetable_slots_class_fk
    FOREIGN KEY (class_id, tenant_id)
    REFERENCES classes (id, tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT timetable_slots_subject_fk
    FOREIGN KEY (subject_id, tenant_id)
    REFERENCES subjects (id, tenant_id)
    ON DELETE RESTRICT,
  CONSTRAINT timetable_slots_assignment_fk
    FOREIGN KEY (teaching_assignment_id, tenant_id)
    REFERENCES teaching_assignments (id, tenant_id)
    ON DELETE SET NULL,
  CONSTRAINT timetable_slots_dow CHECK (day_of_week BETWEEN 1 AND 7),
  CONSTRAINT timetable_slots_time_order CHECK (ends_at > starts_at),
  CONSTRAINT timetable_slots_room_len CHECK (room IS NULL OR char_length(trim(room)) BETWEEN 1 AND 64),
  CONSTRAINT timetable_slots_archive_consistency CHECK (
    (active = true AND archived_at IS NULL)
    OR (active = false AND archived_at IS NOT NULL)
  )
);

CREATE INDEX timetable_slots_class_dow_idx
  ON timetable_slots (tenant_id, class_id, day_of_week)
  WHERE active = true;

ALTER TABLE timetable_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE timetable_slots FORCE ROW LEVEL SECURITY;

CREATE POLICY timetable_slots_tenant ON timetable_slots
  FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY timetable_slots_owner ON timetable_slots
  FOR ALL TO PUBLIC
  USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'timetable_slots'
  ))
  WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'timetable_slots'
  ));

GRANT SELECT, INSERT ON timetable_slots TO figbloom_app;
GRANT UPDATE (
  subject_id, teaching_assignment_id, day_of_week, starts_at, ends_at, room,
  active, archived_at, updated_at
) ON timetable_slots TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON timetable_slots FROM figbloom_app;
