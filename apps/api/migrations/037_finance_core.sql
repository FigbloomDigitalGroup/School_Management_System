-- Stage 11 finance core: fee items, invoices, invoice lines, charges, adjustments, payments.
-- Forward-only. No earlier migration is edited.
--
-- Rules carried over from the legacy product (evidence: supabase/migrations, packages/shared/src/fees.ts):
--   * Money is integer minor units (cents, bigint). Currency is explicit: 'KES' is the only supported
--     currency (legacy is Kenya-only and implicit); another currency needs an owner decision.
--   * Whole shillings: fee items, charges and M-Pesa prompts are multiples of 100 minor units. A manual
--     payment is a whole-shilling amount OR exactly the remaining balance (legacy FIG-1334).
--   * One live invoice per learner per term. A payment settles exactly one invoice (no multi-invoice
--     allocation exists in the product).
--   * Status: paid (nothing left) | overdue (balance and past due date) | part_paid (balance, something
--     paid) | unpaid. Derived, never stored, using the school's local date (finance_invoice_status).
--   * A manual payment may not exceed the outstanding balance. An M-Pesa prompt is settled for the
--     prompt's own amount and may leave an overpayment, which is recorded (legacy behaviour).
--   * Waivers, discounts, penalties, credits, refunds, reversals and carry-forward do not exist in the
--     product: none is implemented here (owner decisions).
--
-- Integrity: invoice totals are DERIVED by the database from authoritative rows
--   total_minor   = sum(lines) + sum(live charges) + sum(adjustment deltas)
--   paid_minor    = sum(successful payments)
-- and the application cannot write those columns. Posted records (lines, adjustments, successful
-- payments) are immutable; charges and invoices are voided, never deleted.

-- ---------------------------------------------------------------------------------------------------
-- helpers
CREATE FUNCTION public.finance_school_today(p_tenant uuid) RETURNS date
LANGUAGE sql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT (now() AT TIME ZONE COALESCE((SELECT t.timezone FROM public.tenants t WHERE t.id = p_tenant), 'Africa/Nairobi'))::date
$$;

-- TS twin: src/modules/finance/money.ts invoiceStatus (tested for agreement).
CREATE FUNCTION public.finance_invoice_status(p_total bigint, p_paid bigint, p_due_on date, p_today date) RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN p_paid >= p_total THEN 'paid'
    WHEN p_due_on < p_today THEN 'overdue'
    WHEN p_paid > 0 THEN 'part_paid'
    ELSE 'unpaid'
  END
$$;

-- ---------------------------------------------------------------------------------------------------
-- fee items: one line of a term's fee structure
CREATE TABLE finance_fee_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  term_id uuid NOT NULL,
  name text NOT NULL,
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL DEFAULT 'KES',
  applies_to text NOT NULL DEFAULT 'all',
  form_level integer,
  active boolean NOT NULL DEFAULT true,
  archived_at timestamptz,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_fee_items_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT finance_fee_items_term_fk FOREIGN KEY (term_id, tenant_id) REFERENCES academic_terms (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT finance_fee_items_name_len CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT finance_fee_items_amount_chk CHECK (amount_minor > 0 AND amount_minor <= 100000000000 AND amount_minor % 100 = 0),
  CONSTRAINT finance_fee_items_currency_chk CHECK (currency = 'KES'),
  CONSTRAINT finance_fee_items_scope_chk CHECK (applies_to IN ('all', 'boarders', 'day', 'form_level')),
  CONSTRAINT finance_fee_items_level_chk CHECK ((applies_to = 'form_level') = (form_level IS NOT NULL) AND (form_level IS NULL OR form_level BETWEEN 1 AND 12)),
  CONSTRAINT finance_fee_items_archive_chk CHECK ((active AND archived_at IS NULL) OR (NOT active AND archived_at IS NOT NULL))
);
CREATE INDEX finance_fee_items_term_idx ON finance_fee_items (tenant_id, term_id) WHERE active;

