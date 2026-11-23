-- Acceptance programme (owner decision 6.3): a dead job must not mean a dead financial workflow; unresolved payments are
-- observable, owned, aged, escalated and re-raised when new evidence arrives. Forward-only. Provider evidence stays
-- authoritative: nothing here settles or fails a payment; it only creates/updates reconciliation CASES (findings).
--
-- 1. finance_reconciliation_findings becomes a case record: owner_queue / owner_user_id, assigned_at, last_evaluated_at,
--    escalated_at, reopened_count, resolution_evidence. Runs may be started by the system sweep (started_by NULL).
--    New kinds: dead_settlement_job (settle job dead, payment still pending), paid_unconfirmed_no_callback (the provider
--    query said paid but no authenticated callback receipt is stored). prompt_never_sent / stale_pending_prompt are also
--    raised by the sweep.
-- 2. finance_reconciliation_sweep(): worker-only, cross-tenant by design (like jobs_claim). Raises each case once, RE-RAISES a
--    resolved case only when NEWER evidence exists than its last resolution, escalates open cases older than 24 h exactly
--    once, refreshes last_evaluated_at, and audits from inside the function.
-- 3. worker_heartbeats + worker_heartbeat(): liveness signal; no payloads, no PII.
-- 4. finance_ops_snapshot(): platform aggregate counters (queue depth/lag, dead jobs, oldest open case, unmatched callbacks).

ALTER TABLE public.finance_reconciliation_runs ALTER COLUMN started_by DROP NOT NULL;
ALTER TABLE public.finance_reconciliation_runs ADD COLUMN source text NOT NULL DEFAULT 'manual';
ALTER TABLE public.finance_reconciliation_runs ADD CONSTRAINT finance_reconciliation_runs_source_chk CHECK (
  (source = 'manual' AND started_by IS NOT NULL) OR (source = 'sweep' AND started_by IS NULL));

ALTER TABLE public.finance_reconciliation_findings DROP CONSTRAINT finance_reconciliation_findings_kind_chk;
ALTER TABLE public.finance_reconciliation_findings ADD CONSTRAINT finance_reconciliation_findings_kind_chk CHECK (kind IN (
  'invoice_total_mismatch', 'overpaid_invoice', 'stale_pending_prompt', 'prompt_never_sent',
  'callback_amount_mismatch', 'proof_already_paid', 'unapplied_payment', 'operator_receipt_credit', 'recovered_receipt_credit',
  'contradicted_success_callback', 'callback_receipt_mismatch', 'dead_settlement_job', 'paid_unconfirmed_no_callback'));
ALTER TABLE public.finance_reconciliation_findings
  ADD COLUMN owner_queue text NOT NULL DEFAULT 'finance',
  ADD COLUMN owner_user_id uuid REFERENCES public.users (id) ON DELETE SET NULL,
  ADD COLUMN assigned_at timestamptz,
  ADD COLUMN last_evaluated_at timestamptz,
  ADD COLUMN escalated_at timestamptz,
  ADD COLUMN reopened_count integer NOT NULL DEFAULT 0,
  ADD COLUMN resolution_evidence text,
  ADD CONSTRAINT finance_reconciliation_findings_evidence_len CHECK (resolution_evidence IS NULL OR char_length(btrim(resolution_evidence)) BETWEEN 3 AND 1000),
  ADD CONSTRAINT finance_reconciliation_findings_owner_chk CHECK (owner_queue IN ('finance'));
GRANT UPDATE (owner_user_id, assigned_at, resolution_evidence) ON public.finance_reconciliation_findings TO figbloom_app;
CREATE INDEX finance_reconciliation_findings_case_idx ON public.finance_reconciliation_findings (tenant_id, kind, subject_id, created_at DESC);

-- 038 allowed only the resolution columns to change. Case management (owner, aging, escalation, evidence) needs a few more; the
-- identity of a case (tenant, run, kind, subject, detail, created_at) stays immutable and a resolved case stays final.
CREATE OR REPLACE FUNCTION public.finance_reconciliation_findings_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_mutable constant text[] := ARRAY['status', 'resolved_by', 'resolved_at', 'resolution_note', 'resolution_evidence',
                                       'owner_user_id', 'assigned_at', 'last_evaluated_at', 'escalated_at'];
