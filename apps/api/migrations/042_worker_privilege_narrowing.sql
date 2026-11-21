-- Stage 11 remediation, batch 1 follow-up (independent challenge of migration 041). Forward-only.
--
-- 1) The worker role could still rewrite fields the runtime never needs: `attempts` (the fencing token,
--    written only by the SECURITY DEFINER jobs_claim) and `cancel_reason`, and could set status 'cancelled'
--    itself, skipping the operator function's refusal and its audit row. The role loses UPDATE on those two
--    columns, and a trigger confines every worker UPDATE to the one legitimate step: a leased job becomes
--    queued, succeeded or dead. Cancellation exists only in jobs_operator_cancel().
-- 2) The worker audit trigger also pins `id` and `occurred_at` (a worker could back-date or forge them) and
--    no longer allows finance.payment.overpaid: the worker never emits it (no unapplied-amount event exists
--    for it yet; the allowlist is extended deliberately when one does).
-- 3) jobs_operator_cancel() records the caller's IP like every administrator write, validates the payload id
--    before casting it (a malformed payload is a 23514 conflict, not an unmapped 22P02), and counts reason
--    length in code points, as the API does.

REVOKE UPDATE (attempts, cancel_reason) ON jobs FROM figbloom_worker;

CREATE FUNCTION public.jobs_worker_transition_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_user = 'figbloom_worker' THEN
    IF OLD.status <> 'leased' OR NEW.status NOT IN ('queued', 'succeeded', 'dead') THEN
      RAISE EXCEPTION 'a worker may only finish or release a job it has leased' USING ERRCODE = '42501';
    END IF;
    IF NEW.attempts IS DISTINCT FROM OLD.attempts OR NEW.cancel_reason IS NOT NULL THEN
      RAISE EXCEPTION 'a worker cannot change the fencing token or cancel a job' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER jobs_worker_transition_guard BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_worker_transition_guard();
REVOKE ALL ON FUNCTION public.jobs_worker_transition_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.jobs_worker_transition_guard() FROM figbloom_app;

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
    IF NEW.event_type NOT IN ('job.succeeded', 'job.retry_scheduled', 'job.dead', 'finance.mpesa.settled') THEN
      RAISE EXCEPTION 'event type not allowed for the worker role' USING ERRCODE = '42501';
    END IF;
    -- the database, not the worker, decides when an event happened and what its id is
    NEW.occurred_at := now();
    NEW.id := gen_random_uuid();
  END IF;
  RETURN NEW;
END;
$$;

DROP FUNCTION public.jobs_operator_cancel(uuid, uuid, text);
CREATE FUNCTION public.jobs_operator_cancel(p_job_id uuid, p_actor uuid, p_reason text, p_ip inet) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.app_current_tenant_id();
  v_job public.jobs%ROWTYPE;
  v_pay_status text;
  v_pid text;
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
  v_pid := v_job.payload->>'paymentId';
  IF v_pid IS NULL OR v_pid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'the job payload does not name a payment' USING ERRCODE = '23514';
  END IF;
  SELECT p.status INTO v_pay_status FROM public.finance_payments p
   WHERE p.tenant_id = v_tenant AND p.id = v_pid::uuid FOR UPDATE;
  IF v_pay_status IS NULL OR v_pay_status = 'pending' THEN
    RAISE EXCEPTION 'the payment is still pending; reconcile it instead of cancelling its settlement' USING ERRCODE = '23514';
  END IF;
  UPDATE public.jobs
     SET status = 'cancelled', cancel_reason = v_reason, finished_at = now(), lease_expires_at = NULL, leased_by = NULL
   WHERE id = v_job.id;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail, ip)
  VALUES (p_actor, v_tenant, 'job.cancelled',
          jsonb_build_object('jobId', v_job.id, 'jobType', v_job.job_type, 'attempt', v_job.attempts,
                             'reason', v_reason, 'paymentStatus', v_pay_status, 'actingVia', 'operator'),
          p_ip);
END;
$$;
REVOKE ALL ON FUNCTION public.jobs_operator_cancel(uuid, uuid, text, inet) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.jobs_operator_cancel(uuid, uuid, text, inet) FROM figbloom_worker;
GRANT EXECUTE ON FUNCTION public.jobs_operator_cancel(uuid, uuid, text, inet) TO figbloom_app;