-- ---------------------------------------------------------------------------------------------------
-- invoices: one live invoice per learner per term
CREATE TABLE finance_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  learner_id uuid NOT NULL,
  term_id uuid NOT NULL,
  currency char(3) NOT NULL DEFAULT 'KES',
  due_on date NOT NULL,
  lines_minor bigint NOT NULL DEFAULT 0,
  charges_minor bigint NOT NULL DEFAULT 0,
  adjustments_minor bigint NOT NULL DEFAULT 0,
  total_minor bigint NOT NULL DEFAULT 0,
  paid_minor bigint NOT NULL DEFAULT 0,
  billing_run_id uuid,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  void_reason text,
  CONSTRAINT finance_invoices_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT finance_invoices_learner_fk FOREIGN KEY (learner_id, tenant_id) REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT finance_invoices_term_fk FOREIGN KEY (term_id, tenant_id) REFERENCES academic_terms (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT finance_invoices_currency_chk CHECK (currency = 'KES'),
  CONSTRAINT finance_invoices_amounts_chk CHECK (
    lines_minor >= 0 AND charges_minor >= 0 AND total_minor >= 0 AND paid_minor >= 0
    AND total_minor = lines_minor + charges_minor + adjustments_minor
  ),
  CONSTRAINT finance_invoices_void_chk CHECK ((voided_at IS NULL) = (void_reason IS NULL) AND (voided_at IS NULL) = (voided_by IS NULL)),
  CONSTRAINT finance_invoices_void_len CHECK (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 3 AND 300)
);
CREATE UNIQUE INDEX finance_invoices_learner_term_live_uidx ON finance_invoices (tenant_id, learner_id, term_id) WHERE voided_at IS NULL;
CREATE INDEX finance_invoices_term_idx ON finance_invoices (tenant_id, term_id);
CREATE INDEX finance_invoices_learner_idx ON finance_invoices (tenant_id, learner_id);

