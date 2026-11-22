-- WS-5: Attendance coverage assignments.
-- Forward-only. Preserves all migrations 001–082.

CREATE TABLE attendance_coverage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  class_id uuid NOT NULL,
  covering_staff_id uuid NOT NULL,
  covered_staff_id uuid,
  coverage_date date NOT NULL,
  session text NOT NULL DEFAULT 'all_day',
  reason text,
  status text NOT NULL DEFAULT 'active',
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  CONSTRAINT attendance_coverage_class_fk FOREIGN KEY (class_id, tenant_id)
    REFERENCES classes (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT attendance_coverage_covering_fk FOREIGN KEY (covering_staff_id, tenant_id)
    REFERENCES staff_members (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT attendance_coverage_covered_fk FOREIGN KEY (covered_staff_id, tenant_id)
    REFERENCES staff_members (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT attendance_coverage_session_chk CHECK (session IN ('morning', 'afternoon', 'all_day')),
  CONSTRAINT attendance_coverage_status_chk CHECK (status IN ('active', 'cancelled')),
  CONSTRAINT attendance_coverage_reason_len CHECK (reason IS NULL OR char_length(trim(reason)) BETWEEN 1 AND 300),
  CONSTRAINT attendance_coverage_status_ts_chk CHECK (
    (status = 'active' AND cancelled_at IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX attendance_coverage_active_uidx
  ON attendance_coverage (tenant_id, class_id, coverage_date, session)
  WHERE status = 'active';

CREATE INDEX attendance_coverage_date_idx
  ON attendance_coverage (tenant_id, coverage_date, class_id);

ALTER TABLE attendance_coverage ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_coverage FORCE ROW LEVEL SECURITY;

CREATE POLICY attendance_coverage_tenant ON attendance_coverage
  FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id())
  WITH CHECK (tenant_id = app_current_tenant_id());

CREATE POLICY attendance_coverage_owner ON attendance_coverage
  FOR ALL TO PUBLIC
  USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'attendance_coverage'
  ))
  WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'attendance_coverage'
  ));

GRANT SELECT, INSERT ON attendance_coverage TO figbloom_app;
GRANT UPDATE (status, cancelled_at) ON attendance_coverage TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON attendance_coverage FROM figbloom_app;
