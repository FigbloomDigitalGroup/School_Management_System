-- Stage 11 F-8: worker financial settlement authority boundary. Forward-only.
--
-- Finding: figbloom_worker held column UPDATE on finance_payments and could, by choosing any
-- app.tenant_id GUC, mark any pending M-Pesa prompt success with an invented receipt (or timeout),
-- with no job lease, no callback evidence and no provider confirmation. RLS keyed on a caller-set
-- GUC is not a defence against a compromised worker credential that can run arbitrary SQL.
--
-- Correction:
--   1. REVOKE all UPDATE on finance_payments and finance_invoices from figbloom_worker.
--   2. Route every worker payment status transition through finance_worker_settle_payment(), a
--      narrowly scoped SECURITY DEFINER that:
--        * authorises against a currently held, non-expired job lease with matching fencing token;
--        * derives the tenant from the persisted job row (never from the session GUC);
--        * binds the payment id to the job payload;
--        * for success, requires an independently persisted authenticated callback receipt
--          (source=callback, outcome=callback_received, result_code=0) — the worker cannot plant
--          that evidence (finance_mpesa_events_source_guard);
--        * is idempotent for an already-settled payment;
--        * refuses stale/expired/stolen leases and mismatched fencing tokens;
--        * cannot be used to touch unrelated payments or tenants.
--   3. Failure/timeout/cancelled outcomes still require a held lease for that payment (so a stolen
--      credential cannot manufacture outcomes for arbitrary prompts); success additionally requires
--      the non-inventable callback receipt. Callback and operator settlement continue as
--      figbloom_app with their existing column UPDATE grants.
--
-- The function owner is the table owner (migrator). search_path is fixed. EXECUTE is granted only
-- to figbloom_worker. PUBLIC and figbloom_app cannot call it.

-- Remove the settlement write surface. Invoice UPDATE is also revoked: the payment-touch trigger
-- runs as the table owner inside finance_worker_settle_payment, and the worker must not take
-- FOR UPDATE locks on finance rows from application SQL (see settlePrompt worker path).
REVOKE UPDATE ON finance_payments FROM figbloom_worker;
REVOKE UPDATE ON finance_invoices FROM figbloom_worker;

CREATE FUNCTION public.finance_worker_settle_payment(
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
BEGIN
  -- SECURITY DEFINER makes current_user the function owner; the caller is session_user.
  IF session_user IS DISTINCT FROM 'figbloom_worker' THEN
    -- Defence in depth: EXECUTE is already revoked from other roles; refuse if somehow invoked.
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

  -- Lock order matches the callback/operator path (invoice then payment) so a race cannot deadlock
  -- against settlePrompt's lockInvoiceOfPayment. Tenant comes from the job, not the session GUC.
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

  -- Idempotent already-settled: same terminal state (and same receipt when success) is a no-op success.
  IF v_pay.status IS DISTINCT FROM 'pending' THEN
    IF p_status = 'success'
       AND v_pay.status = 'success'
       AND p_mpesa_receipt IS NOT NULL
       AND v_pay.mpesa_receipt IS NOT DISTINCT FROM upper(btrim(p_mpesa_receipt)) THEN
      RETURN 'already_settled';
    END IF;
    IF p_status IS DISTINCT FROM 'success' AND v_pay.status = p_status THEN
      RETURN 'already_settled';
    END IF;
    RETURN 'already_settled';
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

    -- completed_at / applied_minor / updated_at are decided by finance_payments_guard (same as the API path).
    UPDATE public.finance_payments
       SET status = 'success',
           mpesa_receipt = v_receipt,
           failure_reason = NULL
     WHERE id = v_pay.id
       AND tenant_id = v_job.tenant_id
       AND status = 'pending';
    IF NOT FOUND THEN
      RETURN 'already_settled';
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
  RETURN 'settled_failure';
END;
$$;

REVOKE ALL ON FUNCTION public.finance_worker_settle_payment(uuid, text, integer, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finance_worker_settle_payment(uuid, text, integer, uuid, text, text, text) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.finance_worker_settle_payment(uuid, text, integer, uuid, text, text, text) TO figbloom_worker;

COMMENT ON FUNCTION public.finance_worker_settle_payment(uuid, text, integer, uuid, text, text, text) IS
  'F-8: the only path by which figbloom_worker may change finance_payments status. Lease-bound, tenant from job, success requires stored callback receipt.';