-- lines: the fee items that made up the billed amount, snapshotted at billing (name and amount)
CREATE TABLE finance_invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL,
  fee_item_id uuid NOT NULL,
  name text NOT NULL,
  amount_minor bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_invoice_lines_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT finance_invoice_lines_invoice_fk FOREIGN KEY (invoice_id, tenant_id) REFERENCES finance_invoices (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT finance_invoice_lines_item_fk FOREIGN KEY (fee_item_id, tenant_id) REFERENCES finance_fee_items (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT finance_invoice_lines_item_uidx UNIQUE (invoice_id, fee_item_id),
  CONSTRAINT finance_invoice_lines_amount_chk CHECK (amount_minor > 0)
);

-- charges: extra lines added to an invoice after billing (legacy fee_charges); voided, never deleted
CREATE TABLE finance_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL,
  amount_minor bigint NOT NULL,
  reason text NOT NULL,
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  void_reason text,
  CONSTRAINT finance_charges_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT finance_charges_invoice_fk FOREIGN KEY (invoice_id, tenant_id) REFERENCES finance_invoices (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT finance_charges_amount_chk CHECK (amount_minor > 0 AND amount_minor <= 100000000000 AND amount_minor % 100 = 0),
  CONSTRAINT finance_charges_reason_len CHECK (char_length(btrim(reason)) BETWEEN 1 AND 200),
  CONSTRAINT finance_charges_void_chk CHECK ((voided_at IS NULL) = (void_reason IS NULL) AND (voided_at IS NULL) = (voided_by IS NULL)),
  CONSTRAINT finance_charges_void_len CHECK (void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 3 AND 300)
);
CREATE INDEX finance_charges_invoice_idx ON finance_charges (tenant_id, invoice_id);

-- adjustments: an audited change of an invoice total (legacy adjust_invoice_total); append-only
CREATE TABLE finance_invoice_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL,
  from_total_minor bigint NOT NULL,
  to_total_minor bigint NOT NULL,
  delta_minor bigint NOT NULL,
  reason text NOT NULL,
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_invoice_adjustments_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT finance_invoice_adjustments_invoice_fk FOREIGN KEY (invoice_id, tenant_id) REFERENCES finance_invoices (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT finance_invoice_adjustments_delta_chk CHECK (delta_minor = to_total_minor - from_total_minor AND delta_minor <> 0 AND to_total_minor >= 0 AND to_total_minor % 100 = 0),
  CONSTRAINT finance_invoice_adjustments_reason_len CHECK (char_length(btrim(reason)) BETWEEN 3 AND 300)
);

-- payments: each settles exactly one invoice
CREATE TABLE finance_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL,
  currency char(3) NOT NULL DEFAULT 'KES',
  amount_minor bigint NOT NULL,
  method text NOT NULL,
  status text NOT NULL,
  reference text,
  reference_norm text GENERATED ALWAYS AS (upper(regexp_replace(reference, '\s', '', 'g'))) STORED,
  mpesa_receipt text,
  checkout_request_id text,
  merchant_request_id text,
  msisdn text,
  failure_reason text,
  proof_id uuid,
  recorded_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_payments_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT finance_payments_invoice_fk FOREIGN KEY (invoice_id, tenant_id) REFERENCES finance_invoices (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT finance_payments_currency_chk CHECK (currency = 'KES'),
  CONSTRAINT finance_payments_amount_chk CHECK (amount_minor > 0 AND amount_minor <= 100000000000),
  CONSTRAINT finance_payments_method_chk CHECK (method IN ('mpesa', 'bank', 'cash', 'cheque')),
  CONSTRAINT finance_payments_status_chk CHECK (status IN ('pending', 'success', 'failed', 'cancelled', 'timeout')),
  CONSTRAINT finance_payments_reason_chk CHECK (
    failure_reason IS NULL OR failure_reason IN ('insufficient', 'cancelled', 'timeout', 'wrong_pin', 'duplicate', 'unreachable', 'not_sent')
  ),
  CONSTRAINT finance_payments_reference_len CHECK (reference IS NULL OR char_length(btrim(reference)) BETWEEN 1 AND 60),
  CONSTRAINT finance_payments_receipt_fmt CHECK (mpesa_receipt IS NULL OR mpesa_receipt ~ '^[A-Z0-9]{6,20}$'),
  CONSTRAINT finance_payments_msisdn_fmt CHECK (msisdn IS NULL OR msisdn ~ '^254[17][0-9]{8}$'),
  CONSTRAINT finance_payments_completed_chk CHECK ((status = 'pending') = (completed_at IS NULL)),
  -- an M-Pesa prompt is pending with a phone number; a manually recorded payment is success at once
  CONSTRAINT finance_payments_shape_chk CHECK (
    (method = 'mpesa' AND msisdn IS NOT NULL AND amount_minor >= 100 AND amount_minor % 100 = 0)
    OR (method = 'mpesa' AND msisdn IS NULL AND checkout_request_id IS NULL AND mpesa_receipt IS NOT NULL)
    OR (method IN ('bank', 'cheque') AND reference IS NOT NULL AND checkout_request_id IS NULL AND msisdn IS NULL)
    OR (method = 'cash' AND checkout_request_id IS NULL AND msisdn IS NULL)
  )
);
CREATE UNIQUE INDEX finance_payments_receipt_uidx ON finance_payments (mpesa_receipt) WHERE mpesa_receipt IS NOT NULL;
CREATE UNIQUE INDEX finance_payments_checkout_uidx ON finance_payments (checkout_request_id) WHERE checkout_request_id IS NOT NULL;
CREATE UNIQUE INDEX finance_payments_one_pending_uidx ON finance_payments (tenant_id, invoice_id) WHERE status = 'pending';
-- a bank deposit or cheque reference is not recorded twice on the same invoice (it may be split across invoices)
CREATE UNIQUE INDEX finance_payments_bankref_uidx ON finance_payments (tenant_id, invoice_id, reference_norm)
  WHERE method IN ('bank', 'cheque') AND status = 'success';
CREATE INDEX finance_payments_invoice_idx ON finance_payments (tenant_id, invoice_id);
CREATE INDEX finance_payments_pending_idx ON finance_payments (tenant_id, created_at) WHERE status = 'pending';

-- ---------------------------------------------------------------------------------------------------
-- derived totals: every insert/update of an invoice recomputes its money columns from the source rows
CREATE FUNCTION public.finance_invoices_recompute() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id, NEW.learner_id, NEW.term_id, NEW.currency, NEW.created_at, NEW.billing_run_id)
     IS DISTINCT FROM (OLD.tenant_id, OLD.learner_id, OLD.term_id, OLD.currency, OLD.created_at, OLD.billing_run_id) THEN
    RAISE EXCEPTION 'an invoice cannot move' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'a voided invoice is final' USING ERRCODE = '23514';
  END IF;
  NEW.lines_minor := COALESCE((SELECT sum(l.amount_minor) FROM public.finance_invoice_lines l WHERE l.invoice_id = NEW.id AND l.tenant_id = NEW.tenant_id), 0);
  NEW.charges_minor := COALESCE((SELECT sum(c.amount_minor) FROM public.finance_charges c WHERE c.invoice_id = NEW.id AND c.tenant_id = NEW.tenant_id AND c.voided_at IS NULL), 0);
  NEW.adjustments_minor := COALESCE((SELECT sum(a.delta_minor) FROM public.finance_invoice_adjustments a WHERE a.invoice_id = NEW.id AND a.tenant_id = NEW.tenant_id), 0);
  NEW.total_minor := NEW.lines_minor + NEW.charges_minor + NEW.adjustments_minor;
  NEW.paid_minor := COALESCE((SELECT sum(p.amount_minor) FROM public.finance_payments p WHERE p.invoice_id = NEW.id AND p.tenant_id = NEW.tenant_id AND p.status = 'success'), 0);
  IF TG_OP = 'UPDATE' AND NEW.voided_at IS NOT NULL AND (
       EXISTS (SELECT 1 FROM public.finance_payments p WHERE p.invoice_id = NEW.id AND p.tenant_id = NEW.tenant_id)
    OR EXISTS (SELECT 1 FROM public.finance_charges c WHERE c.invoice_id = NEW.id AND c.tenant_id = NEW.tenant_id AND c.voided_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'an invoice with payments or live charges cannot be voided' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finance_invoices_recompute BEFORE INSERT OR UPDATE ON finance_invoices
  FOR EACH ROW EXECUTE FUNCTION public.finance_invoices_recompute();

-- any change to a source row touches its invoice, which recomputes
CREATE FUNCTION public.finance_touch_invoice() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  UPDATE public.finance_invoices SET updated_at = now() WHERE id = NEW.invoice_id AND tenant_id = NEW.tenant_id;
  RETURN NULL;
END;
$$;
CREATE TRIGGER finance_invoice_lines_touch AFTER INSERT ON finance_invoice_lines FOR EACH ROW EXECUTE FUNCTION public.finance_touch_invoice();
CREATE TRIGGER finance_charges_touch AFTER INSERT OR UPDATE ON finance_charges FOR EACH ROW EXECUTE FUNCTION public.finance_touch_invoice();
CREATE TRIGGER finance_adjustments_touch AFTER INSERT ON finance_invoice_adjustments FOR EACH ROW EXECUTE FUNCTION public.finance_touch_invoice();
CREATE TRIGGER finance_payments_touch AFTER INSERT OR UPDATE ON finance_payments FOR EACH ROW EXECUTE FUNCTION public.finance_touch_invoice();

-- lines are only written while the invoice is being billed (still empty of payments) and never change
CREATE FUNCTION public.finance_invoice_lines_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.finance_payments p WHERE p.invoice_id = NEW.invoice_id AND p.tenant_id = NEW.tenant_id)
     OR EXISTS (SELECT 1 FROM public.finance_invoices i WHERE i.id = NEW.invoice_id AND i.tenant_id = NEW.tenant_id AND i.voided_at IS NOT NULL) THEN
    RAISE EXCEPTION 'lines are fixed once an invoice has payments or is voided' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finance_invoice_lines_guard BEFORE INSERT ON finance_invoice_lines FOR EACH ROW EXECUTE FUNCTION public.finance_invoice_lines_guard();

-- charges: live invoice only; a void is final and may not drop the total below what is paid
CREATE FUNCTION public.finance_charges_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_inv public.finance_invoices%ROWTYPE;
BEGIN
  SELECT * INTO v_inv FROM public.finance_invoices WHERE id = NEW.invoice_id AND tenant_id = NEW.tenant_id FOR UPDATE;
  IF v_inv.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'the invoice is voided' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'a voided charge is final' USING ERRCODE = '23514';
    END IF;
    IF (NEW.invoice_id, NEW.amount_minor, NEW.reason, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.invoice_id, OLD.amount_minor, OLD.reason, OLD.created_by, OLD.created_at) THEN
      RAISE EXCEPTION 'a charge cannot change; void it instead' USING ERRCODE = '23514';
    END IF;
    IF NEW.voided_at IS NOT NULL AND v_inv.paid_minor > v_inv.total_minor - OLD.amount_minor THEN
      RAISE EXCEPTION 'already paid for' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finance_charges_guard BEFORE INSERT OR UPDATE ON finance_charges FOR EACH ROW EXECUTE FUNCTION public.finance_charges_guard();

-- adjustments: the recorded "from" must be the current total; the new total covers what is paid and charged
CREATE FUNCTION public.finance_adjustments_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_inv public.finance_invoices%ROWTYPE;
BEGIN
  SELECT * INTO v_inv FROM public.finance_invoices WHERE id = NEW.invoice_id AND tenant_id = NEW.tenant_id FOR UPDATE;
  IF v_inv.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'the invoice is voided' USING ERRCODE = '23514';
  END IF;
  IF NEW.from_total_minor <> v_inv.total_minor THEN
    RAISE EXCEPTION 'the invoice total changed meanwhile' USING ERRCODE = 'FB409';
  END IF;
  IF NEW.to_total_minor < v_inv.paid_minor OR NEW.to_total_minor < v_inv.charges_minor THEN
    RAISE EXCEPTION 'the new total is below what is paid or charged' USING ERRCODE = '23514';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER finance_adjustments_guard BEFORE INSERT ON finance_invoice_adjustments FOR EACH ROW EXECUTE FUNCTION public.finance_adjustments_guard();

-- payments: invoice live; a manual payment never exceeds the balance (locked, so concurrent payments
-- serialise); only a pending M-Pesa prompt changes, once, to a final state; everything else is final.
CREATE FUNCTION public.finance_payments_guard() RETURNS trigger
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
CREATE TRIGGER finance_payments_guard BEFORE INSERT OR UPDATE ON finance_payments FOR EACH ROW EXECUTE FUNCTION public.finance_payments_guard();

-- fee items: term and currency fixed; archive is one-way
CREATE FUNCTION public.finance_fee_items_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW.tenant_id, NEW.term_id, NEW.currency, NEW.created_by, NEW.created_at) IS DISTINCT FROM (OLD.tenant_id, OLD.term_id, OLD.currency, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'a fee item cannot move' USING ERRCODE = '23514';
  END IF;
  IF NOT OLD.active THEN
    RAISE EXCEPTION 'an archived fee item is final' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER finance_fee_items_guard BEFORE UPDATE ON finance_fee_items FOR EACH ROW EXECUTE FUNCTION public.finance_fee_items_guard();

-- ---------------------------------------------------------------------------------------------------
-- RLS, grants
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_fee_items', 'finance_invoices', 'finance_invoice_lines', 'finance_charges',
                           'finance_invoice_adjustments', 'finance_payments']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO figbloom_app USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', t || '_tenant', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO figbloom_worker USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())', t || '_worker', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I FOR ALL TO PUBLIC
      USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))
      WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))
    $f$, t || '_owner', t, t, t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO figbloom_app', t);
    EXECUTE format('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM figbloom_app', t);
    EXECUTE format('GRANT SELECT ON %I TO figbloom_worker', t);
  END LOOP;
