-- Stage 11 review remediation: settlement and job-claim hardening.
-- Forward-only. Does not rewrite 036–039.
--
-- 1) An STK prompt (checkout_request_id set) cannot become success without a receipt.
--    Daraja STK query confirms outcome but does not return a receipt; crediting without one
--    left mpesa_receipt NULL, which the partial unique index ignores, so the same code could
--    later be recorded as a second office payment.
-- 2) Expired leases at max_attempts are marked dead inside jobs_claim so a crash on the last
--    attempt cannot leave the job leased forever and the prompt unexamined.

CREATE OR REPLACE FUNCTION public.finance_payments_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_inv public.finance_invoices%ROWTYPE;
  v_outstanding bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO v_inv FROM public.finance_invoices WHERE id = NEW.invoice_id AND tenant_id = NEW.tenant_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'unknown invoice' USING ERRCODE = '23503';
    END IF;
    IF v_inv.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'the invoice is voided' USING ERRCODE = '23514';
    END IF;
    IF NEW.currency <> v_inv.currency THEN
      RAISE EXCEPTION 'currency mismatch' USING ERRCODE = '23514';
    END IF;
    v_outstanding := GREATEST(v_inv.total_minor - v_inv.paid_minor, 0);
    IF NEW.status = 'success' THEN
      IF NEW.checkout_request_id IS NOT NULL THEN
        RAISE EXCEPTION 'an M-Pesa prompt starts pending' USING ERRCODE = '23514';
      END IF;
      IF NEW.method = 'mpesa' AND (NEW.mpesa_receipt IS NULL OR NEW.mpesa_receipt !~ '^[A-Z0-9]{6,20}$') THEN
        RAISE EXCEPTION 'an M-Pesa payment needs a receipt' USING ERRCODE = '23514';
      END IF;
      IF NEW.amount_minor > v_outstanding THEN
        RAISE EXCEPTION 'more than the outstanding balance' USING ERRCODE = '23514';
      END IF;
      IF NEW.amount_minor % 100 <> 0 AND NEW.amount_minor <> v_outstanding THEN
        RAISE EXCEPTION 'whole shillings only, unless paying the exact balance' USING ERRCODE = '23514';
      END IF;
      NEW.completed_at := now();
    ELSIF NEW.status = 'pending' THEN
      IF NEW.method <> 'mpesa' THEN
        RAISE EXCEPTION 'only an M-Pesa prompt is pending' USING ERRCODE = '23514';
      END IF;
      NEW.completed_at := NULL;
    ELSE
      RAISE EXCEPTION 'a payment starts pending or success' USING ERRCODE = '23514';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  IF (NEW.tenant_id, NEW.invoice_id, NEW.currency, NEW.amount_minor, NEW.method, NEW.reference, NEW.msisdn, NEW.recorded_by, NEW.created_at, NEW.proof_id)
     IS DISTINCT FROM (OLD.tenant_id, OLD.invoice_id, OLD.currency, OLD.amount_minor, OLD.method, OLD.reference, OLD.msisdn, OLD.recorded_by, OLD.created_at, OLD.proof_id) THEN
    RAISE EXCEPTION 'a payment cannot change' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a settled payment is final' USING ERRCODE = '23514';
  END IF;
  -- pending -> pending: only the provider's ids may be filled in, once
  IF NEW.status = 'pending' THEN
    IF (OLD.checkout_request_id IS NOT NULL AND NEW.checkout_request_id IS DISTINCT FROM OLD.checkout_request_id)
       OR (OLD.merchant_request_id IS NOT NULL AND NEW.merchant_request_id IS DISTINCT FROM OLD.merchant_request_id)
       OR NEW.mpesa_receipt IS NOT NULL THEN
      RAISE EXCEPTION 'provider ids are set once' USING ERRCODE = '23514';
    END IF;
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  IF NEW.checkout_request_id IS DISTINCT FROM OLD.checkout_request_id OR NEW.merchant_request_id IS DISTINCT FROM OLD.merchant_request_id THEN
    RAISE EXCEPTION 'provider ids are set once' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'success' AND NEW.failure_reason IS NOT NULL THEN
    RAISE EXCEPTION 'a successful payment has no failure reason' USING ERRCODE = '23514';
  END IF;
  -- STK prompts must carry a receipt before they credit the invoice (Daraja query alone is insufficient).
  IF NEW.status = 'success' AND NEW.checkout_request_id IS NOT NULL
     AND (NEW.mpesa_receipt IS NULL OR NEW.mpesa_receipt !~ '^[A-Z0-9]{6,20}$') THEN
    RAISE EXCEPTION 'an STK settlement needs a receipt' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'success' AND (NEW.failure_reason IS NULL OR NEW.mpesa_receipt IS NOT NULL) THEN
    RAISE EXCEPTION 'an unsuccessful prompt needs a reason and no receipt' USING ERRCODE = '23514';
  END IF;
  -- lock the invoice so its recompute is serialised with other payments
  PERFORM 1 FROM public.finance_invoices WHERE id = NEW.invoice_id AND tenant_id = NEW.tenant_id FOR UPDATE;
  NEW.completed_at := now();
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

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

  -- Last attempt crashed after claim: lease expired at max_attempts. Mark dead; do not return for execution.
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
  )
  UPDATE public.jobs j
     SET status = 'dead',
         finished_at = now(),
         lease_expires_at = NULL,
         leased_by = NULL,
         last_error_code = COALESCE(NULLIF(j.last_error_code, ''), 'lease_exhausted')
    FROM expired e
   WHERE j.id = e.id;

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
