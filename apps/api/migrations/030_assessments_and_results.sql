-- Stage 9 — Assessments, marks, homework, learning-material metadata,
-- report-card publications and grading schemes.
-- Forward-only. Migrations 001–029 are not edited.
--
-- Report-card figures are deterministic and traceable:
--   method = sum_and_mean_of_published_scores
--   For published assessments of the class and term, each learner's
--   sum is SUM(score), count is the number of those scores, and
--   average is ROUND(AVG(score), 2) (PostgreSQL numeric half away from zero).
--   figures.assessment_ids lists every source assessment id (sorted).
--   No grading-scheme weighting is applied to the publication snapshot.
--
-- Mark rows are unique per (assessment_id, learner_id). row_version starts at 1
-- and increments on each successful update. A stale row_version is rejected
-- by the application with HTTP 409 (newest version wins).

-- ---------------------------------------------------------------- assessments
CREATE TABLE assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  class_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  term_id uuid NOT NULL,
  title text NOT NULL,
  kind text NOT NULL,
  max_score numeric NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  published_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assessments_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT assessments_class_fk FOREIGN KEY (class_id, tenant_id)
    REFERENCES classes (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT assessments_subject_fk FOREIGN KEY (subject_id, tenant_id)
    REFERENCES subjects (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT assessments_term_fk FOREIGN KEY (term_id, tenant_id)
    REFERENCES academic_terms (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT assessments_title_len CHECK (char_length(trim(title)) BETWEEN 1 AND 160),
  CONSTRAINT assessments_kind_chk CHECK (kind IN ('exam', 'homework', 'cbe', 'other')),
  CONSTRAINT assessments_max_score_chk CHECK (max_score > 0 AND max_score <= 10000),
  CONSTRAINT assessments_status_chk CHECK (status IN ('draft', 'published', 'closed')),
  CONSTRAINT assessments_version_chk CHECK (version >= 1),
  CONSTRAINT assessments_published_chk CHECK (
    (status = 'draft' AND published_at IS NULL) OR (status <> 'draft' AND published_at IS NOT NULL)
  )
);

CREATE INDEX assessments_class_term_idx ON assessments (tenant_id, class_id, term_id);

-- ---------------------------------------------------------------- components (optional breakdown)
CREATE TABLE assessment_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  assessment_id uuid NOT NULL,
  name text NOT NULL,
  max_score numeric NOT NULL,
  weight numeric,
  sort_order smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assessment_components_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT assessment_components_assessment_fk FOREIGN KEY (assessment_id, tenant_id)
    REFERENCES assessments (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT assessment_components_name_len CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
  CONSTRAINT assessment_components_max_chk CHECK (max_score > 0 AND max_score <= 10000),
  CONSTRAINT assessment_components_weight_chk CHECK (weight IS NULL OR weight >= 0)
);

CREATE INDEX assessment_components_assessment_idx
  ON assessment_components (tenant_id, assessment_id, sort_order);

-- ---------------------------------------------------------------- marks (optimistic concurrency)
CREATE TABLE mark_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  assessment_id uuid NOT NULL,
  learner_id uuid NOT NULL,
  score numeric NOT NULL,
  grade text,
  marked_at timestamptz NOT NULL DEFAULT now(),
  marked_by uuid REFERENCES users (id) ON DELETE SET NULL,
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mark_entries_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT mark_entries_assessment_learner_uidx UNIQUE (assessment_id, learner_id),
  CONSTRAINT mark_entries_assessment_fk FOREIGN KEY (assessment_id, tenant_id)
    REFERENCES assessments (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT mark_entries_learner_fk FOREIGN KEY (learner_id, tenant_id)
    REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT mark_entries_score_chk CHECK (score >= 0 AND score <= 10000),
  CONSTRAINT mark_entries_grade_len CHECK (grade IS NULL OR char_length(trim(grade)) BETWEEN 1 AND 16),
  CONSTRAINT mark_entries_version_chk CHECK (row_version >= 1)
);

CREATE INDEX mark_entries_assessment_idx ON mark_entries (tenant_id, assessment_id);

-- ---------------------------------------------------------------- homework
CREATE TABLE homework_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  class_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  term_id uuid NOT NULL,
  title text NOT NULL,
  due_on date NOT NULL,
  body text NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT homework_items_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT homework_items_class_fk FOREIGN KEY (class_id, tenant_id)
    REFERENCES classes (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT homework_items_subject_fk FOREIGN KEY (subject_id, tenant_id)
    REFERENCES subjects (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT homework_items_term_fk FOREIGN KEY (term_id, tenant_id)
    REFERENCES academic_terms (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT homework_items_title_len CHECK (char_length(trim(title)) BETWEEN 1 AND 160),
  CONSTRAINT homework_items_body_len CHECK (char_length(body) BETWEEN 1 AND 8000)
);

CREATE INDEX homework_items_class_idx ON homework_items (tenant_id, class_id, due_on);

-- ---------------------------------------------------------------- learning material metadata (no bytes)
CREATE TABLE learning_materials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  title text NOT NULL,
  description text,
  class_id uuid,
  subject_id uuid,
  storage_status text NOT NULL DEFAULT 'metadata_only',
  storage_key text NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_materials_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT learning_materials_class_fk FOREIGN KEY (class_id, tenant_id)
    REFERENCES classes (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT learning_materials_subject_fk FOREIGN KEY (subject_id, tenant_id)
    REFERENCES subjects (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT learning_materials_title_len CHECK (char_length(trim(title)) BETWEEN 1 AND 160),
  CONSTRAINT learning_materials_description_len CHECK (
    description IS NULL OR char_length(description) BETWEEN 1 AND 4000
  ),
  CONSTRAINT learning_materials_storage_status_chk CHECK (storage_status IN ('metadata_only')),
  CONSTRAINT learning_materials_storage_key_shape CHECK (
    storage_key ~ '^obj/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}$'
    AND split_part(storage_key, '/', 2) = tenant_id::text
  ),
  CONSTRAINT learning_materials_storage_key_uniq UNIQUE (storage_key)
);

CREATE INDEX learning_materials_class_idx ON learning_materials (tenant_id, class_id);

CREATE FUNCTION public.learning_materials_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- Client-supplied keys are discarded. No object bytes are stored.
  NEW.storage_key := 'obj/' || NEW.tenant_id::text || '/'
    || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  NEW.storage_status := 'metadata_only';
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.learning_materials_before_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.learning_materials_before_insert() FROM figbloom_app;

CREATE TRIGGER learning_materials_before_insert
  BEFORE INSERT ON learning_materials
  FOR EACH ROW
  EXECUTE FUNCTION public.learning_materials_before_insert();

-- ---------------------------------------------------------------- report cards
CREATE TABLE report_card_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  term_id uuid NOT NULL,
  class_id uuid NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid REFERENCES users (id) ON DELETE SET NULL,
  figures jsonb NOT NULL,
  CONSTRAINT report_card_publications_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT report_card_publications_term_fk FOREIGN KEY (term_id, tenant_id)
    REFERENCES academic_terms (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT report_card_publications_class_fk FOREIGN KEY (class_id, tenant_id)
    REFERENCES classes (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT report_card_figures_traceable CHECK (
    jsonb_typeof(figures) = 'object'
    AND figures ->> 'method' = 'sum_and_mean_of_published_scores'
    AND jsonb_typeof(figures -> 'assessment_ids') = 'array'
  )
);

CREATE INDEX report_card_publications_class_term_idx
  ON report_card_publications (tenant_id, class_id, term_id);

-- ---------------------------------------------------------------- grading schemes (rules validated in the application)
CREATE TABLE grading_schemes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  name text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  rules jsonb NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grading_schemes_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT grading_schemes_name_len CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
  CONSTRAINT grading_schemes_version_chk CHECK (version >= 1),
  CONSTRAINT grading_schemes_rules_obj CHECK (jsonb_typeof(rules) = 'object'),
  CONSTRAINT grading_schemes_name_version_uidx UNIQUE (tenant_id, name, version)
);

-- ---------------------------------------------------------------- RLS + grants
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'assessments', 'assessment_components', 'mark_entries', 'homework_items',
    'learning_materials', 'report_card_publications', 'grading_schemes'
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

GRANT UPDATE (status, published_at, version, updated_at) ON assessments TO figbloom_app;
GRANT UPDATE (score, grade, marked_at, marked_by, row_version) ON mark_entries TO figbloom_app;
