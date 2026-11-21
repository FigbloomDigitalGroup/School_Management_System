-- Stage 13: staff leave requests (legacy leave_requests). Forward-only.
-- Anti self-approve and non-overlap preserved as DB guards.

INSERT INTO permissions (code, description) VALUES
  ('resource.leave.read', 'Read leave requests'),
  ('resource.leave.write', 'Submit and review leave requests')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'resource.leave.read'),
  ('school_admin', 'resource.leave.write')
ON CONFLICT DO NOTHING;

CREATE TABLE leave_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  staff_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  start_on      date NOT NULL,
  end_on        date NOT NULL,
  reason        text NOT NULL,
  status        text NOT NULL DEFAULT 'pending',
  reviewed_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at   timestamptz,
  review_note   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leave_requests_dates_chk CHECK (end_on >= start_on),
  CONSTRAINT leave_requests_reason_chk CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000),
  CONSTRAINT leave_requests_status_chk CHECK (status IN ('pending', 'approved', 'declined', 'cancelled')),
  CONSTRAINT leave_requests_review_note_chk CHECK (review_note IS NULL OR char_length(review_note) <= 1000)
);
CREATE INDEX leave_requests_tenant_staff_idx ON leave_requests (tenant_id, staff_user_id, start_on DESC);
CREATE INDEX leave_requests_open_idx ON leave_requests (tenant_id, status) WHERE status = 'pending';

CREATE FUNCTION public.leave_requests_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.staff_user_id IS DISTINCT FROM OLD.staff_user_id
       OR NEW.start_on IS DISTINCT FROM OLD.start_on OR NEW.end_on IS DISTINCT FROM OLD.end_on
       OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      IF OLD.status <> 'pending' OR NEW.status = 'pending' THEN
        RAISE EXCEPTION 'Leave request identity is immutable once reviewed' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF OLD.status <> 'pending' AND NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'A reviewed leave request is final' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IN ('approved', 'declined') THEN
      IF NEW.reviewed_by IS NULL THEN
        RAISE EXCEPTION 'reviewed_by is required' USING ERRCODE = '23514';
      END IF;
      IF NEW.reviewed_by = NEW.staff_user_id THEN
        RAISE EXCEPTION 'A staff member cannot review their own leave' USING ERRCODE = '23514';
      END IF;
      NEW.reviewed_at := coalesce(NEW.reviewed_at, now());
    END IF;
  END IF;
  NEW.reason := btrim(NEW.reason);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER leave_requests_guard BEFORE INSERT OR UPDATE ON leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.leave_requests_guard();
REVOKE ALL ON FUNCTION public.leave_requests_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.leave_requests_guard() FROM figbloom_app;

CREATE FUNCTION public.leave_requests_no_overlap() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.status IN ('pending', 'approved') AND EXISTS (
    SELECT 1 FROM public.leave_requests r
     WHERE r.tenant_id = NEW.tenant_id
       AND r.staff_user_id = NEW.staff_user_id
       AND r.id IS DISTINCT FROM NEW.id
       AND r.status IN ('pending', 'approved')
       AND daterange(r.start_on, r.end_on, '[]') && daterange(NEW.start_on, NEW.end_on, '[]')
  ) THEN
    RAISE EXCEPTION 'Leave dates overlap an existing request' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER leave_requests_no_overlap BEFORE INSERT OR UPDATE ON leave_requests
  FOR EACH ROW EXECUTE FUNCTION public.leave_requests_no_overlap();
REVOKE ALL ON FUNCTION public.leave_requests_no_overlap() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.leave_requests_no_overlap() FROM figbloom_app;

ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY leave_requests_tenant ON leave_requests FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY leave_requests_owner ON leave_requests FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'leave_requests'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'leave_requests'));

GRANT SELECT, INSERT ON leave_requests TO figbloom_app;
GRANT UPDATE (status, reviewed_by, reviewed_at, review_note, updated_at) ON leave_requests TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON leave_requests FROM figbloom_app;
