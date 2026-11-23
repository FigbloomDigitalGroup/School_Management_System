-- Stage 11 remediation, batch 1: worker conformance (docs/WORKER-ISOLATION-PROPOSAL.md §3, §6, §7, §8).
-- Forward-only. Does not edit 036-040.
--
-- 1) jobs_claim(): a lease that expired at max_attempts is moved to 'dead' (040) AND now audited. Without
--    the audit row a dead-letter was invisible (review F-5). The audit row is written in the same statement
--    as the state change, so an event exists exactly when the transition happened.
-- 2) security_audit_events: the worker role may only write events bound to its CURRENT tenant, with no user
--    actor, no IP, the actingVia 'worker' marker and an event type the worker legitimately emits. The table
--    stays without RLS (it is append-only through a guard trigger and shared by every role); this trigger
--    removes the worker's ability to forge attribution (review F-7). The API role is deliberately NOT
--    restricted here: its audit rows carry user, IP and pre-tenant events by design (documented residual).
-- 3) jobs_operator_cancel(): the only way a queued settlement job is cancelled. It is a system obligation
--    (enqueued_by_user_id NULL), so cancellation is an explicit, reasoned, audited operator act that is
--    refused while the payment it settles is still pending (cancelling would abandon real money).

CREATE OR REPLACE FUNCTION public.jobs_claim(p_worker text, p_lease_seconds integer, p_types text[])
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
CREATE FUNCTION public.security_audit_events_worker_scope() RETURNS trigger
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
    IF NEW.event_type NOT IN ('job.succeeded', 'job.retry_scheduled', 'job.dead', 'finance.mpesa.settled', 'finance.payment.overpaid') THEN
      RAISE EXCEPTION 'event type not allowed for the worker role' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER security_audit_events_worker_scope BEFORE INSERT ON security_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.security_audit_events_worker_scope();
REVOKE ALL ON FUNCTION public.security_audit_events_worker_scope() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.security_audit_events_worker_scope() FROM figbloom_app;

-- ---------------------------------------------------------------------------------------------------
CREATE FUNCTION public.jobs_operator_cancel(p_job_id uuid, p_actor uuid, p_reason text) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.app_current_tenant_id();
  v_job public.jobs%ROWTYPE;
  v_pay_status text;
  v_reason text := btrim(coalesce(p_reason, ''));
BEGIN
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'no tenant context' USING ERRCODE = '42501';
  END IF;
  IF p_actor IS NULL OR p_actor IS DISTINCT FROM public.app_current_user_id() THEN
    RAISE EXCEPTION 'the acting user must be the signed-in user' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_reason) NOT BETWEEN 10 AND 300 THEN
    RAISE EXCEPTION 'a cancellation reason of 10 to 300 characters is required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_job FROM public.jobs WHERE id = p_job_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'job not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_job.job_type <> 'mpesa.stk_settle' THEN
    RAISE EXCEPTION 'only a settlement job can be cancelled here' USING ERRCODE = '23514';
  END IF;
  IF v_job.status <> 'queued' THEN
    RAISE EXCEPTION 'only a queued job can be cancelled' USING ERRCODE = '23514';
  END IF;
  SELECT p.status INTO v_pay_status FROM public.finance_payments p
   WHERE p.tenant_id = v_tenant AND p.id = (v_job.payload->>'paymentId')::uuid FOR UPDATE;
  IF v_pay_status IS NULL OR v_pay_status = 'pending' THEN
    RAISE EXCEPTION 'the payment is still pending; reconcile it instead of cancelling its settlement' USING ERRCODE = '23514';
  END IF;
  UPDATE public.jobs
     SET status = 'cancelled', cancel_reason = v_reason, finished_at = now(), lease_expires_at = NULL, leased_by = NULL
   WHERE id = v_job.id;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (p_actor, v_tenant, 'job.cancelled',
          jsonb_build_object('jobId', v_job.id, 'jobType', v_job.job_type, 'attempt', v_job.attempts,
                             'reason', v_reason, 'paymentStatus', v_pay_status, 'actingVia', 'operator'));
END;
$$;
REVOKE ALL ON FUNCTION public.jobs_operator_cancel(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.jobs_operator_cancel(uuid, uuid, text) FROM figbloom_worker;
GRANT EXECUTE ON FUNCTION public.jobs_operator_cancel(uuid, uuid, text) TO figbloom_app;
