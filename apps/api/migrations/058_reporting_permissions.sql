-- Stage 14: reporting permissions (aggregate read models; no new domain tables). Forward-only.

INSERT INTO permissions (code, description) VALUES
  ('resource.report.read', 'Read school aggregate reports and analytics summaries')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'resource.report.read')
ON CONFLICT DO NOTHING;
