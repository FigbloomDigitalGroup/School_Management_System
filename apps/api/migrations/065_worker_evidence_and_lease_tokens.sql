-- Post-remediation audit (N-1, N-2, N-3). Forward-only; 001–064 are historical and untouched.
--
-- N-1 (HIGH): a worker holding a valid lease could settle a payment as failed/cancelled/timeout with NO provider
--   evidence, and a genuine later callback could not credit it. A lease proves the worker may PROCESS a job; it
--   never proves what the provider said. Now:
--     * a terminal UNPAID outcome requires a persisted, authenticated provider callback carrying a documented
--       FINAL failure code (1, 1001, 1032, 1037, 2001: the same set as mpesaProvider.ts REASON — a TS/SQL twin).
--       The unpaid status and reason are DERIVED here from that stored code; the worker's own claim is only checked
--       for agreement. Missing evidence never becomes failure evidence: the payment stays pending, the worker's
--       observation is recorded as outcome 'failure_unconfirmed', and reconciliation (stale_pending_prompt) puts it
--       in front of a person.
--     * conflicting stored evidence (a success claim AND a final failure code) changes nothing, is audited as
--       'finance.mpesa.settlement_conflict' and returned as 'conflict'.
-- N-2: lease identity was a caller-supplied string and extension had no total cap. Now jobs_claim() issues an
--   unguessable per-claim lease_token (two random UUIDs, 244 bits); every lifecycle function demands it; the
--   worker and app roles cannot read it (column-level SELECT); a lease can never exceed 3600 s from its claim.
--   leased_by is kept as a human-readable label only.
-- N-3: figbloom_worker loses INSERT on security_audit_events entirely. Every job.* and finance.* event is written
--   inside the SECURITY DEFINER functions from persisted job state.

-- ---------------------------------------------------------------------------------------------------------
-- 1. Lease token + claim time. Column-level privileges hide the token from the worker and the app.
ALTER TABLE public.jobs ADD COLUMN lease_token text;
ALTER TABLE public.jobs ADD COLUMN lease_started_at timestamptz;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_lease_token_len_chk CHECK (lease_token IS NULL OR char_length(lease_token) BETWEEN 1 AND 128);

REVOKE SELECT ON TABLE public.jobs FROM figbloom_worker;
REVOKE SELECT ON TABLE public.jobs FROM figbloom_app;
GRANT SELECT (id, tenant_id, job_type, payload, idempotency_key, status, attempts, max_attempts, run_after,
              lease_expires_at, leased_by, last_error_code, enqueued_by_user_id, enqueued_at, finished_at,
              cancel_reason, lease_started_at)
  ON TABLE public.jobs TO figbloom_worker, figbloom_app;
-- The app only ENQUEUES: it may not choose lease state.
REVOKE INSERT ON TABLE public.jobs FROM figbloom_app;
GRANT INSERT (tenant_id, job_type, payload, idempotency_key, run_after, enqueued_by_user_id)
  ON TABLE public.jobs TO figbloom_app;

-- ---------------------------------------------------------------------------------------------------------
-- 2. N-3: the worker cannot write audit rows at all.
REVOKE INSERT ON TABLE public.security_audit_events FROM figbloom_worker;
CREATE OR REPLACE FUNCTION public.security_audit_events_worker_scope() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_user = 'figbloom_worker' THEN
    RAISE EXCEPTION 'the worker role cannot write audit events directly; they are emitted by trusted functions' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------------------------
-- 3. Evidence outcome for an observed-but-unconfirmed failure.
ALTER TABLE public.finance_mpesa_events DROP CONSTRAINT finance_mpesa_events_outcome_chk;
ALTER TABLE public.finance_mpesa_events ADD CONSTRAINT finance_mpesa_events_outcome_chk CHECK (outcome IN (
  'settled_success', 'settled_failure', 'already_settled', 'provider_pending', 'provider_error', 'not_sent',
  'callback_received', 'duplicate_receipt', 'evidence_recovered', 'evidence_conflict', 'operator_inconclusive',
  'failure_unconfirmed'));

