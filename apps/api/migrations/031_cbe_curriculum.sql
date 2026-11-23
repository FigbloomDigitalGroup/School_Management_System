-- Stage 9 — CBC / CBE curriculum structure for school-configured content.
-- Forward-only. Migrations 001–030 are not edited.
--
-- D-5: this migration does NOT seed an official KICD (or any other national)
-- catalogue. No strand, outcome or rubric row is inserted here. Official or
-- shared catalogue import is a separate path that may later add
-- curriculum_provenance rows with source_kind platform_reference (tenant_id
-- NULL) or import_pending. School API writes may only attach school_configured
-- or import_pending provenance that belongs to the same school. A school row
-- is never an official catalogue claim.

-- ---------------------------------------------------------------- provenance
CREATE TABLE curriculum_provenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants (id) ON DELETE RESTRICT,
  source_kind text NOT NULL,
  source_label text NOT NULL,
  source_uri text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_provenance_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT curriculum_provenance_kind_chk CHECK (
    source_kind IN ('school_configured', 'import_pending', 'platform_reference')
  ),
  CONSTRAINT curriculum_provenance_scope_chk CHECK (
    (source_kind = 'platform_reference' AND tenant_id IS NULL)
    OR (source_kind IN ('school_configured', 'import_pending') AND tenant_id IS NOT NULL)
  ),
  CONSTRAINT curriculum_provenance_label_len CHECK (char_length(trim(source_label)) BETWEEN 1 AND 160),
  CONSTRAINT curriculum_provenance_uri_len CHECK (source_uri IS NULL OR char_length(source_uri) BETWEEN 1 AND 500),
  CONSTRAINT curriculum_provenance_notes_len CHECK (notes IS NULL OR char_length(notes) BETWEEN 1 AND 2000)
);

CREATE INDEX curriculum_provenance_tenant_idx ON curriculum_provenance (tenant_id);

-- ---------------------------------------------------------------- learning areas (school-configured: tenant required)
CREATE TABLE learning_areas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  provenance_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_areas_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT learning_areas_provenance_fk FOREIGN KEY (provenance_id, tenant_id)
    REFERENCES curriculum_provenance (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT learning_areas_code_len CHECK (char_length(trim(code)) BETWEEN 1 AND 32),
  CONSTRAINT learning_areas_name_len CHECK (char_length(trim(name)) BETWEEN 1 AND 120)
);

CREATE UNIQUE INDEX learning_areas_tenant_code_uidx
  ON learning_areas (tenant_id, lower(trim(code)));

-- ---------------------------------------------------------------- strands / sub-strands / outcomes
CREATE TABLE strands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  learning_area_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT strands_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT strands_area_fk FOREIGN KEY (learning_area_id, tenant_id)
    REFERENCES learning_areas (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT strands_code_len CHECK (char_length(trim(code)) BETWEEN 1 AND 32),
  CONSTRAINT strands_name_len CHECK (char_length(trim(name)) BETWEEN 1 AND 160)
);

CREATE UNIQUE INDEX strands_area_code_uidx
  ON strands (tenant_id, learning_area_id, lower(trim(code)));

CREATE TABLE sub_strands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  strand_id uuid NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sub_strands_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT sub_strands_strand_fk FOREIGN KEY (strand_id, tenant_id)
    REFERENCES strands (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT sub_strands_code_len CHECK (char_length(trim(code)) BETWEEN 1 AND 32),
  CONSTRAINT sub_strands_name_len CHECK (char_length(trim(name)) BETWEEN 1 AND 160)
);

CREATE UNIQUE INDEX sub_strands_strand_code_uidx
  ON sub_strands (tenant_id, strand_id, lower(trim(code)));

CREATE TABLE learning_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  sub_strand_id uuid NOT NULL,
  code text NOT NULL,
  statement text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learning_outcomes_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT learning_outcomes_sub_strand_fk FOREIGN KEY (sub_strand_id, tenant_id)
    REFERENCES sub_strands (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT learning_outcomes_code_len CHECK (char_length(trim(code)) BETWEEN 1 AND 32),
  CONSTRAINT learning_outcomes_statement_len CHECK (char_length(trim(statement)) BETWEEN 1 AND 500)
);

CREATE UNIQUE INDEX learning_outcomes_sub_code_uidx
  ON learning_outcomes (tenant_id, sub_strand_id, lower(trim(code)));

