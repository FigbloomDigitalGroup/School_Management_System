-- Stage 11 audit remediation (F8-A, F8-B, F8-C, F8-D, M3-A): worker lease and settlement authority hardening.
-- Forward-only. No earlier migration is edited.
--
-- 1) F8-A: figbloom_worker loses all direct UPDATE privileges on public.jobs (both table-level and column-level).
--    A compromised worker can no longer manufacture or extend its own lease, alter status, or forge fencing tokens.
--    All worker job lifecycle transitions after jobs_claim() now go through narrowly scoped SECURITY DEFINER
--    functions executable only by figbloom_worker (session_user = 'figbloom_worker') and bound to
--    app_current_tenant_id() + active lease holder + fencing token (attempts) + non-expired lease:
--      * jobs_assert_lease(p_job_id, p_worker, p_attempt) -> boolean (locks job row FOR UPDATE for ctx.fenced)
--      * jobs_complete(p_job_id, p_worker, p_attempt) -> boolean (transitions leased -> succeeded + audits job.succeeded)
--      * jobs_retry(p_job_id, p_worker, p_attempt, p_backoff_seconds, p_error_code) -> boolean (leased -> queued + audits job.retry_scheduled)
--      * jobs_dead(p_job_id, p_worker, p_attempt, p_error_code, p_reason) -> boolean (leased -> dead + audits job.dead)
--      * jobs_extend_lease(p_job_id, p_worker, p_attempt, p_extra_seconds) -> boolean (M3-A bounded active lease extension)
-- 2) F8-B: figbloom_worker can no longer directly INSERT 'finance.mpesa.settled' or 'finance.payment.unapplied'
--    into security_audit_events. Settlement and unapplied-amount audit rows for worker settlements are emitted
--    exclusively inside finance_worker_settle_payment(). Legitimate operational job lifecycle audit events
--    ('job.succeeded', 'job.retry_scheduled', 'job.dead') remain allowed.
-- 3) F8-C: finance_worker_settle_payment() no longer returns 'already_settled' when the stored terminal state or
--    receipt conflicts with the requested outcome. Same terminal state (and exact same receipt for success)
--    returns 'already_settled'; any conflicting terminal state or receipt emits an audited conflict event and
--    returns 'conflict'.

REVOKE UPDATE (status, attempts, run_after, lease_expires_at, leased_by, last_error_code, finished_at, cancel_reason) ON TABLE public.jobs FROM figbloom_worker;
REVOKE UPDATE ON TABLE public.jobs FROM figbloom_worker;

-- Defence in depth on jobs_claim: require session_user = 'figbloom_worker'.
CREATE OR REPLACE FUNCTION public.jobs_claim(p_worker text, p_lease_seconds integer, p_types text[])
RETURNS TABLE (id uuid, tenant_id uuid, job_type text, attempts integer)
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

  -- Last attempt crashed after claim: lease expired at max_attempts. Mark dead and audit it, in one statement.
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
         leased_by = p_worker
   WHERE j.id = v_id
  RETURNING j.id, j.tenant_id, j.job_type, j.attempts;
END;
$$;

