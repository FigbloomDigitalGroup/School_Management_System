-- Stage 9 CBC/CBE engine completion. Forward-only.
-- Extends school-configured curriculum and assessment without claiming a complete
-- official KICD catalogue. Platform reference rows are progressive and must carry
-- honest provenance / verification_status. Migrations 001–078 are not edited.

-- ---------------------------------------------------------------- classes: education level + pathway
-- Mirrors packages/shared/src/levels.ts semantics: a year is (education_level, form_level).
ALTER TABLE classes
  ADD COLUMN education_level text,
  ADD COLUMN pathway text;

ALTER TABLE classes
  ADD CONSTRAINT classes_education_level_chk CHECK (
    education_level IS NULL
    OR education_level IN (
      'pre_primary', 'primary', 'junior_secondary', 'senior_school', 'secondary'
    )
  );

ALTER TABLE classes
  ADD CONSTRAINT classes_pathway_chk CHECK (
    pathway IS NULL
    OR pathway IN ('stem', 'social_sciences', 'arts_sports')
  );

ALTER TABLE classes
  ADD CONSTRAINT classes_level_year_chk CHECK (
    education_level IS NULL
    OR form_level IS NULL
    OR (
      (education_level = 'pre_primary' AND form_level BETWEEN 1 AND 2)
      OR (education_level = 'primary' AND form_level BETWEEN 1 AND 6)
      OR (education_level = 'junior_secondary' AND form_level BETWEEN 7 AND 9)
      OR (education_level = 'senior_school' AND form_level BETWEEN 10 AND 12)
      OR (education_level = 'secondary' AND form_level BETWEEN 1 AND 4)
    )
  );

ALTER TABLE classes
  ADD CONSTRAINT classes_pathway_senior_only_chk CHECK (
    pathway IS NULL OR education_level = 'senior_school'
  );

GRANT UPDATE (
  name, form_level, stream, class_teacher_staff_id, active, archived_at, updated_at,
  education_level, pathway
) ON classes TO figbloom_app;

-- ---------------------------------------------------------------- learning area metadata (school-configured)
ALTER TABLE learning_areas
  ADD COLUMN education_level text,
  ADD COLUMN min_grade smallint,
  ADD COLUMN max_grade smallint,
  ADD COLUMN pathway text,
  ADD COLUMN is_core boolean NOT NULL DEFAULT false;

ALTER TABLE learning_areas
  ADD CONSTRAINT learning_areas_education_level_chk CHECK (
    education_level IS NULL
    OR education_level IN (
      'pre_primary', 'primary', 'junior_secondary', 'senior_school', 'secondary'
    )
  );

ALTER TABLE learning_areas
  ADD CONSTRAINT learning_areas_pathway_chk CHECK (
    pathway IS NULL OR pathway IN ('stem', 'social_sciences', 'arts_sports')
  );

ALTER TABLE learning_areas
  ADD CONSTRAINT learning_areas_pathway_senior_only_chk CHECK (
    pathway IS NULL OR education_level = 'senior_school'
  );

ALTER TABLE learning_areas
  ADD CONSTRAINT learning_areas_grade_band_chk CHECK (
    (min_grade IS NULL AND max_grade IS NULL)
    OR (
      min_grade IS NOT NULL AND max_grade IS NOT NULL
      AND min_grade BETWEEN 1 AND 12 AND max_grade BETWEEN 1 AND 12
      AND min_grade <= max_grade
    )
  );

GRANT UPDATE (
  code, name, education_level, min_grade, max_grade, pathway, is_core
) ON learning_areas TO figbloom_app;

-- ---------------------------------------------------------------- rubric scoring mode (numerical vs level-only)
ALTER TABLE rubric_descriptor_configs
  ADD COLUMN scoring_mode text NOT NULL DEFAULT 'numerical';

ALTER TABLE rubric_descriptor_configs
  ADD CONSTRAINT rubric_descriptor_configs_scoring_mode_chk CHECK (
    scoring_mode IN ('numerical', 'level_only')
  );

GRANT UPDATE (name, version, descriptors, scoring_mode) ON rubric_descriptor_configs TO figbloom_app;

