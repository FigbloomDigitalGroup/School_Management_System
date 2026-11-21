-- Stage 9 — Higher-education course records and a minimal online assessment.
-- Forward-only. Migrations 001–031 are not edited.
--
-- he_* rows are only written by the application when
-- school_profiles.institution_type = 'higher_ed'. The database does not
-- duplicate that rule (the profile may be updated later); the API refuses
-- the write otherwise. Online exam papers are available to any school.

CREATE TABLE he_courses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  code text NOT NULL,
  title text NOT NULL,
  credit_hours numeric NOT NULL DEFAULT 3,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT he_courses_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT he_courses_code_len CHECK (char_length(trim(code)) BETWEEN 1 AND 32),
  CONSTRAINT he_courses_title_len CHECK (char_length(trim(title)) BETWEEN 1 AND 160),
  CONSTRAINT he_courses_credits_chk CHECK (credit_hours > 0 AND credit_hours <= 60)
);

CREATE UNIQUE INDEX he_courses_tenant_code_uidx ON he_courses (tenant_id, lower(trim(code)));

CREATE TABLE he_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  course_id uuid NOT NULL,
  term_id uuid NOT NULL,
  label text NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT he_sections_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT he_sections_course_fk FOREIGN KEY (course_id, tenant_id)
    REFERENCES he_courses (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT he_sections_term_fk FOREIGN KEY (term_id, tenant_id)
    REFERENCES academic_terms (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT he_sections_label_len CHECK (char_length(trim(label)) BETWEEN 1 AND 32)
);

CREATE UNIQUE INDEX he_sections_course_term_label_uidx
  ON he_sections (tenant_id, course_id, term_id, lower(trim(label)));

CREATE TABLE he_enrolments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  section_id uuid NOT NULL,
  learner_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'enrolled',
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT he_enrolments_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT he_enrolments_section_learner_uidx UNIQUE (section_id, learner_id),
  CONSTRAINT he_enrolments_section_fk FOREIGN KEY (section_id, tenant_id)
    REFERENCES he_sections (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT he_enrolments_learner_fk FOREIGN KEY (learner_id, tenant_id)
    REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT he_enrolments_status_chk CHECK (status IN ('enrolled', 'withdrawn'))
);

CREATE TABLE he_grades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  enrolment_id uuid NOT NULL,
  score numeric NOT NULL,
  grade text,
  graded_at timestamptz NOT NULL DEFAULT now(),
  graded_by uuid REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT he_grades_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT he_grades_enrolment_fk FOREIGN KEY (enrolment_id, tenant_id)
    REFERENCES he_enrolments (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT he_grades_score_chk CHECK (score >= 0 AND score <= 10000),
  CONSTRAINT he_grades_grade_len CHECK (grade IS NULL OR char_length(trim(grade)) BETWEEN 1 AND 16)
);

CREATE INDEX he_grades_enrolment_idx ON he_grades (tenant_id, enrolment_id);

CREATE TABLE online_exam_papers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  class_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  title text NOT NULL,
  max_score numeric NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT online_exam_papers_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT online_exam_papers_class_fk FOREIGN KEY (class_id, tenant_id)
    REFERENCES classes (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT online_exam_papers_subject_fk FOREIGN KEY (subject_id, tenant_id)
    REFERENCES subjects (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT online_exam_papers_title_len CHECK (char_length(trim(title)) BETWEEN 1 AND 160),
  CONSTRAINT online_exam_papers_max_chk CHECK (max_score > 0 AND max_score <= 10000)
);

CREATE TABLE online_exam_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  paper_id uuid NOT NULL,
  learner_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'in_progress',
  submitted_at timestamptz,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT online_exam_attempts_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT online_exam_attempts_paper_fk FOREIGN KEY (paper_id, tenant_id)
    REFERENCES online_exam_papers (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT online_exam_attempts_learner_fk FOREIGN KEY (learner_id, tenant_id)
    REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT online_exam_attempts_status_chk CHECK (status IN ('in_progress', 'submitted')),
  CONSTRAINT online_exam_attempts_submitted_chk CHECK (
    (status = 'in_progress' AND submitted_at IS NULL)
    OR (status = 'submitted' AND submitted_at IS NOT NULL)
  )
);

CREATE INDEX online_exam_attempts_paper_idx ON online_exam_attempts (tenant_id, paper_id);

CREATE TABLE attempt_marks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  attempt_id uuid NOT NULL,
  score numeric NOT NULL,
  marked_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attempt_marks_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT attempt_marks_attempt_uidx UNIQUE (attempt_id),
  CONSTRAINT attempt_marks_attempt_fk FOREIGN KEY (attempt_id, tenant_id)
    REFERENCES online_exam_attempts (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT attempt_marks_score_chk CHECK (score >= 0 AND score <= 10000)
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'he_courses', 'he_sections', 'he_enrolments', 'he_grades',
    'online_exam_papers', 'online_exam_attempts', 'attempt_marks'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO figbloom_app USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())',
      t || '_tenant', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I FOR ALL TO PUBLIC
      USING (current_user = (
        SELECT pg_get_userbyid(c.relowner) FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = %L
      ))
      WITH CHECK (current_user = (
        SELECT pg_get_userbyid(c.relowner) FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = %L
      ))
    $f$, t || '_owner', t, t, t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO figbloom_app', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM figbloom_app', t);
  END LOOP;
END $$;

GRANT UPDATE (status, submitted_at) ON online_exam_attempts TO figbloom_app;