-- ---------------------------------------------------------------------------------------------------------
-- 4. Lifecycle functions with lease tokens. Old signatures are dropped (their parameter was a bare string).
DROP FUNCTION public.jobs_claim(text, integer, text[]);
DROP FUNCTION public.jobs_assert_lease(uuid, text, integer);
DROP FUNCTION public.jobs_complete(uuid, text, integer);
DROP FUNCTION public.jobs_retry(uuid, text, integer, integer, text);
DROP FUNCTION public.jobs_dead(uuid, text, integer, text, text);
DROP FUNCTION public.jobs_extend_lease(uuid, text, integer, integer);
DROP FUNCTION public.finance_worker_settle_payment(uuid, text, integer, uuid, text, text, text);

CREATE FUNCTION public.jobs_claim(p_worker text, p_lease_seconds integer, p_types text[])
RETURNS TABLE (id uuid, tenant_id uuid, job_type text, attempts integer, lease_token text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF session_user IS DISTINCT FROM 'figbloom_worker' THEN
    RAISE EXCEPTION 'jobs_claim is executable only as figbloom_worker' USING ERRCODE = '42501';
  END IF;
  IF p_worker IS NULL OR char_length(btrim(p_worker)) < 1 OR char_length(p_worker) > 80 THEN
    RAISE EXCEPTION 'worker name required' USING ERRCODE = '22023';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 3600 THEN
    RAISE EXCEPTION 'lease must be 5..3600 seconds' USING ERRCODE = '22023';
  END IF;

  WITH expired AS (
    SELECT j2.id
      FROM public.jobs j2
      JOIN public.tenants t2 ON t2.id = j2.tenant_id
     WHERE j2.job_type = ANY (p_types)
       AND t2.status <> 'suspended'
       AND j2.status = 'leased'
       AND j2.lease_expires_at < now()
       AND j2.attempts >= j2.max_attempts
     ORDER BY j2.run_after, j2.id
     FOR UPDATE OF j2 SKIP LOCKED
     LIMIT 8
  ), dead AS (
    UPDATE public.jobs j
       SET status = 'dead',
           finished_at = now(),
           lease_expires_at = NULL,
           leased_by = NULL,
           lease_token = NULL,
           lease_started_at = NULL,
           last_error_code = COALESCE(NULLIF(j.last_error_code, ''), 'lease_exhausted')
      FROM expired e
     WHERE j.id = e.id
    RETURNING j.id, j.tenant_id, j.job_type, j.attempts, j.last_error_code, j.enqueued_by_user_id
  )
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  SELECT NULL, d.tenant_id, 'job.dead',
         jsonb_build_object(
           'jobId', d.id, 'jobType', d.job_type, 'attempt', d.attempts, 'errorCode', d.last_error_code,
           'reason', 'lease_exhausted', 'actingVia', 'worker', 'enqueuedByUserId', d.enqueued_by_user_id)
    FROM dead d;

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
         lease_started_at = now(),
         leased_by = p_worker,
         lease_token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
   WHERE j.id = v_id
  RETURNING j.id, j.tenant_id, j.job_type, j.attempts, j.lease_token;
END;
$$;
REVOKE ALL ON FUNCTION public.jobs_claim(text, integer, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.jobs_claim(text, integer, text[]) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.jobs_claim(text, integer, text[]) TO figbloom_worker;

-- Shared lease predicate: tenant context + status + TOKEN + fencing attempt + unexpired.
CREATE FUNCTION public.jobs_assert_lease(p_job_id uuid, p_lease_token text, p_attempt integer) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.app_current_tenant_id();
BEGIN
  IF session_user IS DISTINCT FROM 'figbloom_worker' THEN
    RAISE EXCEPTION 'jobs_assert_lease is executable only as figbloom_worker' USING ERRCODE = '42501';
  END IF;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no tenant context' USING ERRCODE = '42501'; END IF;
  IF p_job_id IS NULL OR p_lease_token IS NULL OR char_length(p_lease_token) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'lease token required' USING ERRCODE = '22023';
  END IF;
  IF p_attempt IS NULL OR p_attempt < 1 THEN RAISE EXCEPTION 'invalid fencing token' USING ERRCODE = '22023'; END IF;
  PERFORM 1 FROM public.jobs j
   WHERE j.id = p_job_id AND j.tenant_id = v_tenant AND j.status = 'leased'
     AND j.lease_token = p_lease_token AND j.attempts = p_attempt
     AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at > now()
   FOR UPDATE;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.jobs_assert_lease(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.jobs_assert_lease(uuid, text, integer) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.jobs_assert_lease(uuid, text, integer) TO figbloom_worker;

-- The worker cannot SELECT lease_token, so the claimed job's private fields are read through the lease.
CREATE FUNCTION public.jobs_load_leased(p_job_id uuid, p_lease_token text, p_attempt integer)
RETURNS TABLE (payload jsonb, enqueued_by_user_id uuid, max_attempts integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.app_current_tenant_id();
BEGIN
  IF session_user IS DISTINCT FROM 'figbloom_worker' THEN
    RAISE EXCEPTION 'jobs_load_leased is executable only as figbloom_worker' USING ERRCODE = '42501';
  END IF;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no tenant context' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  SELECT j.payload, j.enqueued_by_user_id, j.max_attempts FROM public.jobs j
   WHERE j.id = p_job_id AND j.tenant_id = v_tenant AND j.status = 'leased'
     AND j.lease_token = p_lease_token AND j.attempts = p_attempt
     AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at > now();
END;
$$;
REVOKE ALL ON FUNCTION public.jobs_load_leased(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.jobs_load_leased(uuid, text, integer) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.jobs_load_leased(uuid, text, integer) TO figbloom_worker;

CREATE FUNCTION public.jobs_complete(p_job_id uuid, p_lease_token text, p_attempt integer) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.app_current_tenant_id();
  v_job public.jobs%ROWTYPE;
BEGIN
  IF session_user IS DISTINCT FROM 'figbloom_worker' THEN
    RAISE EXCEPTION 'jobs_complete is executable only as figbloom_worker' USING ERRCODE = '42501';
  END IF;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no tenant context' USING ERRCODE = '42501'; END IF;
  IF p_job_id IS NULL OR p_lease_token IS NULL OR char_length(p_lease_token) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'lease token required' USING ERRCODE = '22023';
  END IF;
  IF p_attempt IS NULL OR p_attempt < 1 THEN RAISE EXCEPTION 'invalid fencing token' USING ERRCODE = '22023'; END IF;
  UPDATE public.jobs j
     SET status = 'succeeded', finished_at = now(), lease_expires_at = NULL, leased_by = NULL,
         lease_token = NULL, lease_started_at = NULL, last_error_code = NULL
   WHERE j.id = p_job_id AND j.tenant_id = v_tenant AND j.status = 'leased'
     AND j.lease_token = p_lease_token AND j.attempts = p_attempt
     AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at > now()
  RETURNING * INTO v_job;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (NULL, v_tenant, 'job.succeeded',
          jsonb_build_object('jobId', v_job.id, 'jobType', v_job.job_type, 'attempt', v_job.attempts,
                             'actingVia', 'worker', 'enqueuedByUserId', v_job.enqueued_by_user_id, 'outcome', 'succeeded'));
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.jobs_complete(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.jobs_complete(uuid, text, integer) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.jobs_complete(uuid, text, integer) TO figbloom_worker;

CREATE FUNCTION public.jobs_retry(p_job_id uuid, p_lease_token text, p_attempt integer, p_backoff_seconds integer, p_error_code text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.app_current_tenant_id();
  v_job public.jobs%ROWTYPE;
BEGIN
  IF session_user IS DISTINCT FROM 'figbloom_worker' THEN
    RAISE EXCEPTION 'jobs_retry is executable only as figbloom_worker' USING ERRCODE = '42501';
  END IF;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no tenant context' USING ERRCODE = '42501'; END IF;
  IF p_job_id IS NULL OR p_lease_token IS NULL OR char_length(p_lease_token) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'lease token required' USING ERRCODE = '22023';
  END IF;
  IF p_attempt IS NULL OR p_attempt < 1 THEN RAISE EXCEPTION 'invalid fencing token' USING ERRCODE = '22023'; END IF;
  IF p_backoff_seconds IS NULL OR p_backoff_seconds NOT BETWEEN 1 AND 86400 THEN
    RAISE EXCEPTION 'backoff seconds must be 1..86400' USING ERRCODE = '22023';
  END IF;
  IF p_error_code IS NULL OR p_error_code !~ '^[a-z0-9_.:-]{1,80}$' THEN
    RAISE EXCEPTION 'invalid error code' USING ERRCODE = '22023';
  END IF;
  UPDATE public.jobs j
     SET status = 'queued', run_after = now() + make_interval(secs => p_backoff_seconds),
         lease_expires_at = NULL, leased_by = NULL, lease_token = NULL, lease_started_at = NULL,
         last_error_code = p_error_code
   WHERE j.id = p_job_id AND j.tenant_id = v_tenant AND j.status = 'leased'
     AND j.lease_token = p_lease_token AND j.attempts = p_attempt AND j.attempts < j.max_attempts
     AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at > now()
  RETURNING * INTO v_job;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (NULL, v_tenant, 'job.retry_scheduled',
          jsonb_build_object('jobId', v_job.id, 'jobType', v_job.job_type, 'attempt', v_job.attempts,
                             'actingVia', 'worker', 'enqueuedByUserId', v_job.enqueued_by_user_id,
                             'errorCode', p_error_code, 'reason', 'retry', 'outcome', 'retry'));
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.jobs_retry(uuid, text, integer, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.jobs_retry(uuid, text, integer, integer, text) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.jobs_retry(uuid, text, integer, integer, text) TO figbloom_worker;

CREATE FUNCTION public.jobs_dead(p_job_id uuid, p_lease_token text, p_attempt integer, p_error_code text, p_reason text DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.app_current_tenant_id();
  v_job public.jobs%ROWTYPE;
  v_reason text;
BEGIN
  IF session_user IS DISTINCT FROM 'figbloom_worker' THEN
    RAISE EXCEPTION 'jobs_dead is executable only as figbloom_worker' USING ERRCODE = '42501';
  END IF;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no tenant context' USING ERRCODE = '42501'; END IF;
  IF p_job_id IS NULL OR p_lease_token IS NULL OR char_length(p_lease_token) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'lease token required' USING ERRCODE = '22023';
  END IF;
  IF p_attempt IS NULL OR p_attempt < 1 THEN RAISE EXCEPTION 'invalid fencing token' USING ERRCODE = '22023'; END IF;
  IF p_error_code IS NULL OR p_error_code !~ '^[a-z0-9_.:-]{1,80}$' THEN
    RAISE EXCEPTION 'invalid error code' USING ERRCODE = '22023';
  END IF;
  UPDATE public.jobs j
     SET status = 'dead', finished_at = now(), lease_expires_at = NULL, leased_by = NULL,
         lease_token = NULL, lease_started_at = NULL, last_error_code = p_error_code
   WHERE j.id = p_job_id AND j.tenant_id = v_tenant AND j.status = 'leased'
     AND j.lease_token = p_lease_token AND j.attempts = p_attempt
     AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at > now()
  RETURNING * INTO v_job;
  IF NOT FOUND THEN RETURN false; END IF;
  v_reason := COALESCE(NULLIF(btrim(p_reason), ''),
    CASE WHEN p_error_code = 'max_attempts' OR v_job.attempts >= v_job.max_attempts THEN 'max_attempts' ELSE 'permanent_error' END);
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (NULL, v_tenant, 'job.dead',
          jsonb_build_object('jobId', v_job.id, 'jobType', v_job.job_type, 'attempt', v_job.attempts,
                             'actingVia', 'worker', 'enqueuedByUserId', v_job.enqueued_by_user_id,
                             'errorCode', p_error_code, 'reason', v_reason, 'outcome', 'dead'));
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.jobs_dead(uuid, text, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.jobs_dead(uuid, text, integer, text, text) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.jobs_dead(uuid, text, integer, text, text) TO figbloom_worker;

-- Bounded renewal: the lease can never run past claim time + 3600 s, however often it is renewed.
CREATE FUNCTION public.jobs_extend_lease(p_job_id uuid, p_lease_token text, p_attempt integer, p_extra_seconds integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.app_current_tenant_id();
  v_cap constant integer := 3600;
BEGIN
  IF session_user IS DISTINCT FROM 'figbloom_worker' THEN
    RAISE EXCEPTION 'jobs_extend_lease is executable only as figbloom_worker' USING ERRCODE = '42501';
  END IF;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no tenant context' USING ERRCODE = '42501'; END IF;
  IF p_job_id IS NULL OR p_lease_token IS NULL OR char_length(p_lease_token) NOT BETWEEN 1 AND 128 THEN
    RAISE EXCEPTION 'lease token required' USING ERRCODE = '22023';
  END IF;
  IF p_attempt IS NULL OR p_attempt < 1 THEN RAISE EXCEPTION 'invalid fencing token' USING ERRCODE = '22023'; END IF;
  IF p_extra_seconds IS NULL OR p_extra_seconds NOT BETWEEN 5 AND 3600 THEN
    RAISE EXCEPTION 'lease extension must be 5..3600 seconds' USING ERRCODE = '22023';
  END IF;
  UPDATE public.jobs j
     SET lease_expires_at = LEAST(GREATEST(j.lease_expires_at, now()) + make_interval(secs => p_extra_seconds),
                                  j.lease_started_at + make_interval(secs => v_cap))
   WHERE j.id = p_job_id AND j.tenant_id = v_tenant AND j.status = 'leased'
     AND j.lease_token = p_lease_token AND j.attempts = p_attempt
     AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at > now()
     AND j.lease_started_at IS NOT NULL AND j.lease_expires_at < j.lease_started_at + make_interval(secs => v_cap);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lease extension refused: no current matching job lease, or the maximum lease duration is reached' USING ERRCODE = '42501';
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.jobs_extend_lease(uuid, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.jobs_extend_lease(uuid, text, integer, integer) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.jobs_extend_lease(uuid, text, integer, integer) TO figbloom_worker;

-- ---------------------------------------------------------------------------------------------------------
-- 5. Settlement: provider evidence, not a lease, decides the financial outcome.
CREATE FUNCTION public.finance_worker_settle_payment(
  p_job_id uuid,
  p_lease_token text,
  p_attempts integer,
  p_payment_id uuid,
  p_status text,
  p_mpesa_receipt text DEFAULT NULL,
  p_failure_reason text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_job public.jobs%ROWTYPE;
  v_pay public.finance_payments%ROWTYPE;
  v_invoice_id uuid;
  v_receipt text;
  v_applied_minor bigint;
  v_unapplied_minor bigint;
  v_has_success boolean;
  v_fail_code integer;
  v_fail_status text;
  v_fail_reason text;
BEGIN
  IF session_user IS DISTINCT FROM 'figbloom_worker' THEN
    RAISE EXCEPTION 'finance_worker_settle_payment is executable only as figbloom_worker' USING ERRCODE = '42501';
  END IF;
  IF p_job_id IS NULL OR p_lease_token IS NULL OR p_attempts IS NULL OR p_payment_id IS NULL THEN
    RAISE EXCEPTION 'settlement requires a job lease and a payment' USING ERRCODE = '22023';
  END IF;
  IF char_length(p_lease_token) NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'invalid lease token' USING ERRCODE = '22023'; END IF;
  IF p_attempts < 1 THEN RAISE EXCEPTION 'invalid fencing token' USING ERRCODE = '22023'; END IF;
  IF p_status NOT IN ('success', 'failed', 'cancelled', 'timeout') THEN
    RAISE EXCEPTION 'unsupported settlement status' USING ERRCODE = '22023';
  END IF;

  -- The lease only proves the right to PROCESS this job. Tenant comes from the job row, not the GUC.
  SELECT * INTO v_job FROM public.jobs j
   WHERE j.id = p_job_id AND j.status = 'leased' AND j.lease_token = p_lease_token AND j.attempts = p_attempts
     AND j.lease_expires_at IS NOT NULL AND j.lease_expires_at > now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement refused: no current matching job lease' USING ERRCODE = '42501';
  END IF;
  IF v_job.job_type IS DISTINCT FROM 'mpesa.stk_settle' THEN
    RAISE EXCEPTION 'settlement refused: job type is not a settlement job' USING ERRCODE = '42501';
  END IF;
  IF lower(coalesce(v_job.payload->>'paymentId', '')) IS DISTINCT FROM lower(p_payment_id::text) THEN
    RAISE EXCEPTION 'settlement refused: payment is not the one named by the leased job' USING ERRCODE = '42501';
  END IF;

  SELECT i.id INTO v_invoice_id
    FROM public.finance_invoices i
    JOIN public.finance_payments p ON p.invoice_id = i.id AND p.tenant_id = i.tenant_id
   WHERE p.id = p_payment_id AND p.tenant_id = v_job.tenant_id AND p.method = 'mpesa'
   FOR UPDATE OF i;
  IF v_invoice_id IS NULL THEN
    RAISE EXCEPTION 'settlement refused: payment not found for the leased job tenant' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO v_pay FROM public.finance_payments p
   WHERE p.id = p_payment_id AND p.tenant_id = v_job.tenant_id AND p.method = 'mpesa' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement refused: payment not found for the leased job tenant' USING ERRCODE = 'P0002';
  END IF;

  -- Persisted, authenticated callback evidence (the worker cannot insert source='callback').
  SELECT EXISTS (SELECT 1 FROM public.finance_mpesa_events e
                  WHERE e.tenant_id = v_job.tenant_id AND e.payment_id = p_payment_id AND e.source = 'callback'
                    AND e.outcome = 'callback_received' AND e.result_code = 0 AND e.receipt IS NOT NULL)
    INTO v_has_success;
  SELECT e.result_code INTO v_fail_code
    FROM public.finance_mpesa_events e
   WHERE e.tenant_id = v_job.tenant_id AND e.payment_id = p_payment_id AND e.source = 'callback'
     AND e.outcome = 'callback_received' AND e.result_code IN (1, 1001, 1032, 1037, 2001)
   ORDER BY e.received_at, e.id LIMIT 1;

  -- A request whose outcome disagrees with the stored terminal state is a conflict, never "already settled".
  IF v_pay.status IS DISTINCT FROM 'pending' THEN
    IF p_status = 'success' AND v_pay.status = 'success' AND p_mpesa_receipt IS NOT NULL
       AND v_pay.mpesa_receipt = p_mpesa_receipt THEN
      RETURN 'already_settled';
    END IF;
    IF p_status <> 'success' AND v_pay.status = p_status THEN
      RETURN 'already_settled';
    END IF;
    INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
    VALUES (NULL, v_job.tenant_id, 'finance.mpesa.settlement_conflict',
            jsonb_build_object('paymentId', p_payment_id, 'invoiceId', v_pay.invoice_id, 'storedStatus', v_pay.status,
                               'storedReceipt', v_pay.mpesa_receipt, 'requestedStatus', p_status, 'reason', 'terminal_state_differs',
                               'source', 'status_query', 'actingVia', 'worker', 'jobId', v_job.id,
                               'jobType', v_job.job_type, 'attempt', v_job.attempts));
    RETURN 'conflict';
  END IF;

  -- Contradictory stored provider evidence: preserve it, change nothing, escalate.
  IF v_has_success AND v_fail_code IS NOT NULL THEN
    INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
    VALUES (NULL, v_job.tenant_id, 'finance.mpesa.settlement_conflict',
            jsonb_build_object('paymentId', p_payment_id, 'invoiceId', v_pay.invoice_id, 'requestedStatus', p_status,
                               'reason', 'contradictory_callbacks', 'failureCode', v_fail_code,
                               'source', 'status_query', 'actingVia', 'worker', 'jobId', v_job.id,
                               'jobType', v_job.job_type, 'attempt', v_job.attempts));
    RETURN 'conflict';
  END IF;

  IF p_status = 'success' THEN
    v_receipt := upper(btrim(coalesce(p_mpesa_receipt, '')));
    IF v_receipt !~ '^[A-Z0-9]{6,20}$' THEN
      RAISE EXCEPTION 'success settlement requires a well-formed receipt' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.finance_mpesa_events e
                    WHERE e.tenant_id = v_job.tenant_id AND e.payment_id = p_payment_id AND e.source = 'callback'
                      AND e.outcome = 'callback_received' AND e.result_code = 0 AND e.receipt IS NOT DISTINCT FROM v_receipt) THEN
      RAISE EXCEPTION 'success settlement requires a stored authenticated callback receipt' USING ERRCODE = '42501';
    END IF;
    UPDATE public.finance_payments
       SET status = 'success', mpesa_receipt = v_receipt, failure_reason = NULL
     WHERE id = v_pay.id AND tenant_id = v_job.tenant_id AND status = 'pending'
    RETURNING applied_minor, unapplied_minor INTO v_applied_minor, v_unapplied_minor;
    IF NOT FOUND THEN RETURN 'already_settled'; END IF;
    INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
    VALUES (NULL, v_job.tenant_id, 'finance.mpesa.settled',
            jsonb_build_object('paymentId', p_payment_id, 'invoiceId', v_pay.invoice_id, 'outcome', 'success',
                               'receiptBasis', 'stored_callback', 'amountMinor', v_pay.amount_minor,
                               'source', 'status_query', 'actingVia', 'worker', 'jobId', v_job.id,
                               'jobType', v_job.job_type, 'attempt', v_job.attempts));
    IF COALESCE(v_unapplied_minor, 0) > 0 THEN
      INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
      VALUES (NULL, v_job.tenant_id, 'finance.payment.unapplied',
              jsonb_build_object('paymentId', p_payment_id, 'invoiceId', v_pay.invoice_id, 'amountMinor', v_pay.amount_minor,
                                 'appliedMinor', v_applied_minor, 'unappliedMinor', v_unapplied_minor,
                                 'source', 'status_query', 'actingVia', 'worker', 'jobId', v_job.id,
                                 'jobType', v_job.job_type, 'attempt', v_job.attempts));
    END IF;
    RETURN 'settled_success';
  END IF;

  -- Unpaid outcome. A lease is NOT evidence: without a stored authenticated final-failure callback the payment
  -- stays pending and the observation is recorded for reconciliation.
  IF v_fail_code IS NULL OR v_has_success THEN
    INSERT INTO public.finance_mpesa_events (tenant_id, payment_id, checkout_request_id, source, outcome, result_code)
    SELECT v_job.tenant_id, v_pay.id, v_pay.checkout_request_id, 'status_query', 'failure_unconfirmed', NULL
     WHERE v_pay.checkout_request_id IS NOT NULL;
    RETURN 'evidence_required';
  END IF;
  v_fail_status := CASE v_fail_code WHEN 1032 THEN 'cancelled' WHEN 1037 THEN 'timeout' ELSE 'failed' END;
  v_fail_reason := CASE v_fail_code WHEN 1 THEN 'insufficient' WHEN 1032 THEN 'cancelled' WHEN 1037 THEN 'timeout'
                                    WHEN 2001 THEN 'wrong_pin' WHEN 1001 THEN 'duplicate' END;
  IF p_status IS DISTINCT FROM v_fail_status THEN
    RAISE EXCEPTION 'requested outcome disagrees with the stored provider evidence' USING ERRCODE = '22023';
  END IF;
  UPDATE public.finance_payments
     SET status = v_fail_status, failure_reason = v_fail_reason, mpesa_receipt = NULL
   WHERE id = v_pay.id AND tenant_id = v_job.tenant_id AND status = 'pending';
  IF NOT FOUND THEN RETURN 'already_settled'; END IF;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (NULL, v_job.tenant_id, 'finance.mpesa.settled',
          jsonb_build_object('paymentId', p_payment_id, 'outcome', v_fail_status, 'reason', v_fail_reason,
                             'evidenceBasis', 'stored_callback', 'resultCode', v_fail_code,
                             'source', 'status_query', 'actingVia', 'worker', 'jobId', v_job.id,
                             'jobType', v_job.job_type, 'attempt', v_job.attempts));
  RETURN 'settled_failure';
END;
$$;
REVOKE ALL ON FUNCTION public.finance_worker_settle_payment(uuid, text, integer, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finance_worker_settle_payment(uuid, text, integer, uuid, text, text, text) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.finance_worker_settle_payment(uuid, text, integer, uuid, text, text, text) TO figbloom_worker;