-- ---------------------------------------------------------------- CBE assessment lifecycle + instrument definition
ALTER TABLE cbe_assessments
  ADD COLUMN status text NOT NULL DEFAULT 'draft',
  ADD COLUMN instrument_type text NOT NULL DEFAULT 'rubric',
  ADD COLUMN assessment_date date,
  ADD COLUMN instructions text,
  ADD COLUMN strand_id uuid,
  ADD COLUMN sub_strand_id uuid,
  ADD COLUMN learning_outcome_id uuid,
  ADD COLUMN curriculum_version_label text,
  ADD COLUMN published_at timestamptz,
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN row_version integer NOT NULL DEFAULT 1;

ALTER TABLE cbe_assessments
  ADD CONSTRAINT cbe_assessments_status_chk CHECK (status IN ('draft', 'published', 'closed'));

ALTER TABLE cbe_assessments
  ADD CONSTRAINT cbe_assessments_instrument_chk CHECK (
    instrument_type IN (
      'test', 'observation', 'checklist', 'quiz', 'rubric', 'journal',
      'portfolio', 'learner_profile', 'anecdotal', 'rating_scale', 'project'
    )
  );

ALTER TABLE cbe_assessments
  ADD CONSTRAINT cbe_assessments_instructions_len CHECK (
    instructions IS NULL OR char_length(instructions) BETWEEN 1 AND 4000
  );

ALTER TABLE cbe_assessments
  ADD CONSTRAINT cbe_assessments_curriculum_version_len CHECK (
    curriculum_version_label IS NULL
    OR char_length(trim(curriculum_version_label)) BETWEEN 1 AND 80
  );

ALTER TABLE cbe_assessments
  ADD CONSTRAINT cbe_assessments_version_chk CHECK (row_version >= 1);

ALTER TABLE cbe_assessments
  ADD CONSTRAINT cbe_assessments_strand_fk FOREIGN KEY (strand_id, tenant_id)
    REFERENCES strands (id, tenant_id) ON DELETE RESTRICT;

ALTER TABLE cbe_assessments
  ADD CONSTRAINT cbe_assessments_sub_strand_fk FOREIGN KEY (sub_strand_id, tenant_id)
    REFERENCES sub_strands (id, tenant_id) ON DELETE RESTRICT;

ALTER TABLE cbe_assessments
  ADD CONSTRAINT cbe_assessments_outcome_fk FOREIGN KEY (learning_outcome_id, tenant_id)
    REFERENCES learning_outcomes (id, tenant_id) ON DELETE RESTRICT;

ALTER TABLE cbe_assessments
  ADD CONSTRAINT cbe_assessments_status_ts_chk CHECK (
    (status = 'draft' AND published_at IS NULL AND closed_at IS NULL)
    OR (status = 'published' AND published_at IS NOT NULL AND closed_at IS NULL)
    OR (status = 'closed' AND published_at IS NOT NULL AND closed_at IS NOT NULL)
  );

CREATE FUNCTION public.cbe_assessments_status_forward_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status = 'closed' AND NEW.status IS DISTINCT FROM 'closed' THEN
    RAISE EXCEPTION 'closed CBE assessments cannot return to draft or published'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'published' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'published CBE assessments cannot return to draft'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Lifecycle is draft → published → closed only (no draft→closed shortcut).
  IF OLD.status = 'draft' AND NEW.status = 'closed' THEN
    RAISE EXCEPTION 'draft CBE assessments must be published before they can be closed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.cbe_assessments_status_forward_only() FROM PUBLIC;

CREATE TRIGGER cbe_assessments_status_forward_only
  BEFORE UPDATE OF status ON cbe_assessments
  FOR EACH ROW
  EXECUTE FUNCTION public.cbe_assessments_status_forward_only();

GRANT UPDATE (
  title, rubric_config_id, status, instrument_type, assessment_date, instructions,
  strand_id, sub_strand_id, learning_outcome_id, curriculum_version_label,
  published_at, closed_at, row_version
) ON cbe_assessments TO figbloom_app;