BEGIN
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'a resolved finding is final' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - v_mutable) IS DISTINCT FROM (to_jsonb(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'a finding cannot change; resolve it instead' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'resolved' THEN
    NEW.resolved_at := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE public.worker_heartbeats (
  worker_name text PRIMARY KEY CHECK (char_length(worker_name) BETWEEN 1 AND 80),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_cycle_outcome text,
  last_sweep_at timestamptz,
  last_sweep_cases integer
);
ALTER TABLE public.worker_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.worker_heartbeats FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_heartbeats_owner ON public.worker_heartbeats FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'worker_heartbeats'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'worker_heartbeats'));
REVOKE ALL ON public.worker_heartbeats FROM PUBLIC, figbloom_app, figbloom_worker;

CREATE FUNCTION public.worker_heartbeat(p_worker text, p_outcome text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF session_user IS DISTINCT FROM 'figbloom_worker' THEN
    RAISE EXCEPTION 'worker_heartbeat is executable only as figbloom_worker' USING ERRCODE = '42501';
  END IF;
  IF p_worker IS NULL OR char_length(p_worker) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'worker name required' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.worker_heartbeats (worker_name, last_seen_at, last_cycle_outcome)
  VALUES (p_worker, now(), left(p_outcome, 40))
  ON CONFLICT (worker_name) DO UPDATE SET last_seen_at = now(), last_cycle_outcome = left(p_outcome, 40);
END;
$$;
REVOKE ALL ON FUNCTION public.worker_heartbeat(text, text) FROM PUBLIC, figbloom_app;
GRANT EXECUTE ON FUNCTION public.worker_heartbeat(text, text) TO figbloom_worker;

CREATE FUNCTION public.finance_reconciliation_sweep(p_worker text, p_stale_minutes integer DEFAULT 60) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_raised integer := 0;
BEGIN
  IF session_user IS DISTINCT FROM 'figbloom_worker' THEN
    RAISE EXCEPTION 'finance_reconciliation_sweep is executable only as figbloom_worker' USING ERRCODE = '42501';
  END IF;
  IF p_stale_minutes IS NULL OR p_stale_minutes NOT BETWEEN 5 AND 10080 THEN
    RAISE EXCEPTION 'stale minutes must be 5..10080' USING ERRCODE = '22023';
  END IF;

  CREATE TEMP TABLE sweep_cand ON COMMIT DROP AS
  SELECT p.tenant_id, 'dead_settlement_job'::text AS kind, p.id AS subject_id,
         jsonb_build_object('invoice_id', p.invoice_id, 'amount_minor', p.amount_minor, 'job_error', j.last_error_code) AS detail,
         coalesce(j.finished_at, p.created_at) AS evidence_at
    FROM public.finance_payments p
    JOIN public.tenants t ON t.id = p.tenant_id AND t.status <> 'suspended'
    JOIN public.jobs j ON j.tenant_id = p.tenant_id AND j.job_type = 'mpesa.stk_settle' AND j.idempotency_key = 'settle:' || p.id::text AND j.status = 'dead'
   WHERE p.method = 'mpesa' AND p.status = 'pending'
  UNION ALL
  SELECT p.tenant_id, 'paid_unconfirmed_no_callback', p.id,
         jsonb_build_object('invoice_id', p.invoice_id, 'amount_minor', p.amount_minor), max(e.received_at)
    FROM public.finance_payments p
    JOIN public.tenants t ON t.id = p.tenant_id AND t.status <> 'suspended'
    JOIN public.finance_mpesa_events e ON e.tenant_id = p.tenant_id AND e.payment_id = p.id AND e.source = 'status_query'
         AND e.outcome = 'provider_pending' AND e.result_code = 0
   WHERE p.method = 'mpesa' AND p.status = 'pending'
     AND NOT EXISTS (SELECT 1 FROM public.finance_mpesa_events c WHERE c.tenant_id = p.tenant_id AND c.payment_id = p.id
                      AND c.source = 'callback' AND c.outcome = 'callback_received' AND c.result_code = 0 AND c.receipt IS NOT NULL)
   GROUP BY p.tenant_id, p.id, p.invoice_id, p.amount_minor
  UNION ALL
  SELECT p.tenant_id, 'prompt_never_sent', p.id,
         jsonb_build_object('invoice_id', p.invoice_id, 'amount_minor', p.amount_minor, 'status', p.status, 'created_at', p.created_at), p.created_at
    FROM public.finance_payments p
    JOIN public.tenants t ON t.id = p.tenant_id AND t.status <> 'suspended'
   WHERE p.method = 'mpesa' AND p.status = 'pending' AND p.checkout_request_id IS NULL AND p.msisdn IS NOT NULL
     AND p.created_at < now() - make_interval(mins => p_stale_minutes)
  UNION ALL
  SELECT p.tenant_id, 'stale_pending_prompt', p.id,
         jsonb_build_object('invoice_id', p.invoice_id, 'amount_minor', p.amount_minor, 'created_at', p.created_at), p.created_at
    FROM public.finance_payments p
    JOIN public.tenants t ON t.id = p.tenant_id AND t.status <> 'suspended'
   WHERE p.status = 'pending' AND p.checkout_request_id IS NOT NULL
     AND p.created_at < now() - make_interval(mins => p_stale_minutes);

  UPDATE public.finance_reconciliation_findings f SET last_evaluated_at = now()
    FROM sweep_cand c
   WHERE f.tenant_id = c.tenant_id AND f.status = 'open' AND f.kind = c.kind AND f.subject_id = c.subject_id;

  CREATE TEMP TABLE sweep_raise ON COMMIT DROP AS
  SELECT c.*, coalesce(prev.n, 0) AS prev_resolved
    FROM sweep_cand c
    LEFT JOIN LATERAL (SELECT count(*)::int AS n, max(f.resolved_at) AS last_resolved
                         FROM public.finance_reconciliation_findings f
                        WHERE f.tenant_id = c.tenant_id AND f.kind = c.kind AND f.subject_id = c.subject_id AND f.status = 'resolved') prev ON true
   WHERE NOT EXISTS (SELECT 1 FROM public.finance_reconciliation_findings o
                      WHERE o.tenant_id = c.tenant_id AND o.kind = c.kind AND o.subject_id = c.subject_id AND o.status = 'open')
     AND (coalesce(prev.n, 0) = 0 OR c.evidence_at > prev.last_resolved);

  CREATE TEMP TABLE sweep_runs ON COMMIT DROP AS
  WITH ins AS (
    INSERT INTO public.finance_reconciliation_runs (tenant_id, started_by, source, stale_after_minutes)
    SELECT DISTINCT r.tenant_id, NULL::uuid, 'sweep', p_stale_minutes FROM sweep_raise r
    RETURNING id, tenant_id)
  SELECT * FROM ins;

  WITH ins AS (
    INSERT INTO public.finance_reconciliation_findings (tenant_id, run_id, kind, subject_type, subject_id, detail, last_evaluated_at, reopened_count)
    SELECT r.tenant_id, sr.id, r.kind, 'payment', r.subject_id, r.detail, now(), r.prev_resolved
      FROM sweep_raise r JOIN sweep_runs sr ON sr.tenant_id = r.tenant_id
    RETURNING id, tenant_id, run_id, kind, subject_id, reopened_count),
  audit AS (
    INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
    SELECT NULL, i.tenant_id, 'finance.reconciliation.case_raised',
           jsonb_build_object('findingId', i.id, 'kind', i.kind, 'subjectId', i.subject_id, 'reopenedCount', i.reopened_count, 'actingVia', 'worker')
      FROM ins i
    RETURNING 1)
  UPDATE public.finance_reconciliation_runs u SET findings_count = x.n
    FROM (SELECT run_id, count(*)::int AS n FROM ins GROUP BY run_id) x
   WHERE u.id = x.run_id;
  SELECT count(*)::int INTO v_raised FROM sweep_raise;

  WITH esc AS (
    UPDATE public.finance_reconciliation_findings f SET escalated_at = now()
     WHERE f.status = 'open' AND f.escalated_at IS NULL AND f.created_at < now() - interval '24 hours'
    RETURNING f.id, f.tenant_id, f.kind)
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  SELECT NULL, e.tenant_id, 'finance.reconciliation.case_escalated', jsonb_build_object('findingId', e.id, 'kind', e.kind, 'actingVia', 'worker') FROM esc e;

  INSERT INTO public.worker_heartbeats (worker_name, last_seen_at, last_sweep_at, last_sweep_cases)
  VALUES (p_worker, now(), now(), v_raised)
  ON CONFLICT (worker_name) DO UPDATE SET last_sweep_at = now(), last_sweep_cases = v_raised, last_seen_at = now();
  RETURN v_raised;
END;
$$;
REVOKE ALL ON FUNCTION public.finance_reconciliation_sweep(text, integer) FROM PUBLIC, figbloom_app;
GRANT EXECUTE ON FUNCTION public.finance_reconciliation_sweep(text, integer) TO figbloom_worker;

CREATE FUNCTION public.finance_ops_snapshot() RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_build_object(
    'generated_at', now(),
    'workers', coalesce((SELECT jsonb_agg(jsonb_build_object('worker', w.worker_name, 'last_seen_age_seconds', extract(epoch FROM now() - w.last_seen_at)::int,
                                                          'last_sweep_age_seconds', extract(epoch FROM now() - w.last_sweep_at)::int, 'last_cycle_outcome', w.last_cycle_outcome))
                           FROM public.worker_heartbeats w), '[]'::jsonb),
    'queue', jsonb_build_object(
      'queued_due', (SELECT count(*) FROM public.jobs WHERE status = 'queued' AND run_after <= now()),
      'queued_future', (SELECT count(*) FROM public.jobs WHERE status = 'queued' AND run_after > now()),
      'leased', (SELECT count(*) FROM public.jobs WHERE status = 'leased'),
      'dead', (SELECT count(*) FROM public.jobs WHERE status = 'dead'),
      'oldest_due_lag_seconds', (SELECT extract(epoch FROM now() - min(run_after))::int FROM public.jobs WHERE status = 'queued' AND run_after <= now()),
      'retrying', (SELECT count(*) FROM public.jobs WHERE status = 'queued' AND attempts > 0)),
    'reconciliation', jsonb_build_object(
      'open_cases', (SELECT count(*) FROM public.finance_reconciliation_findings WHERE status = 'open'),
      'escalated_open', (SELECT count(*) FROM public.finance_reconciliation_findings WHERE status = 'open' AND escalated_at IS NOT NULL),
      'unassigned_open', (SELECT count(*) FROM public.finance_reconciliation_findings WHERE status = 'open' AND owner_user_id IS NULL),
      'oldest_open_age_seconds', (SELECT extract(epoch FROM now() - min(created_at))::int FROM public.finance_reconciliation_findings WHERE status = 'open')),
    'unmatched_callbacks', (SELECT count(*) FROM public.finance_mpesa_unmatched_callbacks)
  );
$$;
REVOKE ALL ON FUNCTION public.finance_ops_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finance_ops_snapshot() TO figbloom_app;

-- 5. Operator withdrawal of a prompt the provider never acknowledged (FIN-1) records failure_reason 'operator_withdrawn'.
--    It is permitted only through the audited, evidenced route (reconciliationCases.ts), never by a worker.
ALTER TABLE public.finance_payments DROP CONSTRAINT finance_payments_reason_chk;
ALTER TABLE public.finance_payments ADD CONSTRAINT finance_payments_reason_chk CHECK (failure_reason IS NULL OR failure_reason = ANY (ARRAY[
  'insufficient', 'cancelled', 'timeout', 'wrong_pin', 'duplicate', 'unreachable', 'not_sent', 'operator_withdrawn']));
