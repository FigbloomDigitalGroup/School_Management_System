-- WS-6: Academics & CBC depth:
-- 1. Criterion-level rubric sub-scores on rubric_descriptor_configs + cbe_results + cbe_result_revisions
-- 2. Timetable publication & versioning (timetable_publications)
-- 3. Progressive KICD public learning-area catalogue (honest unverified provenance)
-- 4. Online-exam objective auto-marking (questions on papers, answers + auto_marked on attempts)
-- Forward-only. Preserves all migrations 001–083.

-- ---------------------------------------------------------------- 1. Criterion-level rubric sub-scores
ALTER TABLE rubric_descriptor_configs
  ADD COLUMN criteria jsonb;

ALTER TABLE rubric_descriptor_configs
  ADD CONSTRAINT rubric_descriptor_configs_criteria_chk CHECK (
    criteria IS NULL OR jsonb_typeof(criteria) = 'array'
  );

GRANT UPDATE (name, version, descriptors, scoring_mode, criteria) ON rubric_descriptor_configs TO figbloom_app;

ALTER TABLE cbe_results
  ADD COLUMN criterion_scores jsonb;

ALTER TABLE cbe_results
  ADD CONSTRAINT cbe_results_criterion_scores_chk CHECK (
    criterion_scores IS NULL OR jsonb_typeof(criterion_scores) = 'array'
  );

GRANT UPDATE (
  level_code, points, marked_at, marked_by, row_version,
  observation, teacher_feedback, evidence_asset_id, completion_status, criterion_scores
) ON cbe_results TO figbloom_app;

ALTER TABLE cbe_result_revisions
  ADD COLUMN previous_criterion_scores jsonb,
  ADD COLUMN new_criterion_scores jsonb;

-- ---------------------------------------------------------------- 2. Timetable publication & versioning
CREATE TABLE timetable_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  academic_year_id uuid NOT NULL,
  term_id uuid,
  class_id uuid NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL DEFAULT 'draft',
  slots_snapshot jsonb NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  published_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT timetable_publications_year_fk FOREIGN KEY (academic_year_id, tenant_id)
    REFERENCES academic_years (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT timetable_publications_term_fk FOREIGN KEY (term_id, tenant_id)
    REFERENCES academic_terms (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT timetable_publications_class_fk FOREIGN KEY (class_id, tenant_id)
    REFERENCES classes (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT timetable_publications_status_chk CHECK (status IN ('draft', 'published')),
  CONSTRAINT timetable_publications_snapshot_chk CHECK (jsonb_typeof(slots_snapshot) = 'array'),
  CONSTRAINT timetable_publications_status_ts_chk CHECK (
    (status = 'draft' AND published_at IS NULL)
    OR (status = 'published' AND published_at IS NOT NULL)
  ),
  CONSTRAINT timetable_publications_uniq UNIQUE (tenant_id, class_id, version)
);

CREATE INDEX timetable_publications_class_idx
  ON timetable_publications (tenant_id, class_id, version DESC);

ALTER TABLE timetable_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE timetable_publications FORCE ROW LEVEL SECURITY;

CREATE POLICY timetable_publications_tenant ON timetable_publications
  FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY timetable_publications_owner ON timetable_publications
  FOR ALL TO PUBLIC
  USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'timetable_publications'
  ))
  WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'timetable_publications'
  ));

GRANT SELECT, INSERT ON timetable_publications TO figbloom_app;
GRANT UPDATE (status, published_by, published_at) ON timetable_publications TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON timetable_publications FROM figbloom_app;