-- ---------------------------------------------------------------- versioned rubric descriptors (school configurable)
CREATE TABLE rubric_descriptor_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  name text NOT NULL,
  version integer NOT NULL,
  descriptors jsonb NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rubric_descriptor_configs_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT rubric_descriptor_configs_name_len CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
  CONSTRAINT rubric_descriptor_configs_version_chk CHECK (version >= 1),
  CONSTRAINT rubric_descriptor_configs_name_version_uidx UNIQUE (tenant_id, name, version),
  CONSTRAINT rubric_descriptor_configs_descriptors_chk CHECK (
    jsonb_typeof(descriptors) = 'array' AND jsonb_array_length(descriptors) >= 1
  )
);

-- ---------------------------------------------------------------- CBE assessments and results
CREATE TABLE cbe_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  class_id uuid NOT NULL,
  learning_area_id uuid NOT NULL,
  term_id uuid NOT NULL,
  rubric_config_id uuid,
  title text NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cbe_assessments_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT cbe_assessments_class_fk FOREIGN KEY (class_id, tenant_id)
    REFERENCES classes (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT cbe_assessments_area_fk FOREIGN KEY (learning_area_id, tenant_id)
    REFERENCES learning_areas (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT cbe_assessments_term_fk FOREIGN KEY (term_id, tenant_id)
    REFERENCES academic_terms (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT cbe_assessments_rubric_fk FOREIGN KEY (rubric_config_id, tenant_id)
    REFERENCES rubric_descriptor_configs (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT cbe_assessments_title_len CHECK (char_length(trim(title)) BETWEEN 1 AND 160)
);

CREATE INDEX cbe_assessments_class_term_idx ON cbe_assessments (tenant_id, class_id, term_id);

CREATE TABLE cbe_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  cbe_assessment_id uuid NOT NULL,
  learner_id uuid NOT NULL,
  strand_id uuid,
  learning_outcome_id uuid,
  level_code text NOT NULL,
  points numeric NOT NULL,
  marked_at timestamptz NOT NULL DEFAULT now(),
  marked_by uuid REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT cbe_results_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT cbe_results_assessment_fk FOREIGN KEY (cbe_assessment_id, tenant_id)
    REFERENCES cbe_assessments (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT cbe_results_learner_fk FOREIGN KEY (learner_id, tenant_id)
    REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT cbe_results_strand_fk FOREIGN KEY (strand_id, tenant_id)
    REFERENCES strands (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT cbe_results_outcome_fk FOREIGN KEY (learning_outcome_id, tenant_id)
    REFERENCES learning_outcomes (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT cbe_results_target_chk CHECK (strand_id IS NOT NULL OR learning_outcome_id IS NOT NULL),
  CONSTRAINT cbe_results_level_len CHECK (char_length(trim(level_code)) BETWEEN 1 AND 16),
  CONSTRAINT cbe_results_points_chk CHECK (points >= 0 AND points <= 1000)
);

CREATE INDEX cbe_results_assessment_idx ON cbe_results (tenant_id, cbe_assessment_id);

-- ---------------------------------------------------------------- evidence metadata only
CREATE TABLE evidence_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  provenance_id uuid NOT NULL,
  learner_id uuid,
  title text NOT NULL,
  description text,
  storage_status text NOT NULL DEFAULT 'metadata_only',
  storage_key text NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT evidence_assets_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT evidence_assets_provenance_fk FOREIGN KEY (provenance_id, tenant_id)
    REFERENCES curriculum_provenance (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT evidence_assets_learner_fk FOREIGN KEY (learner_id, tenant_id)
    REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT evidence_assets_title_len CHECK (char_length(trim(title)) BETWEEN 1 AND 160),
  CONSTRAINT evidence_assets_description_len CHECK (
    description IS NULL OR char_length(description) BETWEEN 1 AND 4000
  ),
  CONSTRAINT evidence_assets_storage_status_chk CHECK (storage_status IN ('metadata_only')),
  CONSTRAINT evidence_assets_storage_key_shape CHECK (
    storage_key ~ '^obj/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{64}$'
    AND split_part(storage_key, '/', 2) = tenant_id::text
  ),
  CONSTRAINT evidence_assets_storage_key_uniq UNIQUE (storage_key)
);

CREATE FUNCTION public.evidence_assets_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.storage_key := 'obj/' || NEW.tenant_id::text || '/'
    || replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  NEW.storage_status := 'metadata_only';
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.evidence_assets_before_insert() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.evidence_assets_before_insert() FROM figbloom_app;

CREATE TRIGGER evidence_assets_before_insert
  BEFORE INSERT ON evidence_assets
  FOR EACH ROW
  EXECUTE FUNCTION public.evidence_assets_before_insert();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'curriculum_provenance', 'learning_areas', 'strands', 'sub_strands', 'learning_outcomes',
    'rubric_descriptor_configs', 'cbe_assessments', 'cbe_results', 'evidence_assets'
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
