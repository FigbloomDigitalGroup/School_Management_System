-- Stage 11: M-Pesa provider events, payment proofs, reconciliation. Forward-only.
--
-- M-Pesa (legacy mpesa-stk-push / mpesa-callback, redesigned on the API):
--   * a prompt is a finance_payments row (method mpesa, pending) bound to one invoice;
--   * every callback and status query is logged append-only in finance_mpesa_events (no secrets; the
--     phone number is masked);
--   * finance_mpesa_tenant_for_checkout() maps a provider CheckoutRequestID to its school. It is the
--     callback's only cross-tenant step (a callback carries no session), returns the tenant id only, and
--     is reachable only after the callback secret has been verified.
-- Proofs (legacy payment_proofs): a family's evidence of a payment made outside the app (pasted SMS
--   and/or a file reference). Files are METADATA ONLY (no object storage is approved; same contract as
--   directory documents). A proof is confirmed only together with the payment it produced; rejected with
--   a reason; never deleted.
-- Reconciliation (new; no legacy equivalent): runs record findings about internal inconsistencies and
--   provider evidence. Findings never change money; resolving one records who, when and why.

-- ---------------------------------------------------------------------------------------------------
-- M-Pesa events
CREATE TABLE finance_mpesa_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  payment_id uuid NOT NULL,
  checkout_request_id text NOT NULL,
  source text NOT NULL,
  result_code integer,
  result_desc text,
  callback_amount_minor bigint,
  receipt text,
  msisdn_masked text,
  outcome text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_mpesa_events_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT finance_mpesa_events_payment_fk FOREIGN KEY (payment_id, tenant_id) REFERENCES finance_payments (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT finance_mpesa_events_source_chk CHECK (source IN ('callback', 'status_query')),
  CONSTRAINT finance_mpesa_events_outcome_chk CHECK (outcome IN (
    'settled_success', 'settled_failure', 'already_settled', 'provider_pending', 'provider_error', 'not_sent')),
  CONSTRAINT finance_mpesa_events_desc_len CHECK (result_desc IS NULL OR char_length(result_desc) <= 200),
  CONSTRAINT finance_mpesa_events_receipt_fmt CHECK (receipt IS NULL OR receipt ~ '^[A-Z0-9]{6,20}$'),
  CONSTRAINT finance_mpesa_events_msisdn_fmt CHECK (msisdn_masked IS NULL OR msisdn_masked ~ '^254\*{5}[0-9]{4}$'),
  CONSTRAINT finance_mpesa_events_amount_chk CHECK (callback_amount_minor IS NULL OR callback_amount_minor >= 0)
);
CREATE INDEX finance_mpesa_events_payment_idx ON finance_mpesa_events (tenant_id, payment_id, received_at);

CREATE FUNCTION public.finance_mpesa_tenant_for_checkout(p_checkout text) RETURNS uuid
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p.tenant_id FROM public.finance_payments p
   WHERE p.checkout_request_id = p_checkout AND p.method = 'mpesa'
   LIMIT 1
$$;
REVOKE ALL ON FUNCTION public.finance_mpesa_tenant_for_checkout(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finance_mpesa_tenant_for_checkout(text) TO figbloom_app;

-- Callbacks whose CheckoutRequestID matches no prompt (e.g. the provider accepted a prompt but the
-- response was lost). They cannot be attributed to a school, so they are kept in an operator-only
-- quarantine: no tenant, RLS on with NO application policy (the runtime roles can neither read nor write
-- it directly); written only through finance_mpesa_record_unmatched(). Platform operations review it.
CREATE TABLE finance_mpesa_unmatched_callbacks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_request_id text NOT NULL,
  merchant_request_id text,
  result_code integer,
  callback_amount_minor bigint,
  receipt text,
  msisdn_masked text,
  received_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_mpesa_unmatched_checkout_len CHECK (char_length(checkout_request_id) BETWEEN 1 AND 80),
  CONSTRAINT finance_mpesa_unmatched_merchant_len CHECK (merchant_request_id IS NULL OR char_length(merchant_request_id) <= 80),
  CONSTRAINT finance_mpesa_unmatched_receipt_fmt CHECK (receipt IS NULL OR receipt ~ '^[A-Z0-9]{6,20}$'),
  CONSTRAINT finance_mpesa_unmatched_msisdn_fmt CHECK (msisdn_masked IS NULL OR msisdn_masked ~ '^254\*{5}[0-9]{4}$')
);
ALTER TABLE finance_mpesa_unmatched_callbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_mpesa_unmatched_callbacks FORCE ROW LEVEL SECURITY;
CREATE POLICY finance_mpesa_unmatched_callbacks_owner ON finance_mpesa_unmatched_callbacks FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'finance_mpesa_unmatched_callbacks'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'finance_mpesa_unmatched_callbacks'));
REVOKE ALL ON finance_mpesa_unmatched_callbacks FROM figbloom_app, figbloom_worker;

