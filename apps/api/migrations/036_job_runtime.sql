-- Stage 11 prerequisite: tenant-isolated background jobs (implements docs/WORKER-ISOLATION-PROPOSAL.md).
-- Forward-only. No earlier migration is edited.
--
-- * figbloom_worker: a separate service identity (NOLOGIN until an operator enables it with its own
--   secret), NOINHERIT, no BYPASSRLS, owns nothing. Never the API's or the migrator's credential.
-- * jobs: tenant_id NOT NULL, registered job_type, per-tenant idempotency key, lease columns,
--   ENABLE + FORCE RLS. The tenant is written by trusted server code in the originating request
--   transaction (the transactional outbox): never read from the payload.
-- * jobs_claim(): the ONLY cross-tenant step. SECURITY DEFINER, returns (id, tenant_id, job_type,
--   attempts) of one due job, leased under FOR UPDATE SKIP LOCKED, skipping suspended schools. It
--   returns no payload. All job work then runs in a transaction with app.tenant_id set locally to the
--   claimed tenant, under RLS, as figbloom_worker.
-- * Lease design (open question (a) of the proposal, settled here): claim commits a lease; the
--   attempt runs in its own tenant-scoped transaction and records success; a failure is recorded in a
--   separate tenant-scoped transaction (backoff with jitter, max attempts, then 'dead'). A crashed
--   attempt's lease expires and the job is claimable again. A poison job cannot block others
--   (SKIP LOCKED + lease expiry).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'figbloom_worker') THEN
    CREATE ROLE figbloom_worker NOINHERIT NOLOGIN;
  END IF;
END
$$;

-- The migrator may SET ROLE for privilege tests (same convention as figbloom_app, migration 004).
GRANT figbloom_worker TO CURRENT_USER;

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  job_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8,
  run_after timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  leased_by text,
  last_error_code text,
  enqueued_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  cancel_reason text,
  CONSTRAINT jobs_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT jobs_idempotency_uidx UNIQUE (tenant_id, job_type, idempotency_key),
  CONSTRAINT jobs_type_chk CHECK (job_type IN ('mpesa.stk_settle')),
  CONSTRAINT jobs_status_chk CHECK (status IN ('queued', 'leased', 'succeeded', 'dead', 'cancelled')),
  CONSTRAINT jobs_attempts_chk CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 50 AND attempts <= max_attempts),
  CONSTRAINT jobs_key_len CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT jobs_payload_obj CHECK (jsonb_typeof(payload) = 'object' AND NOT payload ? 'tenant_id' AND NOT payload ? 'tenantId'),
  CONSTRAINT jobs_lease_chk CHECK ((status = 'leased') = (lease_expires_at IS NOT NULL)),
  CONSTRAINT jobs_error_len CHECK (last_error_code IS NULL OR char_length(last_error_code) BETWEEN 1 AND 80),
  CONSTRAINT jobs_cancel_chk CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL))
);

CREATE INDEX jobs_due_idx ON jobs (run_after) WHERE status = 'queued';
CREATE INDEX jobs_lease_idx ON jobs (lease_expires_at) WHERE status = 'leased';

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;

CREATE POLICY jobs_tenant ON jobs FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY jobs_worker ON jobs FOR ALL TO figbloom_worker
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY jobs_owner ON jobs FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'jobs'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'jobs'));

-- The API enqueues (outbox) and may read its school's job status; it never claims or updates jobs.
GRANT SELECT, INSERT ON jobs TO figbloom_app;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON jobs FROM figbloom_app;
-- The worker records outcomes on rows it can see (its claimed tenant only).
GRANT SELECT ON jobs TO figbloom_worker;
GRANT UPDATE (status, attempts, run_after, lease_expires_at, leased_by, last_error_code, finished_at, cancel_reason) ON jobs TO figbloom_worker;

-- Jobs are immutable in identity: tenant, type, payload, key and enqueuer never change.
CREATE FUNCTION public.jobs_identity_immutable() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.tenant_id, NEW.job_type, NEW.payload, NEW.idempotency_key, NEW.enqueued_by_user_id, NEW.enqueued_at)
     IS DISTINCT FROM (OLD.tenant_id, OLD.job_type, OLD.payload, OLD.idempotency_key, OLD.enqueued_by_user_id, OLD.enqueued_at) THEN
    RAISE EXCEPTION 'job identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status IN ('succeeded', 'dead', 'cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'a finished job is final' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER jobs_identity_immutable BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_identity_immutable();

-- Claim one due job across tenants. Returns ids only; the payload is read afterwards under RLS.
CREATE FUNCTION public.jobs_claim(p_worker text, p_lease_seconds integer, p_types text[])
RETURNS TABLE (id uuid, tenant_id uuid, job_type text, attempts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_worker IS NULL OR char_length(p_worker) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'worker name required' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 3600 THEN
    RAISE EXCEPTION 'lease must be 5..3600 seconds' USING ERRCODE = '22023';
  END IF;
  SELECT j.id INTO v_id
    FROM public.jobs j
    JOIN public.tenants t ON t.id = j.tenant_id
   WHERE j.job_type = ANY (p_types)
     AND t.status <> 'suspended'
     AND ((j.status = 'queued' AND j.run_after <= now())
          OR (j.status = 'leased' AND j.lease_expires_at < now() AND j.attempts < j.max_attempts))
   ORDER BY j.run_after, j.id
   FOR UPDATE OF j SKIP LOCKED
   LIMIT 1;
  IF v_id IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  UPDATE public.jobs j
     SET status = 'leased',
         attempts = j.attempts + 1,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         leased_by = p_worker
   WHERE j.id = v_id
  RETURNING j.id, j.tenant_id, j.job_type, j.attempts;
END;
$$;

REVOKE ALL ON FUNCTION public.jobs_claim(text, integer, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.jobs_claim(text, integer, text[]) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.jobs_claim(text, integer, text[]) TO figbloom_worker;

REVOKE ALL ON FUNCTION public.jobs_identity_immutable() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.jobs_identity_immutable() FROM figbloom_app;

-- Shared infrastructure the worker needs (no tenant tables yet; Stage 11 finance grants follow in 037/038).
GRANT EXECUTE ON FUNCTION app_current_tenant_id() TO figbloom_worker;
GRANT INSERT ON TABLE security_audit_events TO figbloom_worker;
