-- Stage 4: Asynchronous XLSX / DOCX / CSV / JSON Export Jobs integrated with S3 storage.
-- Forward-only.

ALTER TABLE jobs DROP CONSTRAINT jobs_type_chk;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_chk
  CHECK (job_type IN ('mpesa.stk_settle', 'announcement.push', 'notification.dispatch', 'export.generate'));

CREATE TABLE export_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  requested_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  dataset           text NOT NULL,
  format            text NOT NULL,
  filters           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status            text NOT NULL DEFAULT 'queued',
  storage_object_id uuid,
  file_name         text,
  content_type      text,
  byte_size         bigint,
  row_count         integer,
  error_code        text,
  expires_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  CONSTRAINT export_jobs_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT export_jobs_storage_fk FOREIGN KEY (storage_object_id, tenant_id)
    REFERENCES storage_objects (id, tenant_id) ON DELETE SET NULL (storage_object_id),
  CONSTRAINT export_jobs_dataset_chk CHECK (dataset IN ('overview', 'attendance', 'finance', 'academics', 'learners')),
  CONSTRAINT export_jobs_format_chk CHECK (format IN ('xlsx', 'docx', 'csv', 'json')),
  CONSTRAINT export_jobs_status_chk CHECK (status IN ('queued', 'processing', 'completed', 'failed', 'expired')),
  CONSTRAINT export_jobs_filters_obj CHECK (jsonb_typeof(filters) = 'object')
);

CREATE INDEX export_jobs_tenant_created_idx ON export_jobs (tenant_id, created_at DESC, id);

ALTER TABLE export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY export_jobs_tenant ON export_jobs FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY export_jobs_worker ON export_jobs FOR ALL TO figbloom_worker
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY export_jobs_owner ON export_jobs FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'export_jobs'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'export_jobs'));

GRANT SELECT, INSERT ON export_jobs TO figbloom_app;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON export_jobs FROM figbloom_app;

GRANT SELECT ON export_jobs TO figbloom_worker;
GRANT UPDATE (status, storage_object_id, file_name, content_type, byte_size, row_count, error_code, expires_at, completed_at) ON export_jobs TO figbloom_worker;
REVOKE INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER ON export_jobs FROM figbloom_worker;

-- Worker maintenance: expire completed export jobs past their retention window
CREATE FUNCTION public.worker_expire_export_jobs(p_limit integer DEFAULT 200)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 1000);
  v_count integer := 0;
BEGIN
  WITH due AS (
    SELECT id FROM public.export_jobs
     WHERE status = 'completed'
       AND expires_at IS NOT NULL
       AND expires_at < now()
     ORDER BY expires_at
     LIMIT v_limit
  )
  UPDATE public.export_jobs ej
     SET status = 'expired'
    FROM due d
   WHERE ej.id = d.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.worker_expire_export_jobs(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.worker_expire_export_jobs(integer) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.worker_expire_export_jobs(integer) TO figbloom_worker;

-- Worker read grants + RLS policies needed to generate authorized tenant-scoped export datasets under RLS
GRANT SELECT ON learners, academic_terms, attendance, finance_invoices, finance_payments, assessments, classes, staff_members TO figbloom_worker;

CREATE POLICY learners_worker_select ON learners FOR ALL TO figbloom_worker USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY academic_terms_worker_select ON academic_terms FOR ALL TO figbloom_worker USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY attendance_worker_select ON attendance FOR ALL TO figbloom_worker USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY assessments_worker_select ON assessments FOR ALL TO figbloom_worker USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY classes_worker_select ON classes FOR ALL TO figbloom_worker USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY staff_members_worker_select ON staff_members FOR ALL TO figbloom_worker USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