CREATE FUNCTION public.finance_mpesa_record_unmatched(
  p_checkout text, p_merchant text, p_result_code integer, p_amount_minor bigint, p_receipt text, p_msisdn_masked text
) RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  INSERT INTO public.finance_mpesa_unmatched_callbacks
    (checkout_request_id, merchant_request_id, result_code, callback_amount_minor, receipt, msisdn_masked)
  VALUES (p_checkout, p_merchant, p_result_code, p_amount_minor, p_receipt, p_msisdn_masked)
$$;
REVOKE ALL ON FUNCTION public.finance_mpesa_record_unmatched(text, text, integer, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finance_mpesa_record_unmatched(text, text, integer, bigint, text, text) TO figbloom_app;

-- ---------------------------------------------------------------------------------------------------
-- proofs
CREATE TABLE finance_payment_proofs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL,
  submitted_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  submitted_via text NOT NULL,
  note text,
  file_name text,
  content_type text,
  byte_size integer,
  storage_status text,
  sms_text text,
  txn_source text,
  txn_code text,
  txn_amount_minor bigint,
  txn_at timestamptz,
  txn_payee text,
  txn_payee_number text,
  txn_account text,
  status text NOT NULL DEFAULT 'pending',
  payment_id uuid,
  reviewed_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  reviewed_at timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_payment_proofs_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT finance_payment_proofs_invoice_fk FOREIGN KEY (invoice_id, tenant_id) REFERENCES finance_invoices (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT finance_payment_proofs_payment_fk FOREIGN KEY (payment_id, tenant_id) REFERENCES finance_payments (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT finance_payment_proofs_via_chk CHECK (submitted_via IN ('office', 'guardian')),
  CONSTRAINT finance_payment_proofs_status_chk CHECK (status IN ('pending', 'confirmed', 'rejected')),
  CONSTRAINT finance_payment_proofs_evidence_chk CHECK (file_name IS NOT NULL OR sms_text IS NOT NULL),
  CONSTRAINT finance_payment_proofs_file_chk CHECK (
    (file_name IS NULL AND content_type IS NULL AND byte_size IS NULL AND storage_status IS NULL)
    OR (file_name IS NOT NULL AND content_type IS NOT NULL AND byte_size IS NOT NULL AND storage_status = 'metadata_only'
        AND char_length(file_name) BETWEEN 1 AND 200 AND file_name !~ '[/\\]|[[:cntrl:]]' AND file_name NOT IN ('.', '..')
        AND content_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
        AND byte_size BETWEEN 1 AND 10485760)
  ),
  CONSTRAINT finance_payment_proofs_sms_chk CHECK (
    sms_text IS NULL OR (char_length(sms_text) BETWEEN 10 AND 2000 AND txn_code IS NOT NULL)
  ),
  CONSTRAINT finance_payment_proofs_code_fmt CHECK (txn_code IS NULL OR txn_code ~ '^[A-Z0-9][A-Z0-9.-]{3,40}$'),
  CONSTRAINT finance_payment_proofs_source_chk CHECK (txn_source IS NULL OR txn_source IN ('mpesa', 'airtel', 'bank', 'unknown')),
  CONSTRAINT finance_payment_proofs_amount_chk CHECK (txn_amount_minor IS NULL OR txn_amount_minor > 0),
  CONSTRAINT finance_payment_proofs_text_len CHECK (
    (note IS NULL OR char_length(note) BETWEEN 1 AND 500)
    AND (txn_payee IS NULL OR char_length(txn_payee) <= 120)
    AND (txn_payee_number IS NULL OR char_length(txn_payee_number) <= 30)
    AND (txn_account IS NULL OR char_length(txn_account) <= 60)
  ),
  CONSTRAINT finance_payment_proofs_review_chk CHECK (
    (status = 'pending' AND reviewed_by IS NULL AND reviewed_at IS NULL AND rejection_reason IS NULL AND payment_id IS NULL)
    OR (status = 'confirmed' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND rejection_reason IS NULL AND payment_id IS NOT NULL)
    OR (status = 'rejected' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND payment_id IS NULL
        AND char_length(btrim(rejection_reason)) BETWEEN 3 AND 300)
  )
);
-- one live proof per transaction code in a school (a rejected proof frees the code)
CREATE UNIQUE INDEX finance_payment_proofs_code_uidx ON finance_payment_proofs (tenant_id, txn_code) WHERE txn_code IS NOT NULL AND status <> 'rejected';
CREATE INDEX finance_payment_proofs_invoice_idx ON finance_payment_proofs (tenant_id, invoice_id);
CREATE INDEX finance_payment_proofs_pending_idx ON finance_payment_proofs (tenant_id, created_at) WHERE status = 'pending';

ALTER TABLE finance_payments
  ADD CONSTRAINT finance_payments_proof_fk FOREIGN KEY (proof_id, tenant_id) REFERENCES finance_payment_proofs (id, tenant_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX finance_payments_proof_uidx ON finance_payments (proof_id) WHERE proof_id IS NOT NULL;

CREATE FUNCTION public.finance_payment_proofs_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'a proof starts pending' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM public.finance_invoices i WHERE i.id = NEW.invoice_id AND i.tenant_id = NEW.tenant_id AND i.voided_at IS NOT NULL) THEN
      RAISE EXCEPTION 'the invoice is voided' USING ERRCODE = '23514';
    END IF;
    IF NEW.sms_text IS NOT NULL AND strpos(upper(regexp_replace(NEW.sms_text, '\s', '', 'g')), NEW.txn_code) = 0 THEN
      RAISE EXCEPTION 'the transaction code does not appear in the message' USING ERRCODE = '23514';
    END IF;
    IF NEW.txn_code IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.finance_payments p
       WHERE p.tenant_id = NEW.tenant_id AND p.status = 'success'
         AND (p.mpesa_receipt = NEW.txn_code OR p.reference_norm = NEW.txn_code)
    ) THEN
      RAISE EXCEPTION 'that transaction is already recorded as a payment' USING ERRCODE = '23505';
    END IF;
    NEW.created_at := now();
    RETURN NEW;
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a reviewed proof is final' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'payment_id', 'reviewed_by', 'reviewed_at', 'rejection_reason'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'payment_id', 'reviewed_by', 'reviewed_at', 'rejection_reason']) THEN
    RAISE EXCEPTION 'a proof cannot change; review it instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'confirmed' AND NOT EXISTS (
    SELECT 1 FROM public.finance_payments p
     WHERE p.id = NEW.payment_id AND p.tenant_id = NEW.tenant_id AND p.invoice_id = NEW.invoice_id
       AND p.proof_id = NEW.id AND p.status = 'success'
  ) THEN
    RAISE EXCEPTION 'a proof is confirmed only by the payment it produced' USING ERRCODE = '23514';
  END IF;
  NEW.reviewed_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER finance_payment_proofs_guard BEFORE INSERT OR UPDATE ON finance_payment_proofs
  FOR EACH ROW EXECUTE FUNCTION public.finance_payment_proofs_guard();