-- ---------------------------------------------------------------- qualitative result fields
ALTER TABLE cbe_results
  ADD COLUMN observation text,
  ADD COLUMN teacher_feedback text,
  ADD COLUMN evidence_asset_id uuid,
  ADD COLUMN completion_status text NOT NULL DEFAULT 'recorded';

ALTER TABLE cbe_results
  ADD CONSTRAINT cbe_results_observation_len CHECK (
    observation IS NULL OR char_length(observation) BETWEEN 1 AND 4000
  );

ALTER TABLE cbe_results
  ADD CONSTRAINT cbe_results_feedback_len CHECK (
    teacher_feedback IS NULL OR char_length(teacher_feedback) BETWEEN 1 AND 4000
  );

ALTER TABLE cbe_results
  ADD CONSTRAINT cbe_results_completion_chk CHECK (
    completion_status IN ('recorded', 'reviewed', 'finalized')
  );

ALTER TABLE cbe_results
  ADD CONSTRAINT cbe_results_evidence_fk FOREIGN KEY (evidence_asset_id, tenant_id)
    REFERENCES evidence_assets (id, tenant_id) ON DELETE RESTRICT;

GRANT UPDATE (
  level_code, points, marked_at, marked_by, row_version,
  observation, teacher_feedback, evidence_asset_id, completion_status
) ON cbe_results TO figbloom_app;

-- Note (OD-3 / audit H-2): cbe_results_revision_required (035) already requires every UPDATE to
-- advance row_version with a matching cbe_result_revisions row. Qualitative 079 columns therefore
-- cannot change without a revision. Revision history still stores only level/points (M-2 residual).

-- ---------------------------------------------------------------- core competencies / values (CBC report cards)
-- Codes match packages/shared/src/competencies.ts. Labels are not stored so wording can evolve.
CREATE TABLE learner_competency_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  term_id uuid NOT NULL,
  learner_id uuid NOT NULL,
  kind text NOT NULL,
  item text NOT NULL,
  level_code text NOT NULL,
  rated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  rated_at timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1,
  CONSTRAINT learner_competency_ratings_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT learner_competency_ratings_term_fk FOREIGN KEY (term_id, tenant_id)
    REFERENCES academic_terms (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT learner_competency_ratings_learner_fk FOREIGN KEY (learner_id, tenant_id)
    REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT learner_competency_ratings_kind_chk CHECK (kind IN ('competency', 'value')),
  CONSTRAINT learner_competency_ratings_item_chk CHECK (item ~ '^[a-z_]{2,40}$'),
  CONSTRAINT learner_competency_ratings_level_chk CHECK (level_code IN ('EE', 'ME', 'AE', 'BE')),
  CONSTRAINT learner_competency_ratings_version_chk CHECK (row_version >= 1),
  CONSTRAINT learner_competency_ratings_uniq UNIQUE (tenant_id, term_id, learner_id, kind, item)
);

CREATE INDEX learner_competency_ratings_term_idx
  ON learner_competency_ratings (tenant_id, term_id, learner_id);

ALTER TABLE learner_competency_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE learner_competency_ratings FORCE ROW LEVEL SECURITY;

CREATE POLICY learner_competency_ratings_tenant ON learner_competency_ratings
  FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY learner_competency_ratings_owner ON learner_competency_ratings
  FOR ALL TO PUBLIC
  USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'learner_competency_ratings'
  ))
  WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'learner_competency_ratings'
  ));

GRANT SELECT, INSERT ON learner_competency_ratings TO figbloom_app;
GRANT UPDATE (level_code, rated_by, rated_at, row_version) ON learner_competency_ratings TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON learner_competency_ratings FROM figbloom_app;

