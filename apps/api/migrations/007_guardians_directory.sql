-- VS-2 — School directory: guardians and guardian-learner links (Stage 8 second slice)
-- Forward-only. Guardians are standalone person records: no auth identity,
-- no user/profile binding (account provisioning and parent access are deferred).
-- Both tables ship with RLS + FORCE + least-privilege grants from day one.

-- ---------------------------------------------------------------- permissions
INSERT INTO permissions (code, description) VALUES
  ('resource.guardian.read', 'Read guardian directory records and learner links in tenant'),
  ('resource.guardian.write', 'Create guardian directory records and learner links in tenant')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'resource.guardian.read'),
  ('school_admin', 'resource.guardian.write')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- composite keys
-- Lets guardian_links reference (id, tenant_id) so a link can never join rows
-- of two different tenants. id is already the primary key, so this adds no
-- new restriction on learners.
ALTER TABLE learners
  ADD CONSTRAINT learners_id_tenant_uniq UNIQUE (id, tenant_id);

-- ---------------------------------------------------------------- guardians
CREATE TABLE guardians (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  full_name text NOT NULL,
  phone text,
  alt_phone text,
  email text,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guardians_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT guardians_full_name_len CHECK (char_length(trim(full_name)) BETWEEN 1 AND 120),
  CONSTRAINT guardians_phone_len CHECK (phone IS NULL OR char_length(phone) BETWEEN 5 AND 32),
  CONSTRAINT guardians_alt_phone_len CHECK (alt_phone IS NULL OR char_length(alt_phone) BETWEEN 5 AND 32),
  CONSTRAINT guardians_email_len CHECK (email IS NULL OR char_length(email) BETWEEN 3 AND 254)
);

CREATE INDEX guardians_tenant_id_idx ON guardians (tenant_id);
CREATE INDEX guardians_tenant_name_idx ON guardians (tenant_id, lower(full_name));

-- ---------------------------------------------------------------- guardian_links
CREATE TABLE guardian_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  guardian_id uuid NOT NULL,
  learner_id uuid NOT NULL,
  relationship text NOT NULL CHECK (relationship IN ('mother', 'father', 'guardian')),
  is_primary_payer boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT guardian_links_guardian_fk
    FOREIGN KEY (guardian_id, tenant_id) REFERENCES guardians (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT guardian_links_learner_fk
    FOREIGN KEY (learner_id, tenant_id) REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT guardian_links_tenant_fk
    FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE RESTRICT,
  CONSTRAINT guardian_links_guardian_learner_uniq UNIQUE (guardian_id, learner_id)
);

CREATE INDEX guardian_links_tenant_learner_idx ON guardian_links (tenant_id, learner_id);
CREATE INDEX guardian_links_tenant_guardian_idx ON guardian_links (tenant_id, guardian_id);

-- ---------------------------------------------------------------- RLS (hybrid isolation)
ALTER TABLE guardians ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardians FORCE ROW LEVEL SECURITY;
ALTER TABLE guardian_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardian_links FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS guardians_isolation ON guardians;
CREATE POLICY guardians_isolation ON guardians
  FOR ALL TO figbloom_app
  USING (
    current_setting('app.authz_mode', true) = 'bypass'
    OR tenant_id = app_current_tenant_id()
  )
  WITH CHECK (
    current_setting('app.authz_mode', true) = 'bypass'
    OR tenant_id = app_current_tenant_id()
  );

DROP POLICY IF EXISTS guardians_owner ON guardians;
CREATE POLICY guardians_owner ON guardians
  FOR ALL TO PUBLIC
  USING (current_setting('app.authz_mode', true) = 'owner' OR current_user <> 'figbloom_app')
  WITH CHECK (current_setting('app.authz_mode', true) = 'owner' OR current_user <> 'figbloom_app');

DROP POLICY IF EXISTS guardian_links_isolation ON guardian_links;
CREATE POLICY guardian_links_isolation ON guardian_links
  FOR ALL TO figbloom_app
  USING (
    current_setting('app.authz_mode', true) = 'bypass'
    OR tenant_id = app_current_tenant_id()
  )
  WITH CHECK (
    current_setting('app.authz_mode', true) = 'bypass'
    OR tenant_id = app_current_tenant_id()
  );

DROP POLICY IF EXISTS guardian_links_owner ON guardian_links;
CREATE POLICY guardian_links_owner ON guardian_links
  FOR ALL TO PUBLIC
  USING (current_setting('app.authz_mode', true) = 'owner' OR current_user <> 'figbloom_app')
  WITH CHECK (current_setting('app.authz_mode', true) = 'owner' OR current_user <> 'figbloom_app');

-- ---------------------------------------------------------------- least privilege
-- VS-2 is create/read only — no UPDATE/DELETE for the app role.
GRANT SELECT, INSERT ON guardians TO figbloom_app;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON guardians FROM figbloom_app;
GRANT SELECT, INSERT ON guardian_links TO figbloom_app;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON guardian_links FROM figbloom_app;