-- an invoice with any proof cannot be voided (legacy: an invoice is removable only if nothing hangs off it)
CREATE FUNCTION public.finance_invoices_proof_void_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL AND EXISTS (
    SELECT 1 FROM public.finance_payment_proofs pr WHERE pr.invoice_id = NEW.id AND pr.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'an invoice with payment proofs cannot be voided' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finance_invoices_proof_void_guard BEFORE UPDATE ON finance_invoices
  FOR EACH ROW EXECUTE FUNCTION public.finance_invoices_proof_void_guard();

-- a payment that names a proof must be for that proof's invoice and the proof must be pending
CREATE FUNCTION public.finance_payments_proof_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.proof_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.finance_payment_proofs pr
     WHERE pr.id = NEW.proof_id AND pr.tenant_id = NEW.tenant_id AND pr.invoice_id = NEW.invoice_id AND pr.status = 'pending'
  ) THEN
    RAISE EXCEPTION 'the proof is not pending on this invoice' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finance_payments_proof_guard BEFORE INSERT ON finance_payments
  FOR EACH ROW EXECUTE FUNCTION public.finance_payments_proof_guard();

-- ---------------------------------------------------------------------------------------------------
-- reconciliation
CREATE TABLE finance_reconciliation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  started_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  started_at timestamptz NOT NULL DEFAULT now(),
  stale_after_minutes integer NOT NULL,
  findings_count integer NOT NULL DEFAULT 0,
  CONSTRAINT finance_reconciliation_runs_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT finance_reconciliation_runs_stale_chk CHECK (stale_after_minutes BETWEEN 5 AND 10080),
  CONSTRAINT finance_reconciliation_runs_count_chk CHECK (findings_count >= 0)
);

