-- Register the platform operator permissions that the API documents and enforces (forward-only).
-- OpenAPI declared `platform.ops.read` for GET /v1/platform/ops/status although no such permission existed (the route only
-- checked "super administrator"). The permission registry now matches the contract; super administrators hold both implicitly
-- (hasPermission) and explicitly (role_permissions), and the database functions still refuse everyone else.
INSERT INTO permissions (code, description) VALUES
  ('platform.ops.read', 'Platform: read worker, queue and reconciliation operational status (counts and ages only)'),
  ('platform.finance.unmatched.manage', 'Platform: list, inspect, assign, annotate, retry, escalate, resolve and reopen unmatched provider-callback cases')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role, permission_code) VALUES
  ('super_admin', 'platform.ops.read'),
  ('super_admin', 'platform.finance.unmatched.manage')
ON CONFLICT (role, permission_code) DO NOTHING;