END $$;

GRANT UPDATE (name, amount_minor, applies_to, form_level, active, archived_at, updated_at) ON finance_fee_items TO figbloom_app;
GRANT UPDATE (due_on, updated_at, voided_at, voided_by, void_reason) ON finance_invoices TO figbloom_app;
GRANT UPDATE (voided_at, voided_by, void_reason) ON finance_charges TO figbloom_app;
GRANT UPDATE (status, mpesa_receipt, checkout_request_id, merchant_request_id, failure_reason, completed_at, updated_at) ON finance_payments TO figbloom_app;
-- the worker settles M-Pesa prompts; the touch trigger updates the invoice's updated_at
GRANT UPDATE (status, mpesa_receipt, failure_reason, completed_at, updated_at) ON finance_payments TO figbloom_worker;
GRANT UPDATE (updated_at) ON finance_invoices TO figbloom_worker;

DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['finance_invoices_recompute()', 'finance_touch_invoice()', 'finance_invoice_lines_guard()',
    'finance_charges_guard()', 'finance_adjustments_guard()', 'finance_payments_guard()', 'finance_fee_items_guard()']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM figbloom_app', f);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.finance_school_today(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finance_school_today(uuid) TO figbloom_app, figbloom_worker;
REVOKE ALL ON FUNCTION public.finance_invoice_status(bigint, bigint, date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finance_invoice_status(bigint, bigint, date, date) TO figbloom_app, figbloom_worker;

-- permissions (codes, not roles): read/write for the Fees admin area and school admins; administer
-- (legacy "full admin" operations: charges, total adjustments, voids, proof rejection) for school admins only
INSERT INTO permissions (code, description) VALUES
  ('resource.finance.read', 'Read fee items, invoices, payments, proofs and reconciliation in tenant'),
  ('resource.finance.write', 'Manage fee items, bill a term, record payments, confirm proofs, run reconciliation'),
  ('resource.finance.administer', 'Charges, invoice total adjustments, voids, proof rejection, AI helper billing settings')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'resource.finance.read'),
  ('school_admin', 'resource.finance.write'),
  ('school_admin', 'resource.finance.administer')
ON CONFLICT DO NOTHING;