CREATE TABLE finance_reconciliation_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  run_id uuid NOT NULL,
  kind text NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'open',
  resolved_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_reconciliation_findings_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT finance_reconciliation_findings_run_fk FOREIGN KEY (run_id, tenant_id) REFERENCES finance_reconciliation_runs (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT finance_reconciliation_findings_kind_chk CHECK (kind IN (
    'invoice_total_mismatch', 'overpaid_invoice', 'stale_pending_prompt', 'prompt_never_sent',
    'callback_amount_mismatch', 'proof_already_paid')),
  CONSTRAINT finance_reconciliation_findings_subject_chk CHECK (subject_type IN ('invoice', 'payment', 'proof')),
  CONSTRAINT finance_reconciliation_findings_uidx UNIQUE (run_id, kind, subject_id),
  CONSTRAINT finance_reconciliation_findings_detail_obj CHECK (jsonb_typeof(detail) = 'object'),
  CONSTRAINT finance_reconciliation_findings_status_chk CHECK (
    (status = 'open' AND resolved_by IS NULL AND resolved_at IS NULL AND resolution_note IS NULL)
    OR (status = 'resolved' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND char_length(btrim(resolution_note)) BETWEEN 3 AND 500)
  )
);
CREATE INDEX finance_reconciliation_findings_open_idx ON finance_reconciliation_findings (tenant_id, created_at) WHERE status = 'open';

CREATE FUNCTION public.finance_reconciliation_findings_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'a resolved finding is final' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status', 'resolved_by', 'resolved_at', 'resolution_note'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'resolved_by', 'resolved_at', 'resolution_note']) THEN
    RAISE EXCEPTION 'a finding cannot change; resolve it instead' USING ERRCODE = '23514';
  END IF;
  NEW.resolved_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER finance_reconciliation_findings_guard BEFORE UPDATE ON finance_reconciliation_findings
  FOR EACH ROW EXECUTE FUNCTION public.finance_reconciliation_findings_guard();

-- ---------------------------------------------------------------------------------------------------
-- RLS, grants
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_mpesa_events', 'finance_payment_proofs', 'finance_reconciliation_runs', 'finance_reconciliation_findings']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO figbloom_app USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', t || '_tenant', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I FOR ALL TO PUBLIC
      USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))
      WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))
    $f$, t || '_owner', t, t, t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO figbloom_app', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM figbloom_app', t);
  END LOOP;
END $$;

-- the worker settles prompts: it logs provider events and reads proofs (payment proof guard runs on update)
CREATE POLICY finance_mpesa_events_worker ON finance_mpesa_events FOR ALL TO figbloom_worker
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
GRANT SELECT, INSERT ON finance_mpesa_events TO figbloom_worker;
CREATE POLICY finance_payment_proofs_worker ON finance_payment_proofs FOR ALL TO figbloom_worker
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
GRANT SELECT ON finance_payment_proofs TO figbloom_worker;

GRANT UPDATE (status, payment_id, reviewed_by, reviewed_at, rejection_reason) ON finance_payment_proofs TO figbloom_app;
GRANT UPDATE (findings_count) ON finance_reconciliation_runs TO figbloom_app;
GRANT UPDATE (status, resolved_by, resolved_at, resolution_note) ON finance_reconciliation_findings TO figbloom_app;

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['finance_payment_proofs_guard()', 'finance_invoices_proof_void_guard()',
    'finance_payments_proof_guard()', 'finance_reconciliation_findings_guard()']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM figbloom_app', f);
  END LOOP;
END $$;
