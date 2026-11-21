-- Acceptance programme (owner decision 6.7): independent permissions for /reports/overview and /reports/attendance-daily.
-- Forward-only. resource.report.read (058) is retained, unused by routes (no grant is removed); holders of it keep their
-- existing access through explicit copies of the new permissions, so nobody loses or silently gains access:
--   resource.report.overview.read   -> GET /v1/tenants/:tenantId/reports/overview
--   resource.report.attendance.read -> GET /v1/tenants/:tenantId/reports/attendance-daily
-- Holding one does NOT grant the other.

INSERT INTO permissions (code, description) VALUES
  ('resource.report.overview.read', 'Read the school overview aggregate report'),
  ('resource.report.attendance.read', 'Read the daily attendance aggregate report')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code)
SELECT rp.role, n.code
  FROM role_permissions rp
 CROSS JOIN (VALUES ('resource.report.overview.read'), ('resource.report.attendance.read')) AS n(code)
 WHERE rp.permission_code = 'resource.report.read'
ON CONFLICT DO NOTHING;
