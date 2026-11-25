-- Platform console slice P3 (apps/api/docs/PLATFORM-CONSOLE.md):
-- Read-only platform permissions for listing organizations, organization administrators, and school administrators.
-- Forward-only. Super administrators only (never delegable, never granted to school or org roles).

INSERT INTO permissions (code, description) VALUES
  ('platform.organizations.read', 'Platform: list and read all organizations and their administrators'),
  ('platform.tenants.admins.read', 'Platform: list school administrators for a school (personal data, audited)')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code) VALUES
  ('super_admin', 'platform.organizations.read'),
  ('super_admin', 'platform.tenants.admins.read')
ON CONFLICT (role, permission_code) DO NOTHING;
