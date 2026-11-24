-- 101: teacher reads. Forward-only; 001-100 untouched. Design: docs/TEACHER-READS.md.
--
-- A plain teacher reads the names of the learners in the classes they teach, the staff who teach those classes, and the
-- academic years and terms of those classes. "A class I teach" is decided in application code
-- (src/modules/academics/teaching.ts) on every request from tables the runtime role already reads under the forced tenant
-- policy. No table, grant, policy or function is created or widened: this migration only adds the permission that keeps
-- callers who cannot hold a teaching record (parents, students, drivers, org admins) out, even when a staff record has been
-- linked to their account (migration 022 allows a link to any active member of the school).

INSERT INTO permissions (code, description) VALUES
  ('resource.teaching.read', 'Read the classes one teaches: learner names, colleagues who teach them, and their academic years and terms')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role, permission_code) VALUES
  ('teacher', 'resource.teaching.read'),
  ('staff', 'resource.teaching.read'),
  ('school_admin', 'resource.teaching.read'),
  -- platform super administrators hold every catalogued permission; they have no staff record, so no classes
  ('super_admin', 'resource.teaching.read')
ON CONFLICT DO NOTHING;