-- ---------------------------------------------------------------- 3. Progressive KICD public learning-area catalogue
INSERT INTO curriculum_reference_entries (
  provenance_id, entry_kind, code, title, education_level, grade_band, pathway,
  source_organisation, source_title, source_uri, publication_or_version, retrieved_at,
  verification_status, known_limitations
) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'learning_area', 'kicd_pp_language',
   'Language Activities', 'pre_primary', 'PP1-PP2', NULL,
   'Kenya Institute of Curriculum Development (KICD)',
   'Basic Education Curriculum Framework — Pre-Primary Learning Areas',
   'https://kicd.ac.ke/curriculum-reform/competency-based-curriculum/',
   'progressive-reference-2026-11', DATE '2026-11-21', 'unverified',
   'Public framework learning-area title only; strands and specific learning outcomes are not seeded.'),
  ('a1000000-0000-4000-8000-000000000001', 'learning_area', 'kicd_pp_math',
   'Mathematical Activities', 'pre_primary', 'PP1-PP2', NULL,
   'Kenya Institute of Curriculum Development (KICD)',
   'Basic Education Curriculum Framework — Pre-Primary Learning Areas',
   'https://kicd.ac.ke/curriculum-reform/competency-based-curriculum/',
   'progressive-reference-2026-11', DATE '2026-11-21', 'unverified',
   'Public framework learning-area title only; strands and specific learning outcomes are not seeded.'),
  ('a1000000-0000-4000-8000-000000000001', 'learning_area', 'kicd_pri_english',
   'English', 'primary', 'Grade 1-6', NULL,
   'Kenya Institute of Curriculum Development (KICD)',
   'Basic Education Curriculum Framework — Primary Learning Areas',
   'https://kicd.ac.ke/curriculum-reform/competency-based-curriculum/',
   'progressive-reference-2026-11', DATE '2026-11-21', 'unverified',
   'Public framework learning-area title only; strands and specific learning outcomes are not seeded.'),
  ('a1000000-0000-4000-8000-000000000001', 'learning_area', 'kicd_pri_kiswahili',
   'Kiswahili', 'primary', 'Grade 1-6', NULL,
   'Kenya Institute of Curriculum Development (KICD)',
   'Basic Education Curriculum Framework — Primary Learning Areas',
   'https://kicd.ac.ke/curriculum-reform/competency-based-curriculum/',
   'progressive-reference-2026-11', DATE '2026-11-21', 'unverified',
   'Public framework learning-area title only; strands and specific learning outcomes are not seeded.'),
  ('a1000000-0000-4000-8000-000000000001', 'learning_area', 'kicd_pri_math',
   'Mathematics', 'primary', 'Grade 1-6', NULL,
   'Kenya Institute of Curriculum Development (KICD)',
   'Basic Education Curriculum Framework — Primary Learning Areas',
   'https://kicd.ac.ke/curriculum-reform/competency-based-curriculum/',
   'progressive-reference-2026-11', DATE '2026-11-21', 'unverified',
   'Public framework learning-area title only; strands and specific learning outcomes are not seeded.'),
  ('a1000000-0000-4000-8000-000000000001', 'learning_area', 'kicd_pri_science_tech',
   'Science and Technology', 'primary', 'Grade 4-6', NULL,
   'Kenya Institute of Curriculum Development (KICD)',
   'Basic Education Curriculum Framework — Upper Primary Learning Areas',
   'https://kicd.ac.ke/curriculum-reform/competency-based-curriculum/',
   'progressive-reference-2026-11', DATE '2026-11-21', 'unverified',
   'Public framework learning-area title only; strands and specific learning outcomes are not seeded.'),
  ('a1000000-0000-4000-8000-000000000001', 'learning_area', 'kicd_js_integrated_science',
   'Integrated Science', 'junior_secondary', 'Grade 7-9', NULL,
   'Kenya Institute of Curriculum Development (KICD)',
   'Basic Education Curriculum Framework — Junior School Learning Areas',
   'https://kicd.ac.ke/curriculum-reform/competency-based-curriculum/',
   'progressive-reference-2026-11', DATE '2026-11-21', 'unverified',
   'Public framework learning-area title only; strands and specific learning outcomes are not seeded.'),
  ('a1000000-0000-4000-8000-000000000001', 'learning_area', 'kicd_js_social_studies',
   'Social Studies', 'junior_secondary', 'Grade 7-9', NULL,
   'Kenya Institute of Curriculum Development (KICD)',
   'Basic Education Curriculum Framework — Junior School Learning Areas',
   'https://kicd.ac.ke/curriculum-reform/competency-based-curriculum/',
   'progressive-reference-2026-11', DATE '2026-11-21', 'unverified',
   'Public framework learning-area title only; strands and specific learning outcomes are not seeded.'),
  ('a1000000-0000-4000-8000-000000000001', 'learning_area', 'kicd_ss_csl',
   'Community Service Learning', 'senior_school', 'Grade 10-12', NULL,
   'Kenya Institute of Curriculum Development (KICD)',
   'Basic Education Curriculum Framework — Senior School Core Learning Areas',
   'https://kicd.ac.ke/curriculum-reform/competency-based-curriculum/',
   'progressive-reference-2026-11', DATE '2026-11-21', 'unverified',
   'Public framework learning-area title only; strands and specific learning outcomes are not seeded.')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- 4. Online-exam objective auto-marking
ALTER TABLE online_exam_papers
  ADD COLUMN questions jsonb;

ALTER TABLE online_exam_papers
  ADD CONSTRAINT online_exam_papers_questions_chk CHECK (
    questions IS NULL OR jsonb_typeof(questions) = 'array'
  );

ALTER TABLE online_exam_attempts
  ADD COLUMN answers jsonb,
  ADD COLUMN auto_marked boolean NOT NULL DEFAULT false;

ALTER TABLE online_exam_attempts
  ADD CONSTRAINT online_exam_attempts_answers_chk CHECK (
    answers IS NULL OR jsonb_typeof(answers) = 'object'
  );

GRANT UPDATE (status, submitted_at, answers, auto_marked) ON online_exam_attempts TO figbloom_app;
