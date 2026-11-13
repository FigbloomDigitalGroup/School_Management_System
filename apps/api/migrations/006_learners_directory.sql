-- VS-1 — School directory: learners create/read (Stage 8 first slice)
-- Forward-only. Does not modify the legacy Supabase schema.
-- Learner PII tables ship with RLS + FORCE + least-privilege grants from day one.

-- ---------------------------------------------------------------- permissions
INSERT INTO permissions (code, description) VALUES
  ('resource.learner.write', 'Create and update learner directory records in tenant')
ON CONFLICT (code) DO NOTHING;

-- school_admin may create learners by role; area.people also implies write at app layer.
INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'resource.learner.write')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- learners
CREATE TABLE learners (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  admission_no text NOT NULL,
  full_name text NOT NULL,
  gender text NOT NULL CHECK (gender IN ('male', 'female')),
  boarding boolean NOT NULL DEFAULT false,
  date_of_birth date,
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT learners_admission_no_len CHECK (char_length(trim(admission_no)) BETWEEN 1 AND 32),
  CONSTRAINT learners_full_name_len CHECK (char_length(trim(full_name)) BETWEEN 1 AND 120),
  CONSTRAINT learners_archive_consistency CHECK (
    (active = true AND archived_at IS NULL)
    OR (active = false AND archived_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX learners_tenant_admission_uidx
  ON learners (tenant_id, lower(trim(admission_no)));

CREATE INDEX learners_tenant_active_name_idx
  ON learners (tenant_id, active, lower(full_name));

CREATE INDEX learners_tenant_id_idx ON learners (tenant_id);

-- ---------------------------------------------------------------- RLS (hybrid isolation)
ALTER TABLE learners ENABLE ROW LEVEL SECURITY;
ALTER TABLE learners FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS learners_isolation ON learners;
CREATE POLICY learners_isolation ON learners
  FOR ALL TO figbloom_app
  USING (
    current_setting('app.authz_mode', true) = 'bypass'
    OR tenant_id = app_current_tenant_id()
  )
  WITH CHECK (
    current_setting('app.authz_mode', true) = 'bypass'
    OR tenant_id = app_current_tenant_id()
  );

DROP POLICY IF EXISTS learners_owner ON learners;
CREATE POLICY learners_owner ON learners
  FOR ALL TO PUBLIC
  USING (current_setting('app.authz_mode', true) = 'owner' OR current_user <> 'figbloom_app')
  WITH CHECK (current_setting('app.authz_mode', true) = 'owner' OR current_user <> 'figbloom_app');

-- ---------------------------------------------------------------- least privilege
-- VS-1 is create/read only — no UPDATE/DELETE for the app role.
GRANT SELECT, INSERT ON learners TO figbloom_app;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON learners FROM figbloom_app;
