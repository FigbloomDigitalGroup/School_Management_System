-- Academics & CBE residual hardening (M-2 qualitative revision snapshot, M-3 competency rating revisions).
-- Forward-only. Preserves all migrations 001–080.

-- ---------------------------------------------------------------- M-2: qualitative fields on cbe_result_revisions
ALTER TABLE cbe_result_revisions
  ADD COLUMN previous_observation text,
  ADD COLUMN new_observation text,
  ADD COLUMN previous_teacher_feedback text,
  ADD COLUMN new_teacher_feedback text,
  ADD COLUMN previous_evidence_asset_id uuid,
  ADD COLUMN new_evidence_asset_id uuid,
  ADD COLUMN previous_completion_status text,
  ADD COLUMN new_completion_status text;

ALTER TABLE cbe_result_revisions
  ADD CONSTRAINT cbe_result_revisions_prev_completion_chk CHECK (
    previous_completion_status IS NULL
    OR previous_completion_status IN ('recorded', 'reviewed', 'finalized')
  ),
  ADD CONSTRAINT cbe_result_revisions_new_completion_chk CHECK (
    new_completion_status IS NULL
    OR new_completion_status IN ('recorded', 'reviewed', 'finalized')
  );

-- ---------------------------------------------------------------- M-3: append-only revision table for competency/value ratings
CREATE TABLE learner_competency_rating_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  rating_id uuid NOT NULL,
  previous_level_code text NOT NULL,
  new_level_code text NOT NULL,
  resulting_row_version integer NOT NULL,
  reason text,
  revised_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  revised_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learner_competency_rating_revisions_rating_fk FOREIGN KEY (rating_id, tenant_id)
    REFERENCES learner_competency_ratings (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT learner_competency_rating_revisions_prev_chk CHECK (previous_level_code IN ('EE', 'ME', 'AE', 'BE')),
  CONSTRAINT learner_competency_rating_revisions_new_chk CHECK (new_level_code IN ('EE', 'ME', 'AE', 'BE')),
  CONSTRAINT learner_competency_rating_revisions_ver_chk CHECK (resulting_row_version >= 2),
  CONSTRAINT learner_competency_rating_revisions_reason_len CHECK (
    reason IS NULL OR char_length(trim(reason)) BETWEEN 1 AND 500
  ),
  CONSTRAINT learner_competency_rating_revisions_uniq UNIQUE (rating_id, resulting_row_version)
);

CREATE INDEX learner_competency_rating_revisions_rating_idx
  ON learner_competency_rating_revisions (tenant_id, rating_id, resulting_row_version);

ALTER TABLE learner_competency_rating_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE learner_competency_rating_revisions FORCE ROW LEVEL SECURITY;

CREATE POLICY learner_competency_rating_revisions_tenant ON learner_competency_rating_revisions
  FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY learner_competency_rating_revisions_owner ON learner_competency_rating_revisions
  FOR ALL TO PUBLIC
  USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'learner_competency_rating_revisions'
  ))
  WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'learner_competency_rating_revisions'
  ));

GRANT SELECT, INSERT ON learner_competency_rating_revisions TO figbloom_app;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON learner_competency_rating_revisions FROM figbloom_app;
