-- FIG-1573 R2-05 — approved org-admin policy (Ancel)
-- Org admins: organization aggregate access only.
-- School-level admin capabilities require explicit, school-scoped,
-- revocable, auditable delegation. Forward-only.

INSERT INTO permissions (code, description) VALUES
  ('rbac.org_delegations.manage', 'Grant or revoke org-admin school delegations'),
  ('rbac.org_delegations.read', 'List org-admin school delegations for a school')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'rbac.org_delegations.manage'),
  ('school_admin', 'rbac.org_delegations.read'),
  ('super_admin', 'rbac.org_delegations.manage'),
  ('super_admin', 'rbac.org_delegations.read')
ON CONFLICT (role, permission_code) DO NOTHING;

-- Composite FK target: (tenant id, its organization)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenants_id_organization_id_key'
  ) THEN
    ALTER TABLE tenants
      ADD CONSTRAINT tenants_id_organization_id_key UNIQUE (id, organization_id);
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS org_admin_school_delegations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  delegate_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES permissions (code),
  granted_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users (id),
  CONSTRAINT org_admin_school_delegations_tenant_org_fk
    FOREIGN KEY (tenant_id, organization_id)
    REFERENCES tenants (id, organization_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS org_admin_school_delegations_active_uq
  ON org_admin_school_delegations (tenant_id, delegate_user_id, permission_code)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS org_admin_school_delegations_delegate_idx
  ON org_admin_school_delegations (delegate_user_id, tenant_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS org_admin_school_delegations_tenant_idx
  ON org_admin_school_delegations (tenant_id)
  WHERE revoked_at IS NULL;

COMMENT ON TABLE org_admin_school_delegations IS
  'R2-05: school-scoped permissions delegated to an org_admin. No automatic school-admin inheritance.';

ALTER TABLE org_admin_school_delegations ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_admin_school_delegations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_admin_school_delegations_isolation ON org_admin_school_delegations;
CREATE POLICY org_admin_school_delegations_isolation ON org_admin_school_delegations
  FOR ALL TO figbloom_app
  USING (
    current_setting('app.authz_mode', true) = 'bypass'
    OR tenant_id = app_current_tenant_id()
  )
  WITH CHECK (
    current_setting('app.authz_mode', true) = 'bypass'
    OR tenant_id = app_current_tenant_id()
  );

DROP POLICY IF EXISTS org_admin_school_delegations_owner ON org_admin_school_delegations;
CREATE POLICY org_admin_school_delegations_owner ON org_admin_school_delegations
  FOR ALL TO PUBLIC
  USING (current_setting('app.authz_mode', true) = 'owner' OR current_user <> 'figbloom_app')
  WITH CHECK (current_setting('app.authz_mode', true) = 'owner' OR current_user <> 'figbloom_app');

GRANT SELECT, INSERT, UPDATE, DELETE ON org_admin_school_delegations TO figbloom_app;
