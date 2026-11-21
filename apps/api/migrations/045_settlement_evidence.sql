-- Stage 11 remediation, batches 4 and 5: audited operator reconciliation and recoverable settlement evidence.
-- Forward-only.
--
-- finance_mpesa_events is the append-only evidence ledger of every provider answer about a prompt. It gains:
--   * source 'operator': a finance administrator's reconciliation act, with the acting user and a mandatory reason;
--   * outcomes for the new evidence rules: 'callback_received' (an authenticated callback is persisted BEFORE the
--     provider is queried, so a failed query or a 503 never loses its receipt), 'duplicate_receipt' (the receipt is
--     already another payment's; previously mislabelled settled_failure), 'evidence_recovered' (a stored callback
--     receipt was used by a later settlement), 'evidence_conflict' (stored receipts disagree: nothing is credited),
--     'operator_inconclusive' (an operator act that could not be completed; a completed one is a normal settled_* row with source 'operator');
--   * evidence_basis: where a credited receipt came from (this callback, an earlier stored callback, or the operator).
-- A receipt is never synthesised: it comes from an authenticated callback or is typed by an authorised operator, and
-- the database still refuses a success without a unique, well-formed receipt (040/044).
--
-- Provenance guard: the worker role may only write 'status_query' events (what it asked the provider, never an
-- authenticated callback and never an operator act), so a compromised worker cannot plant callback evidence that a later
-- settlement would trust.

-- the ledger is read oldest first: two rows written in one transaction must keep their order, so the time is taken per row
ALTER TABLE finance_mpesa_events ALTER COLUMN received_at SET DEFAULT clock_timestamp();

ALTER TABLE finance_mpesa_events ADD COLUMN actor_user_id uuid REFERENCES users (id) ON DELETE RESTRICT;
ALTER TABLE finance_mpesa_events ADD COLUMN operator_note text;
ALTER TABLE finance_mpesa_events ADD COLUMN evidence_basis text;
ALTER TABLE finance_mpesa_events ADD COLUMN provider_view text; -- what the provider said when an operator acted: 'query:<code>', 'query:pending', 'unavailable'
ALTER TABLE finance_mpesa_events ADD CONSTRAINT finance_mpesa_events_provider_view_chk CHECK (provider_view IS NULL OR char_length(provider_view) <= 40);

ALTER TABLE finance_mpesa_events DROP CONSTRAINT finance_mpesa_events_source_chk;
ALTER TABLE finance_mpesa_events ADD CONSTRAINT finance_mpesa_events_source_chk CHECK (source IN ('callback', 'status_query', 'operator'));
ALTER TABLE finance_mpesa_events DROP CONSTRAINT finance_mpesa_events_outcome_chk;
ALTER TABLE finance_mpesa_events ADD CONSTRAINT finance_mpesa_events_outcome_chk CHECK (outcome IN (
  'settled_success', 'settled_failure', 'already_settled', 'provider_pending', 'provider_error', 'not_sent',
  'callback_received', 'duplicate_receipt', 'evidence_recovered', 'evidence_conflict', 'operator_inconclusive'));
ALTER TABLE finance_mpesa_events ADD CONSTRAINT finance_mpesa_events_operator_chk CHECK (
  (source = 'operator') = (actor_user_id IS NOT NULL)
  AND (source = 'operator') = (operator_note IS NOT NULL)
  AND (operator_note IS NULL OR char_length(btrim(operator_note)) BETWEEN 10 AND 500));
ALTER TABLE finance_mpesa_events ADD CONSTRAINT finance_mpesa_events_basis_chk CHECK (
  evidence_basis IS NULL OR evidence_basis IN ('callback', 'stored_callback', 'operator_receipt'));

CREATE INDEX finance_mpesa_events_evidence_idx ON finance_mpesa_events (tenant_id, payment_id, source, received_at, id);

-- Operator-typed receipts are the one receipt the system did not receive from the provider itself, so every credit made on one
-- is raised by reconciliation until a person has looked at it, and a typed receipt that the unmatched-callback quarantine already
-- holds for ANOTHER checkout id is refused (the quarantine is owner-only; this narrow definer answers only yes or no).
ALTER TABLE finance_reconciliation_findings DROP CONSTRAINT finance_reconciliation_findings_kind_chk;
ALTER TABLE finance_reconciliation_findings ADD CONSTRAINT finance_reconciliation_findings_kind_chk CHECK (kind IN (
  'invoice_total_mismatch', 'overpaid_invoice', 'stale_pending_prompt', 'prompt_never_sent',
  'callback_amount_mismatch', 'proof_already_paid', 'unapplied_payment', 'operator_receipt_credit', 'recovered_receipt_credit',
  'contradicted_success_callback', 'callback_receipt_mismatch'));

CREATE FUNCTION public.finance_mpesa_quarantine_has_receipt(p_receipt text, p_checkout text) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.finance_mpesa_unmatched_callbacks q
     WHERE q.receipt = p_receipt AND q.checkout_request_id <> p_checkout)
$$;
REVOKE ALL ON FUNCTION public.finance_mpesa_quarantine_has_receipt(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finance_mpesa_quarantine_has_receipt(text, text) TO figbloom_app;

CREATE FUNCTION public.finance_mpesa_events_source_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF current_user = 'figbloom_worker'
     AND (NEW.source <> 'status_query' OR NEW.actor_user_id IS NOT NULL OR NEW.operator_note IS NOT NULL) THEN
    RAISE EXCEPTION 'the worker role may only record its own provider queries' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER finance_mpesa_events_source_guard BEFORE INSERT ON finance_mpesa_events
  FOR EACH ROW EXECUTE FUNCTION public.finance_mpesa_events_source_guard();
REVOKE ALL ON FUNCTION public.finance_mpesa_events_source_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finance_mpesa_events_source_guard() FROM figbloom_app;
