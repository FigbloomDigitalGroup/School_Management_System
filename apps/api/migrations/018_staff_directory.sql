-- Phase 3 — Staff directory foundations (FIG-1575)
-- Directory identity is distinct from authentication. user_id is optional.
-- Does not grant RBAC powers; does not invite/login.

INSERT INTO permissions (code, description) VALUES
  ('resource.staff.read', 'Read staff directory records in tenant'),
  ('resource.staff.write', 'Create and update staff directory records in tenant')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'resource.staff.read'),
  ('school_admin', 'resource.staff.write')
ON CONFLICT DO NOTHING;

CREATE TABLE staff_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  full_name text NOT NULL,
  staff_title text,
  classification text NOT NULL DEFAULT 'staff'
    CHECK (classification IN ('school_admin', 'teacher', 'driver', 'staff')),
  phone text,
  email text,
  user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_members_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT staff_members_full_name_len CHECK (char_length(trim(full_name)) BETWEEN 1 AND 120),
  CONSTRAINT staff_members_title_len CHECK (
    staff_title IS NULL OR char_length(trim(staff_title)) BETWEEN 1 AND 120
  ),
  CONSTRAINT staff_members_phone_len CHECK (phone IS NULL OR char_length(phone) BETWEEN 5 AND 32),
  CONSTRAINT staff_members_email_len CHECK (email IS NULL OR char_length(email) BETWEEN 3 AND 254),
  CONSTRAINT staff_members_archive_consistency CHECK (
    (active = true AND archived_at IS NULL)
    OR (active = false AND archived_at IS NOT NULL)
  )
);

-- At most one active directory row per linked user in a school.
CREATE UNIQUE INDEX staff_members_tenant_user_uidx
  ON staff_members (tenant_id, user_id)
  WHERE user_id IS NOT NULL AND archived_at IS NULL;

CREATE INDEX staff_members_tenant_active_name_idx
  ON staff_members (tenant_id, active, lower(full_name));

CREATE INDEX staff_members_tenant_id_idx ON staff_members (tenant_id);

ALTER TABLE staff_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_members FORCE ROW LEVEL SECURITY;

CREATE POLICY staff_members_tenant ON staff_members
  FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY staff_members_owner ON staff_members
  FOR ALL TO PUBLIC
  USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'staff_members'
  ))
  WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'staff_members'
  ));

GRANT SELECT, INSERT, UPDATE ON staff_members TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON staff_members FROM figbloom_app;
