-- Stage 11 remediation, batch 3: overpayment policy. Forward-only.
--
-- Rule (owner decision): an invoice is never credited beyond its outstanding balance, and a payment the
-- provider confirmed is never silently discarded. The provider-confirmed amount (amount_minor) is immutable;
-- what reaches the invoice is `applied_minor`, decided by the database under the invoice lock when the payment
-- becomes a success; the remainder is `unapplied_minor` and stays on the payment as an explicit, auditable
-- record pending an approved allocation or refund workflow (none is invented here).
--
--   applied_minor   = LEAST(amount_minor, outstanding balance at the moment of settlement)
--   unapplied_minor = amount_minor - applied_minor              (generated, success only)
--   invoice.paid_minor = sum(applied_minor) of successful payments  (never above the invoice total)
--
-- Deployment notes: ADD COLUMN ... GENERATED ... STORED rewrites finance_payments under an ACCESS EXCLUSIVE lock.
-- The backfill treats every payment settled before this migration as fully applied (that is how it was credited);
-- the rebuild has not been deployed, so no invoice was over-credited before it. If one were, it would keep showing as an
-- 'overpaid_invoice' finding rather than be re-allocated here.
-- The worker allowlist below includes the unapplied event ahead of need on purpose: the evidence-recovery work (batch 5)
-- lets the settle job credit a payment, and that is the first path on which the worker emits it.
--
-- Office payments are still refused above the balance, so their applied amount is their amount. The case this
-- exists for is an M-Pesa prompt that settles after the balance was reduced (a manual payment or a lowered
-- total while the prompt was pending): previously it credited the invoice beyond its total.

ALTER TABLE finance_payments ADD COLUMN applied_minor bigint;
ALTER TABLE finance_payments ADD COLUMN unapplied_minor bigint
  GENERATED ALWAYS AS (CASE WHEN status = 'success' THEN amount_minor - applied_minor END) STORED;

-- history: every payment already settled applied its whole amount (that is how it was credited)
ALTER TABLE finance_payments DISABLE TRIGGER finance_payments_guard;
UPDATE finance_payments SET applied_minor = amount_minor WHERE status = 'success';
ALTER TABLE finance_payments ENABLE TRIGGER finance_payments_guard;

ALTER TABLE finance_payments ADD CONSTRAINT finance_payments_applied_chk CHECK (
  (status = 'success') = (applied_minor IS NOT NULL)
  AND (applied_minor IS NULL OR (applied_minor >= 0 AND applied_minor <= amount_minor))
);

CREATE OR REPLACE FUNCTION public.finance_invoices_recompute() RETURNS trigger
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
  -- what the invoice is credited with is what was APPLIED, never the provider-confirmed amount itself
  NEW.paid_minor := COALESCE((SELECT sum(p.applied_minor) FROM public.finance_payments p WHERE p.invoice_id = NEW.id AND p.tenant_id = NEW.tenant_id AND p.status = 'success'), 0);
  IF TG_OP = 'UPDATE' AND NEW.voided_at IS NOT NULL AND (
       EXISTS (SELECT 1 FROM public.finance_payments p WHERE p.invoice_id = NEW.id AND p.tenant_id = NEW.tenant_id)
    OR EXISTS (SELECT 1 FROM public.finance_charges c WHERE c.invoice_id = NEW.id AND c.tenant_id = NEW.tenant_id AND c.voided_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'an invoice with payments or live charges cannot be voided' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

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
      NEW.applied_minor := NEW.amount_minor; -- a manual payment never exceeds the balance (checked above)
    ELSIF NEW.status = 'pending' THEN
      IF NEW.method <> 'mpesa' THEN
        RAISE EXCEPTION 'only an M-Pesa prompt is pending' USING ERRCODE = '23514';
      END IF;
      NEW.completed_at := NULL;
      NEW.applied_minor := NULL;
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
    NEW.applied_minor := NULL;
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
  -- lock the invoice so its recompute and this allocation are serialised with every other payment
  SELECT * INTO v_inv FROM public.finance_invoices WHERE id = NEW.invoice_id AND tenant_id = NEW.tenant_id FOR UPDATE;
  IF NEW.status = 'success' THEN
    -- never above the outstanding balance at this moment; the excess is the unapplied amount
    v_outstanding := GREATEST(v_inv.total_minor - v_inv.paid_minor, 0);
    NEW.applied_minor := LEAST(NEW.amount_minor, v_outstanding);
  ELSE
    NEW.applied_minor := NULL;
  END IF;
  NEW.completed_at := now();
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- the worker may now also record an unapplied-amount event (a settlement that applied less than it received)
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
    IF NEW.event_type NOT IN ('job.succeeded', 'job.retry_scheduled', 'job.dead', 'finance.mpesa.settled', 'finance.payment.unapplied') THEN
      RAISE EXCEPTION 'event type not allowed for the worker role' USING ERRCODE = '42501';
    END IF;
    NEW.occurred_at := now();
    NEW.id := gen_random_uuid();
  END IF;
  RETURN NEW;
END;
$$;

-- reconciliation: an unapplied amount is a finding until a person resolves it
ALTER TABLE finance_reconciliation_findings DROP CONSTRAINT finance_reconciliation_findings_kind_chk;
ALTER TABLE finance_reconciliation_findings ADD CONSTRAINT finance_reconciliation_findings_kind_chk CHECK (kind IN (
  'invoice_total_mismatch', 'overpaid_invoice', 'stale_pending_prompt', 'prompt_never_sent',
  'callback_amount_mismatch', 'proof_already_paid', 'unapplied_payment'));