-- ---------------------------------------------------------------- curriculum reference catalogue (progressive, provenance-honest)
-- tenant_id NULL rows are platform_reference catalogue entries. Schools may read them;
-- school-configured curriculum remains in learning_areas / strands / … tables.
CREATE TABLE curriculum_reference_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL = platform progressive catalogue; non-null = school-scoped reference rows.
  tenant_id uuid REFERENCES tenants (id) ON DELETE RESTRICT,
  provenance_id uuid NOT NULL REFERENCES curriculum_provenance (id) ON DELETE RESTRICT,
  entry_kind text NOT NULL,
  code text NOT NULL,
  title text NOT NULL,
  body text,
  education_level text,
  grade_band text,
  pathway text,
  parent_code text,
  source_organisation text NOT NULL,
  source_title text NOT NULL,
  source_uri text,
  source_document_id text,
  publication_or_version text,
  retrieved_at date NOT NULL,
  verification_status text NOT NULL,
  known_limitations text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_reference_entries_kind_chk CHECK (
    entry_kind IN (
      'education_level', 'pathway', 'grade', 'learning_area', 'subject',
      'strand', 'sub_strand', 'learning_outcome', 'learning_experience',
      'core_competency', 'value', 'pci', 'assessment_method'
    )
  ),
  CONSTRAINT curriculum_reference_entries_code_len CHECK (char_length(trim(code)) BETWEEN 1 AND 64),
  CONSTRAINT curriculum_reference_entries_title_len CHECK (char_length(trim(title)) BETWEEN 1 AND 200),
  CONSTRAINT curriculum_reference_entries_body_len CHECK (
    body IS NULL OR char_length(body) BETWEEN 1 AND 4000
  ),
  CONSTRAINT curriculum_reference_entries_org_len CHECK (
    char_length(trim(source_organisation)) BETWEEN 1 AND 120
  ),
  CONSTRAINT curriculum_reference_entries_source_title_len CHECK (
    char_length(trim(source_title)) BETWEEN 1 AND 200
  ),
  CONSTRAINT curriculum_reference_entries_uri_len CHECK (
    source_uri IS NULL OR char_length(source_uri) BETWEEN 1 AND 500
  ),
  CONSTRAINT curriculum_reference_entries_verification_chk CHECK (
    verification_status IN ('unverified', 'verified', 'incomplete')
  ),
  CONSTRAINT curriculum_reference_entries_limitations_len CHECK (
    known_limitations IS NULL OR char_length(known_limitations) BETWEEN 1 AND 2000
  ),
  CONSTRAINT curriculum_reference_entries_education_level_chk CHECK (
    education_level IS NULL
    OR education_level IN (
      'pre_primary', 'primary', 'junior_secondary', 'senior_school', 'secondary'
    )
  ),
  CONSTRAINT curriculum_reference_entries_pathway_chk CHECK (
    pathway IS NULL OR pathway IN ('stem', 'social_sciences', 'arts_sports')
  )
);

CREATE UNIQUE INDEX curriculum_reference_entries_prov_kind_code_uidx
  ON curriculum_reference_entries (provenance_id, entry_kind, lower(trim(code)));

CREATE INDEX curriculum_reference_entries_kind_idx
  ON curriculum_reference_entries (entry_kind, verification_status);

-- Writes are migrator/owner only (no INSERT grant to figbloom_app).
ALTER TABLE curriculum_reference_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE curriculum_reference_entries FORCE ROW LEVEL SECURITY;

-- Platform rows (tenant_id NULL) are readable in any school session; school rows are tenant-scoped.
-- Never USING (true): FIG-1605 requires a predicate for figbloom_app.
CREATE POLICY curriculum_reference_entries_read ON curriculum_reference_entries
  FOR SELECT TO figbloom_app
  USING (
    tenant_id IS NULL
    OR tenant_id = app_current_tenant_id()
  );

CREATE POLICY curriculum_reference_entries_owner ON curriculum_reference_entries
  FOR ALL TO PUBLIC
  USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'curriculum_reference_entries'
  ))
  WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'curriculum_reference_entries'
  ));

GRANT SELECT ON curriculum_reference_entries TO figbloom_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON curriculum_reference_entries FROM figbloom_app;

-- Seed a single platform provenance + publicly known CBC competency/value catalogue.
-- Official learning-area strands/outcomes are NOT fabricated here (D-5 / goal honesty).
INSERT INTO curriculum_provenance (id, tenant_id, source_kind, source_label, source_uri, notes)
VALUES (
  'a1000000-0000-4000-8000-000000000001',
  NULL,
  'platform_reference',
  'KICD CBC core competencies and values (progressive reference)',
  'https://kicd.ac.ke/',
  'Progressive platform reference. Competency and value codes mirror the existing FigBloom product catalogue. Learning-area strands and specific learning outcomes are intentionally absent until sourced records with verification evidence are imported. Not a complete official KICD catalogue.'
);