REVOKE ALL ON FUNCTION public.jobs_claim(text, integer, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.jobs_claim(text, integer, text[]) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.jobs_claim(text, integer, text[]) TO figbloom_worker;

-- ---------------------------------------------------------------------------------------------------
-- jobs_assert_lease: locks the job row FOR UPDATE and proves the caller still holds an active,
-- non-expired lease for the current tenant with matching fencing token (attempts).
CREATE FUNCTION public.jobs_assert_lease(
  p_job_id uuid,
  p_worker text,
  p_attempt integer
) RETURNS boolean
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
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no tenant context' USING ERRCODE = '42501';
  END IF;
  IF p_job_id IS NULL OR p_worker IS NULL OR char_length(btrim(p_worker)) < 1 OR char_length(p_worker) > 80 THEN
    RAISE EXCEPTION 'worker lease identity required' USING ERRCODE = '22023';
  END IF;
  IF p_attempt IS NULL OR p_attempt < 1 THEN
    RAISE EXCEPTION 'invalid fencing token' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
    FROM public.jobs j
   WHERE j.id = p_job_id
     AND j.tenant_id = v_tenant
     AND j.status = 'leased'
     AND j.leased_by = p_worker
     AND j.attempts = p_attempt
     AND j.lease_expires_at IS NOT NULL
     AND j.lease_expires_at > now()
   FOR UPDATE;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.jobs_assert_lease(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.jobs_assert_lease(uuid, text, integer) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.jobs_assert_lease(uuid, text, integer) TO figbloom_worker;

-- ---------------------------------------------------------------------------------------------------
-- jobs_complete: transitions a currently held, non-expired leased job in the current tenant to
-- 'succeeded' and writes the job.succeeded audit event in the same transaction.
CREATE FUNCTION public.jobs_complete(
  p_job_id uuid,
  p_worker text,
  p_attempt integer
) RETURNS boolean
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
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no tenant context' USING ERRCODE = '42501';
  END IF;
  IF p_job_id IS NULL OR p_worker IS NULL OR char_length(btrim(p_worker)) < 1 OR char_length(p_worker) > 80 THEN
    RAISE EXCEPTION 'worker lease identity required' USING ERRCODE = '22023';
  END IF;
  IF p_attempt IS NULL OR p_attempt < 1 THEN
    RAISE EXCEPTION 'invalid fencing token' USING ERRCODE = '22023';
  END IF;

  UPDATE public.jobs j
     SET status = 'succeeded',
         finished_at = now(),
         lease_expires_at = NULL,
         leased_by = NULL,
         last_error_code = NULL
   WHERE j.id = p_job_id
     AND j.tenant_id = v_tenant
     AND j.status = 'leased'
     AND j.leased_by = p_worker
     AND j.attempts = p_attempt
     AND j.lease_expires_at IS NOT NULL
     AND j.lease_expires_at > now()
  RETURNING * INTO v_job;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (
    NULL,
    v_tenant,
    'job.succeeded',
    jsonb_build_object(
      'jobId', v_job.id,
      'jobType', v_job.job_type,
      'attempt', v_job.attempts,
      'actingVia', 'worker',
      'enqueuedByUserId', v_job.enqueued_by_user_id,
      'outcome', 'succeeded'
    )
  );
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.jobs_complete(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.jobs_complete(uuid, text, integer) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.jobs_complete(uuid, text, integer) TO figbloom_worker;

-- ---------------------------------------------------------------------------------------------------
-- jobs_retry: releases a currently held, non-expired leased job back to 'queued' with a bounded
-- backoff delay (only when attempts < max_attempts) and writes job.retry_scheduled.
CREATE FUNCTION public.jobs_retry(
  p_job_id uuid,
  p_worker text,
  p_attempt integer,
  p_backoff_seconds integer,
  p_error_code text
) RETURNS boolean
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
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no tenant context' USING ERRCODE = '42501';
  END IF;
  IF p_job_id IS NULL OR p_worker IS NULL OR char_length(btrim(p_worker)) < 1 OR char_length(p_worker) > 80 THEN
    RAISE EXCEPTION 'worker lease identity required' USING ERRCODE = '22023';
  END IF;
  IF p_attempt IS NULL OR p_attempt < 1 THEN
    RAISE EXCEPTION 'invalid fencing token' USING ERRCODE = '22023';
  END IF;
  IF p_backoff_seconds IS NULL OR p_backoff_seconds NOT BETWEEN 1 AND 86400 THEN
    RAISE EXCEPTION 'backoff seconds must be 1..86400' USING ERRCODE = '22023';
  END IF;
  IF p_error_code IS NULL OR p_error_code !~ '^[a-z0-9_.:-]{1,80}$' THEN
    RAISE EXCEPTION 'invalid error code' USING ERRCODE = '22023';
  END IF;

  UPDATE public.jobs j
     SET status = 'queued',
         run_after = now() + make_interval(secs => p_backoff_seconds),
         lease_expires_at = NULL,
         leased_by = NULL,
         last_error_code = p_error_code
   WHERE j.id = p_job_id
     AND j.tenant_id = v_tenant
     AND j.status = 'leased'
     AND j.leased_by = p_worker
     AND j.attempts = p_attempt
     AND j.attempts < j.max_attempts
     AND j.lease_expires_at IS NOT NULL
     AND j.lease_expires_at > now()
  RETURNING * INTO v_job;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (
    NULL,
    v_tenant,
    'job.retry_scheduled',
    jsonb_build_object(
      'jobId', v_job.id,
      'jobType', v_job.job_type,
      'attempt', v_job.attempts,
      'actingVia', 'worker',
      'enqueuedByUserId', v_job.enqueued_by_user_id,
      'errorCode', p_error_code,
      'reason', 'retry',
      'outcome', 'retry'
    )
  );
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.jobs_retry(uuid, text, integer, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.jobs_retry(uuid, text, integer, integer, text) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.jobs_retry(uuid, text, integer, integer, text) TO figbloom_worker;

-- ---------------------------------------------------------------------------------------------------
-- jobs_dead: transitions a currently held, non-expired leased job to 'dead' and writes job.dead.
CREATE FUNCTION public.jobs_dead(
  p_job_id uuid,
  p_worker text,
  p_attempt integer,
  p_error_code text,
  p_reason text DEFAULT NULL
) RETURNS boolean
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
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no tenant context' USING ERRCODE = '42501';
  END IF;
  IF p_job_id IS NULL OR p_worker IS NULL OR char_length(btrim(p_worker)) < 1 OR char_length(p_worker) > 80 THEN
    RAISE EXCEPTION 'worker lease identity required' USING ERRCODE = '22023';
  END IF;
  IF p_attempt IS NULL OR p_attempt < 1 THEN
    RAISE EXCEPTION 'invalid fencing token' USING ERRCODE = '22023';
  END IF;
  IF p_error_code IS NULL OR p_error_code !~ '^[a-z0-9_.:-]{1,80}$' THEN
    RAISE EXCEPTION 'invalid error code' USING ERRCODE = '22023';
  END IF;

  UPDATE public.jobs j
     SET status = 'dead',
         finished_at = now(),
         lease_expires_at = NULL,
         leased_by = NULL,
         last_error_code = p_error_code
   WHERE j.id = p_job_id
     AND j.tenant_id = v_tenant
     AND j.status = 'leased'
     AND j.leased_by = p_worker
     AND j.attempts = p_attempt
     AND j.lease_expires_at IS NOT NULL
     AND j.lease_expires_at > now()
  RETURNING * INTO v_job;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  v_reason := COALESCE(
    NULLIF(btrim(p_reason), ''),
    CASE
      WHEN p_error_code = 'max_attempts' OR v_job.attempts >= v_job.max_attempts THEN 'max_attempts'
      ELSE 'permanent_error'
    END
  );

  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (
    NULL,
    v_tenant,
    'job.dead',
    jsonb_build_object(
      'jobId', v_job.id,
      'jobType', v_job.job_type,
      'attempt', v_job.attempts,
      'actingVia', 'worker',
      'enqueuedByUserId', v_job.enqueued_by_user_id,
      'errorCode', p_error_code,
      'reason', v_reason,
      'outcome', 'dead'
    )
  );
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.jobs_dead(uuid, text, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.jobs_dead(uuid, text, integer, text, text) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.jobs_dead(uuid, text, integer, text, text) TO figbloom_worker;

-- ---------------------------------------------------------------------------------------------------
-- jobs_extend_lease (M3-A): extends an active, non-expired lease held by p_worker at p_attempt by
-- p_extra_seconds (5..3600). Cannot revive an expired lease or extend a stolen/stale lease.
CREATE FUNCTION public.jobs_extend_lease(
  p_job_id uuid,
  p_worker text,
  p_attempt integer,
  p_extra_seconds integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.app_current_tenant_id();
BEGIN
  IF session_user IS DISTINCT FROM 'figbloom_worker' THEN
    RAISE EXCEPTION 'jobs_extend_lease is executable only as figbloom_worker' USING ERRCODE = '42501';
  END IF;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no tenant context' USING ERRCODE = '42501';
  END IF;
  IF p_job_id IS NULL OR p_worker IS NULL OR char_length(btrim(p_worker)) < 1 OR char_length(p_worker) > 80 THEN
    RAISE EXCEPTION 'worker lease identity required' USING ERRCODE = '22023';
  END IF;
  IF p_attempt IS NULL OR p_attempt < 1 THEN
    RAISE EXCEPTION 'invalid fencing token' USING ERRCODE = '22023';
  END IF;
  IF p_extra_seconds IS NULL OR p_extra_seconds NOT BETWEEN 5 AND 3600 THEN
    RAISE EXCEPTION 'lease extension must be 5..3600 seconds' USING ERRCODE = '22023';
  END IF;

  UPDATE public.jobs j
     SET lease_expires_at = GREATEST(j.lease_expires_at, now()) + make_interval(secs => p_extra_seconds)
   WHERE j.id = p_job_id
     AND j.tenant_id = v_tenant
     AND j.status = 'leased'
     AND j.leased_by = p_worker
     AND j.attempts = p_attempt
     AND j.lease_expires_at IS NOT NULL
     AND j.lease_expires_at > now();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'lease extension refused: no current matching job lease' USING ERRCODE = '42501';
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.jobs_extend_lease(uuid, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.jobs_extend_lease(uuid, text, integer, integer) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.jobs_extend_lease(uuid, text, integer, integer) TO figbloom_worker;

-- ---------------------------------------------------------------------------------------------------
-- F8-B: Remove 'finance.mpesa.settled' and 'finance.payment.unapplied' from the worker direct-insert
-- allowlist on security_audit_events. Only operational job events remain directly insertable by
-- figbloom_worker; settlement authority events are emitted inside finance_worker_settle_payment().
CREATE OR REPLACE FUNCTION public.security_audit_events_worker_scope() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_user = 'figbloom_worker' THEN
    IF NEW.tenant_id IS NULL OR NEW.tenant_id IS DISTINCT FROM public.app_current_tenant_id() THEN
      RAISE EXCEPTION 'a worker audit event is bound to the current tenant' USING ERRCODE = '42501';
    END IF;
    IF NEW.actor_user_id IS NOT NULL OR NEW.ip IS NOT NULL THEN
      RAISE EXCEPTION 'a worker audit event has no user actor and no ip' USING ERRCODE = '42501';
    END IF;
    IF NEW.detail->>'actingVia' IS DISTINCT FROM 'worker' THEN
      RAISE EXCEPTION 'a worker audit event is marked actingVia worker' USING ERRCODE = '42501';
    END IF;
    IF NEW.event_type NOT IN ('job.succeeded', 'job.retry_scheduled', 'job.dead') THEN
      RAISE EXCEPTION 'event type not allowed for the worker role' USING ERRCODE = '42501';
    END IF;
    NEW.occurred_at := now();
    NEW.id := gen_random_uuid();
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------------------
-- F8-B & F8-C: finance_worker_settle_payment emits settlement & unapplied-payment audit events
-- internally as the function owner, and returns 'conflict' (with an audit event) instead of
-- 'already_settled' when the stored terminal state or receipt disagrees with the requested outcome.
CREATE OR REPLACE FUNCTION public.finance_worker_settle_payment(
  p_job_id uuid,
  p_leased_by text,
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
  v_payload_payment text;
  v_receipt text;
  v_reason text;
  v_applied_minor bigint;
  v_unapplied_minor bigint;
BEGIN
  IF session_user IS DISTINCT FROM 'figbloom_worker' THEN
    RAISE EXCEPTION 'finance_worker_settle_payment is executable only as figbloom_worker' USING ERRCODE = '42501';
  END IF;

  IF p_job_id IS NULL OR p_leased_by IS NULL OR p_attempts IS NULL OR p_payment_id IS NULL THEN
    RAISE EXCEPTION 'settlement requires a job lease identity and a payment' USING ERRCODE = '22023';
  END IF;
  IF char_length(btrim(p_leased_by)) < 1 OR char_length(p_leased_by) > 80 THEN
    RAISE EXCEPTION 'invalid worker lease identity' USING ERRCODE = '22023';
  END IF;
  IF p_attempts < 1 THEN
    RAISE EXCEPTION 'invalid fencing token' USING ERRCODE = '22023';
  END IF;
  IF p_status NOT IN ('success', 'failed', 'cancelled', 'timeout') THEN
    RAISE EXCEPTION 'unsupported settlement status' USING ERRCODE = '22023';
  END IF;

  -- Lease proof: current, non-expired, matching fencing token. Tenant comes from this row.
  SELECT * INTO v_job
    FROM public.jobs j
   WHERE j.id = p_job_id
     AND j.status = 'leased'
     AND j.leased_by = p_leased_by
     AND j.attempts = p_attempts
     AND j.lease_expires_at IS NOT NULL
     AND j.lease_expires_at > now()
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement refused: no current matching job lease' USING ERRCODE = '42501';
  END IF;
  IF v_job.job_type IS DISTINCT FROM 'mpesa.stk_settle' THEN
    RAISE EXCEPTION 'settlement refused: job type is not a settlement job' USING ERRCODE = '42501';
  END IF;

  v_payload_payment := v_job.payload->>'paymentId';
  IF v_payload_payment IS NULL
     OR lower(v_payload_payment) IS DISTINCT FROM lower(p_payment_id::text) THEN
    RAISE EXCEPTION 'settlement refused: payment is not the one named by the leased job' USING ERRCODE = '42501';
  END IF;

  -- Lock order matches callback/operator path (invoice first, then payment).
  SELECT i.id INTO v_invoice_id
    FROM public.finance_invoices i
    JOIN public.finance_payments p ON p.invoice_id = i.id AND p.tenant_id = i.tenant_id
   WHERE p.id = p_payment_id
     AND p.tenant_id = v_job.tenant_id
     AND p.method = 'mpesa'
   FOR UPDATE OF i;
  IF v_invoice_id IS NULL THEN
    RAISE EXCEPTION 'settlement refused: payment not found for the leased job tenant' USING ERRCODE = 'P0002';
  END IF;

  SELECT * INTO v_pay
    FROM public.finance_payments p
   WHERE p.id = p_payment_id
     AND p.tenant_id = v_job.tenant_id
     AND p.method = 'mpesa'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement refused: payment not found for the leased job tenant' USING ERRCODE = 'P0002';
  END IF;

  -- F8-C: Distinguish idempotent replay ('already_settled') from conflicting terminal state ('conflict').
  IF v_pay.status IS DISTINCT FROM 'pending' THEN
    IF p_status = 'success'
       AND v_pay.status = 'success'
       AND p_mpesa_receipt IS NOT NULL
       AND v_pay.mpesa_receipt = p_mpesa_receipt THEN
      RETURN 'already_settled';
    END IF;
    IF p_status IS DISTINCT FROM 'success'
       AND v_pay.status = p_status
       AND (p_failure_reason IS NULL OR v_pay.failure_reason IS NOT DISTINCT FROM nullif(btrim(p_failure_reason), '')) THEN
      RETURN 'already_settled';
    END IF;

    INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
    VALUES (
      NULL,
      v_job.tenant_id,
      'finance.mpesa.settled',
      jsonb_build_object(
        'paymentId', p_payment_id,
        'invoiceId', v_pay.invoice_id,
        'outcome', 'conflict',
        'storedStatus', v_pay.status,
        'storedReceipt', v_pay.mpesa_receipt,
        'storedFailureReason', v_pay.failure_reason,
        'requestedStatus', p_status,
        'requestedReceipt', p_mpesa_receipt,
        'requestedFailureReason', p_failure_reason,
        'source', 'status_query',
        'actingVia', 'worker',
        'jobId', v_job.id,
        'jobType', v_job.job_type,
        'attempt', v_job.attempts
      )
    );
    RETURN 'conflict';
  END IF;

  IF p_status = 'success' THEN
    v_receipt := upper(btrim(coalesce(p_mpesa_receipt, '')));
    IF v_receipt !~ '^[A-Z0-9]{6,20}$' THEN
      RAISE EXCEPTION 'success settlement requires a well-formed receipt' USING ERRCODE = '22023';
    END IF;
    -- Independently persisted authenticated callback evidence. Worker cannot INSERT source=callback.
    IF NOT EXISTS (
      SELECT 1
        FROM public.finance_mpesa_events e
       WHERE e.tenant_id = v_job.tenant_id
         AND e.payment_id = p_payment_id
         AND e.source = 'callback'
         AND e.outcome = 'callback_received'
         AND e.result_code = 0
         AND e.receipt IS NOT DISTINCT FROM v_receipt
    ) THEN
      RAISE EXCEPTION 'success settlement requires a stored authenticated callback receipt' USING ERRCODE = '42501';
    END IF;

    UPDATE public.finance_payments
       SET status = 'success',
           mpesa_receipt = v_receipt,
           failure_reason = NULL
     WHERE id = v_pay.id
       AND tenant_id = v_job.tenant_id
       AND status = 'pending'
    RETURNING applied_minor, unapplied_minor INTO v_applied_minor, v_unapplied_minor;
    IF NOT FOUND THEN
      RETURN 'already_settled';
    END IF;

    INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
    VALUES (
      NULL,
      v_job.tenant_id,
      'finance.mpesa.settled',
      jsonb_build_object(
        'paymentId', p_payment_id,
        'invoiceId', v_pay.invoice_id,
        'outcome', 'success',
        'receiptBasis', 'stored_callback',
        'amountMinor', v_pay.amount_minor,
        'callbackAmountMismatch', false,
        'source', 'status_query',
        'actingVia', 'worker',
        'jobId', v_job.id,
        'jobType', v_job.job_type,
        'attempt', v_job.attempts
      )
    );

    IF COALESCE(v_unapplied_minor, 0) > 0 THEN
      INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
      VALUES (
        NULL,
        v_job.tenant_id,
        'finance.payment.unapplied',
        jsonb_build_object(
          'paymentId', p_payment_id,
          'invoiceId', v_pay.invoice_id,
          'amountMinor', v_pay.amount_minor,
          'appliedMinor', v_applied_minor,
          'unappliedMinor', v_unapplied_minor,
          'source', 'status_query',
          'actingVia', 'worker',
          'jobId', v_job.id,
          'jobType', v_job.job_type,
          'attempt', v_job.attempts
        )
      );
    END IF;

    RETURN 'settled_success';
  END IF;

  -- Terminal unpaid outcomes: still lease-bound to this payment/tenant; no invented success credit.
  v_reason := nullif(btrim(coalesce(p_failure_reason, '')), '');
  IF v_reason IS NULL OR char_length(v_reason) > 40 THEN
    RAISE EXCEPTION 'a failure reason of 1 to 40 characters is required' USING ERRCODE = '22023';
  END IF;

  UPDATE public.finance_payments
     SET status = p_status,
         failure_reason = v_reason,
         mpesa_receipt = NULL
   WHERE id = v_pay.id
     AND tenant_id = v_job.tenant_id
     AND status = 'pending';
  IF NOT FOUND THEN
    RETURN 'already_settled';
  END IF;

  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (
    NULL,
    v_job.tenant_id,
    'finance.mpesa.settled',
    jsonb_build_object(
      'paymentId', p_payment_id,
      'outcome', p_status,
      'reason', v_reason,
      'source', 'status_query',
      'actingVia', 'worker',
      'jobId', v_job.id,
      'jobType', v_job.job_type,
      'attempt', v_job.attempts
    )
  );

  RETURN 'settled_failure';
END;
$$;

REVOKE ALL ON FUNCTION public.finance_worker_settle_payment(uuid, text, integer, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finance_worker_settle_payment(uuid, text, integer, uuid, text, text, text) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.finance_worker_settle_payment(uuid, text, integer, uuid, text, text, text) TO figbloom_worker;