INSERT INTO curriculum_reference_entries (
  provenance_id, entry_kind, code, title, education_level, source_organisation, source_title,
  source_uri, publication_or_version, retrieved_at, verification_status, known_limitations
) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'core_competency', 'communication',
   'Communication and collaboration', NULL, 'Kenya Institute of Curriculum Development (KICD)',
   'Competency Based Curriculum — core competencies (public product alignment)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'unverified',
   'Label wording may vary across KICD publications; code is stable for ratings.'),
  ('a1000000-0000-4000-8000-000000000001', 'core_competency', 'critical_thinking',
   'Critical thinking and problem solving', NULL, 'Kenya Institute of Curriculum Development (KICD)',
   'Competency Based Curriculum — core competencies (public product alignment)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'unverified', NULL),
  ('a1000000-0000-4000-8000-000000000001', 'core_competency', 'creativity',
   'Creativity and imagination', NULL, 'Kenya Institute of Curriculum Development (KICD)',
   'Competency Based Curriculum — core competencies (public product alignment)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'unverified', NULL),
  ('a1000000-0000-4000-8000-000000000001', 'core_competency', 'citizenship',
   'Citizenship', NULL, 'Kenya Institute of Curriculum Development (KICD)',
   'Competency Based Curriculum — core competencies (public product alignment)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'unverified', NULL),
  ('a1000000-0000-4000-8000-000000000001', 'core_competency', 'digital_literacy',
   'Digital literacy', NULL, 'Kenya Institute of Curriculum Development (KICD)',
   'Competency Based Curriculum — core competencies (public product alignment)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'unverified', NULL),
  ('a1000000-0000-4000-8000-000000000001', 'core_competency', 'learning_to_learn',
   'Learning to learn', NULL, 'Kenya Institute of Curriculum Development (KICD)',
   'Competency Based Curriculum — core competencies (public product alignment)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'unverified', NULL),
  ('a1000000-0000-4000-8000-000000000001', 'core_competency', 'self_efficacy',
   'Self-efficacy', NULL, 'Kenya Institute of Curriculum Development (KICD)',
   'Competency Based Curriculum — core competencies (public product alignment)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'unverified', NULL),
  ('a1000000-0000-4000-8000-000000000001', 'value', 'love',
   'Love', NULL, 'Kenya Institute of Curriculum Development (KICD)',
   'CBC national values (public product alignment)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'unverified', NULL),
  ('a1000000-0000-4000-8000-000000000001', 'value', 'responsibility',
   'Responsibility', NULL, 'Kenya Institute of Curriculum Development (KICD)',
   'CBC national values (public product alignment)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'unverified', NULL),
  ('a1000000-0000-4000-8000-000000000001', 'value', 'respect',
   'Respect', NULL, 'Kenya Institute of Curriculum Development (KICD)',
   'CBC national values (public product alignment)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'unverified', NULL),
  ('a1000000-0000-4000-8000-000000000001', 'value', 'unity',
   'Unity', NULL, 'Kenya Institute of Curriculum Development (KICD)',
   'CBC national values (public product alignment)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'unverified', NULL),
  ('a1000000-0000-4000-8000-000000000001', 'value', 'peace',
   'Peace', NULL, 'Kenya Institute of Curriculum Development (KICD)',
   'CBC national values (public product alignment)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'unverified', NULL),
  ('a1000000-0000-4000-8000-000000000001', 'value', 'patriotism',
   'Patriotism', NULL, 'Kenya Institute of Curriculum Development (KICD)',
   'CBC national values (public product alignment)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'unverified', NULL),
  ('a1000000-0000-4000-8000-000000000001', 'value', 'integrity',
   'Integrity', NULL, 'Kenya Institute of Curriculum Development (KICD)',
   'CBC national values (public product alignment)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'unverified', NULL),
  ('a1000000-0000-4000-8000-000000000001', 'education_level', 'pre_primary',
   'Pre-primary (PP1–PP2)', 'pre_primary', 'Kenya Institute of Curriculum Development (KICD)',
   'CBC education structure (public product alignment)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'unverified',
   'Structural label only; year bands come from school class configuration.'),
  ('a1000000-0000-4000-8000-000000000001', 'education_level', 'primary',
   'Primary (Grade 1–6)', 'primary', 'Kenya Institute of Curriculum Development (KICD)',
   'CBC education structure (public product alignment)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'unverified', NULL),
  ('a1000000-0000-4000-8000-000000000001', 'education_level', 'junior_secondary',
   'Junior school (Grade 7–9)', 'junior_secondary', 'Kenya Institute of Curriculum Development (KICD)',
   'CBC education structure (public product alignment)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'unverified', NULL),
  ('a1000000-0000-4000-8000-000000000001', 'education_level', 'senior_school',
   'Senior school (Grade 10–12)', 'senior_school', 'Kenya Institute of Curriculum Development (KICD)',
   'CBC education structure (public product alignment)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'unverified', NULL),
  ('a1000000-0000-4000-8000-000000000001', 'pathway', 'stem',
   'STEM', 'senior_school', 'Kenya Institute of Curriculum Development (KICD)',
   'Senior school pathways (public product alignment)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'unverified', NULL),
  ('a1000000-0000-4000-8000-000000000001', 'pathway', 'social_sciences',
   'Social Sciences', 'senior_school', 'Kenya Institute of Curriculum Development (KICD)',
   'Senior school pathways (public product alignment)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'unverified', NULL),
  ('a1000000-0000-4000-8000-000000000001', 'pathway', 'arts_sports',
   'Arts and Sports Science', 'senior_school', 'Kenya Institute of Curriculum Development (KICD)',
   'Senior school pathways (public product alignment)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'unverified', NULL),
  ('a1000000-0000-4000-8000-000000000001', 'assessment_method', 'observation',
   'Observation schedule', NULL, 'Kenya Institute of Curriculum Development (KICD)',
   'CBC assessment methods (progressive reference)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'incomplete',
   'Method catalogue entry only; instrument templates are school-configured.'),
  ('a1000000-0000-4000-8000-000000000001', 'assessment_method', 'checklist',
   'Checklist', NULL, 'Kenya Institute of Curriculum Development (KICD)',
   'CBC assessment methods (progressive reference)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'incomplete', NULL),
  ('a1000000-0000-4000-8000-000000000001', 'assessment_method', 'rubric',
   'Rubric / rating scale', NULL, 'Kenya Institute of Curriculum Development (KICD)',
   'CBC assessment methods (progressive reference)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'incomplete', NULL),
  ('a1000000-0000-4000-8000-000000000001', 'assessment_method', 'portfolio',
   'Portfolio', NULL, 'Kenya Institute of Curriculum Development (KICD)',
   'CBC assessment methods (progressive reference)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'incomplete', NULL),
  ('a1000000-0000-4000-8000-000000000001', 'assessment_method', 'project',
   'Project', NULL, 'Kenya Institute of Curriculum Development (KICD)',
   'CBC assessment methods (progressive reference)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'incomplete', NULL),
  ('a1000000-0000-4000-8000-000000000001', 'pci', 'pci_placeholder',
   'Pertinent and Contemporary Issues (catalogue placeholder)', NULL,
   'Kenya Institute of Curriculum Development (KICD)',
   'PCI catalogue (progressive reference)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'incomplete',
   'No official PCI inventory is seeded. Schools may configure local PCI content separately when sourced.'),
  ('a1000000-0000-4000-8000-000000000001', 'learning_experience', 'learning_experience_placeholder',
   'Learning experiences (catalogue placeholder)', NULL,
   'Kenya Institute of Curriculum Development (KICD)',
   'Learning experiences catalogue (progressive reference)',
   'https://kicd.ac.ke/', 'progressive-reference-2026-11', DATE '2026-11-21', 'incomplete',
   'No official learning-experience statements are seeded. Attach school-configured experiences via school curriculum rows when available.');
