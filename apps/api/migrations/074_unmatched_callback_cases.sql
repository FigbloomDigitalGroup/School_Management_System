-- Unmatched provider callbacks become managed CASES (acceptance programme workstream 2). Forward-only.
--
-- Until now a callback whose CheckoutRequestID matched no prompt was appended to an operator-only quarantine that nobody could
-- list, own, retry, escalate or resolve, and a repeated callback added another anonymous row. Provider evidence stays authoritative:
-- nothing here credits money, settles or fails a payment, or fabricates evidence.
--
--   finance_mpesa_unmatched_callbacks  stays the append-only EVIDENCE ledger (one row per DISTINCT callback payload; verbatim
--                                      provider fields only; masked phone). It gains case_id and evidence_key.
--   finance_unmatched_cases            one case per CheckoutRequestID: status, owner, aging, retry counters, escalation,
--                                      resolution (reason AND evidence), reopen count.
--   finance_unmatched_case_notes       operator investigation notes (append-only).
--
-- Behaviour:
--   * an IDENTICAL repeated callback only increments the occurrence counter (no duplicate effect, no reopen);
--   * a DIFFERENT payload for the same CheckoutRequestID (contradictory or late evidence) is PRESERVED and, on a resolved case,
--     REOPENS it (reopened_count + 1, audited); on an open case it flags the contradiction;
--   * retry matching hands the stored evidence to the payment that now carries that checkout id as ordinary 'callback_received'
--     events; settlement still requires the provider-confirmed path (settle job / operator reconciliation), so a callback alone is
--     never proof of payment;
--   * the worker sweep re-evaluates and escalates stale cases; operators (super administrators) assign, annotate, retry, escalate,
--     resolve (reason + evidence) and reopen. Every mutation is audited with actor, prior and resulting state.

CREATE TABLE public.finance_unmatched_cases (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkout_request_id text NOT NULL UNIQUE CHECK (char_length(checkout_request_id) BETWEEN 1 AND 80),
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  occurrences         integer NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  contradictory       boolean NOT NULL DEFAULT false,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  owner_user_id       uuid REFERENCES public.users (id) ON DELETE SET NULL,
  assigned_at         timestamptz,
  escalated_at        timestamptz,
  last_evaluated_at   timestamptz,
  retry_count         integer NOT NULL DEFAULT 0,
  last_retry_at       timestamptz,
  last_retry_outcome  text CHECK (last_retry_outcome IN ('matched_payment', 'no_match', 'already_handed')),
  last_error_class    text,
  matched_tenant_id   uuid REFERENCES public.tenants (id) ON DELETE SET NULL,
  matched_payment_id  uuid,
  resolution          text CHECK (resolution IN ('matched_by_retry', 'provider_confirmed_not_ours', 'provider_confirmed_failed', 'duplicate_of_settled', 'other_evidenced')),
  resolution_reason   text,
  resolution_evidence text,
  resolved_at         timestamptz,
  resolved_by         uuid REFERENCES public.users (id) ON DELETE SET NULL,
  reopened_count      integer NOT NULL DEFAULT 0,
  CONSTRAINT finance_unmatched_cases_resolved_chk CHECK (
    (status = 'resolved') = (resolved_at IS NOT NULL AND resolution IS NOT NULL AND resolution_reason IS NOT NULL))
);
CREATE INDEX finance_unmatched_cases_status_idx ON public.finance_unmatched_cases (status, first_seen_at);

CREATE TABLE public.finance_unmatched_case_notes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id    uuid NOT NULL REFERENCES public.finance_unmatched_cases (id) ON DELETE RESTRICT,
  author_id  uuid REFERENCES public.users (id) ON DELETE SET NULL,
  note       text NOT NULL CHECK (char_length(btrim(note)) BETWEEN 3 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX finance_unmatched_case_notes_case_idx ON public.finance_unmatched_case_notes (case_id, created_at);

ALTER TABLE public.finance_mpesa_unmatched_callbacks
  ADD COLUMN case_id uuid REFERENCES public.finance_unmatched_cases (id) ON DELETE RESTRICT,
  ADD COLUMN evidence_key text;
CREATE INDEX finance_mpesa_unmatched_case_idx ON public.finance_mpesa_unmatched_callbacks (case_id, received_at);

DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_unmatched_cases', 'finance_unmatched_case_notes'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR ALL TO PUBLIC
      USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))
      WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))$p$,
      t || '_owner', t, t, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, figbloom_app, figbloom_worker', t);
  END LOOP;
END
$rls$;

-- evidence fingerprint: only provider fields, never the callback body
CREATE FUNCTION public.finance_unmatched_evidence_key(p_merchant text, p_result integer, p_amount bigint, p_receipt text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp
AS $$ SELECT md5(coalesce(p_merchant, '') || '|' || coalesce(p_result::text, '') || '|' || coalesce(p_amount::text, '') || '|' || coalesce(p_receipt, '')) $$;
REVOKE ALL ON FUNCTION public.finance_unmatched_evidence_key(text, integer, bigint, text) FROM PUBLIC;

-- Backfill: one case per existing checkout id; every historical evidence row keeps its place.
UPDATE public.finance_mpesa_unmatched_callbacks e
   SET evidence_key = public.finance_unmatched_evidence_key(e.merchant_request_id, e.result_code, e.callback_amount_minor, e.receipt);
INSERT INTO public.finance_unmatched_cases (checkout_request_id, occurrences, first_seen_at, last_seen_at, contradictory)
SELECT e.checkout_request_id, count(*)::int, min(e.received_at), max(e.received_at), count(DISTINCT e.evidence_key) > 1
  FROM public.finance_mpesa_unmatched_callbacks e GROUP BY e.checkout_request_id;
UPDATE public.finance_mpesa_unmatched_callbacks e SET case_id = c.id
  FROM public.finance_unmatched_cases c WHERE c.checkout_request_id = e.checkout_request_id;
ALTER TABLE public.finance_mpesa_unmatched_callbacks ALTER COLUMN case_id SET NOT NULL, ALTER COLUMN evidence_key SET NOT NULL;

-- operator = super administrator (platform scope; a quarantined callback has no school)
CREATE FUNCTION public.finance_unmatched_require_operator() RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF public.app_current_user_id() IS NULL OR NOT public.account_actor_is_super() THEN
    RAISE EXCEPTION 'unmatched-callback cases are handled by platform operators' USING ERRCODE = '42501';
  END IF;
  RETURN public.app_current_user_id();
END
$$;
REVOKE ALL ON FUNCTION public.finance_unmatched_require_operator() FROM PUBLIC, figbloom_app, figbloom_worker;

-- writer used by the public callback route: distinct payloads are kept; repeats only count; contradictions reopen
CREATE OR REPLACE FUNCTION public.finance_mpesa_record_unmatched(
  p_checkout text, p_merchant text, p_result_code integer, p_amount_minor bigint, p_receipt text, p_msisdn_masked text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  c public.finance_unmatched_cases%ROWTYPE;
  v_key text := public.finance_unmatched_evidence_key(p_merchant, p_result_code, p_amount_minor, p_receipt);
BEGIN
  INSERT INTO public.finance_unmatched_cases (checkout_request_id) VALUES (p_checkout) ON CONFLICT (checkout_request_id) DO NOTHING;
  SELECT * INTO c FROM public.finance_unmatched_cases x WHERE x.checkout_request_id = p_checkout FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public.finance_mpesa_unmatched_callbacks e WHERE e.case_id = c.id AND e.evidence_key = v_key) THEN
    UPDATE public.finance_unmatched_cases SET occurrences = occurrences + 1, last_seen_at = now() WHERE id = c.id;
    RETURN; -- identical duplicate: counted, no new evidence, no reopen
  END IF;
  INSERT INTO public.finance_mpesa_unmatched_callbacks
    (checkout_request_id, merchant_request_id, result_code, callback_amount_minor, receipt, msisdn_masked, case_id, evidence_key)
  VALUES (p_checkout, p_merchant, p_result_code, p_amount_minor, p_receipt, p_msisdn_masked, c.id, v_key);
  -- the very first evidence of a fresh case is the case's own start; later DIFFERENT evidence is a contradiction/late update
  IF (SELECT count(*) FROM public.finance_mpesa_unmatched_callbacks e WHERE e.case_id = c.id) > 1 THEN
    IF c.status = 'resolved' THEN
      UPDATE public.finance_unmatched_cases
         SET status = 'open', contradictory = true, reopened_count = reopened_count + 1, last_seen_at = now(), occurrences = occurrences + 1,
             resolved_at = NULL, resolution = NULL, resolution_reason = NULL, resolution_evidence = NULL, resolved_by = NULL,
             escalated_at = NULL, last_evaluated_at = NULL
       WHERE id = c.id;
      INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
      VALUES (NULL, NULL, 'finance.unmatched.reopened',
              jsonb_build_object('caseId', c.id, 'priorStatus', 'resolved', 'priorResolution', c.resolution, 'newStatus', 'open', 'cause', 'new_distinct_provider_evidence'));
    ELSE
      UPDATE public.finance_unmatched_cases SET contradictory = true, last_seen_at = now(), occurrences = occurrences + 1 WHERE id = c.id;
    END IF;
  ELSE
    UPDATE public.finance_unmatched_cases SET last_seen_at = now() WHERE id = c.id;
  END IF;
END
$$;
REVOKE ALL ON FUNCTION public.finance_mpesa_record_unmatched(text, text, integer, bigint, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finance_mpesa_record_unmatched(text, text, integer, bigint, text, text) TO figbloom_app;

-- severity is derived, never stored: a provider SUCCESS (result 0) with no home may be money nobody attributed
CREATE FUNCTION public.finance_unmatched_severity(p_case uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ SELECT CASE WHEN EXISTS (SELECT 1 FROM public.finance_mpesa_unmatched_callbacks e WHERE e.case_id = p_case AND e.result_code = 0) THEN 'high' ELSE 'normal' END $$;
REVOKE ALL ON FUNCTION public.finance_unmatched_severity(uuid) FROM PUBLIC, figbloom_app, figbloom_worker;

CREATE FUNCTION public.finance_unmatched_list(p_status text, p_owner uuid, p_unassigned boolean, p_min_age_minutes integer, p_severity text, p_limit integer)
RETURNS TABLE (id uuid, checkout_request_id text, status text, severity text, occurrences integer, contradictory boolean, age_minutes integer,
               owner_user_id uuid, escalated boolean, retry_count integer, last_retry_at timestamptz, last_retry_outcome text, reopened_count integer,
               first_seen_at timestamptz, last_seen_at timestamptz, resolution text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  PERFORM public.finance_unmatched_require_operator();
  RETURN QUERY
    SELECT c.id, c.checkout_request_id, c.status, public.finance_unmatched_severity(c.id), c.occurrences, c.contradictory,
           (extract(epoch FROM (now() - c.first_seen_at)) / 60)::int, c.owner_user_id, c.escalated_at IS NOT NULL, c.retry_count, c.last_retry_at,
           c.last_retry_outcome, c.reopened_count, c.first_seen_at, c.last_seen_at, c.resolution
      FROM public.finance_unmatched_cases c
     WHERE (p_status IS NULL OR c.status = p_status)
       AND (p_owner IS NULL OR c.owner_user_id = p_owner)
       AND (NOT coalesce(p_unassigned, false) OR c.owner_user_id IS NULL)
       AND (p_min_age_minutes IS NULL OR c.first_seen_at <= now() - make_interval(mins => p_min_age_minutes))
       AND (p_severity IS NULL OR public.finance_unmatched_severity(c.id) = p_severity)
     ORDER BY (c.status = 'open') DESC, c.first_seen_at ASC LIMIT greatest(1, least(coalesce(p_limit, 50), 200));
END
$$;
REVOKE ALL ON FUNCTION public.finance_unmatched_list(text, uuid, boolean, integer, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finance_unmatched_list(text, uuid, boolean, integer, text, integer) TO figbloom_app;

-- inspect: provider fields only (masked phone), the case's notes, nothing else
CREATE FUNCTION public.finance_unmatched_get(p_case uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE c public.finance_unmatched_cases%ROWTYPE;
BEGIN
  PERFORM public.finance_unmatched_require_operator();
  SELECT * INTO c FROM public.finance_unmatched_cases WHERE id = p_case;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'case', jsonb_build_object('id', c.id, 'checkout_request_id', c.checkout_request_id, 'status', c.status, 'severity', public.finance_unmatched_severity(c.id),
      'occurrences', c.occurrences, 'contradictory', c.contradictory, 'age_minutes', (extract(epoch FROM (now() - c.first_seen_at)) / 60)::int,
      'owner_user_id', c.owner_user_id, 'assigned_at', c.assigned_at, 'escalated_at', c.escalated_at, 'last_evaluated_at', c.last_evaluated_at,
      'retry_count', c.retry_count, 'last_retry_at', c.last_retry_at, 'last_retry_outcome', c.last_retry_outcome, 'last_error_class', c.last_error_class,
      'matched_payment_id', c.matched_payment_id, 'resolution', c.resolution, 'resolution_reason', c.resolution_reason,
      'resolution_evidence', c.resolution_evidence, 'resolved_at', c.resolved_at, 'resolved_by', c.resolved_by, 'reopened_count', c.reopened_count,
      'first_seen_at', c.first_seen_at, 'last_seen_at', c.last_seen_at),
    'evidence', coalesce((SELECT jsonb_agg(jsonb_build_object('received_at', e.received_at, 'result_code', e.result_code, 'amount_minor', e.callback_amount_minor,
                                            'receipt', e.receipt, 'msisdn_masked', e.msisdn_masked, 'merchant_request_id', e.merchant_request_id) ORDER BY e.received_at)
                           FROM public.finance_mpesa_unmatched_callbacks e WHERE e.case_id = c.id), '[]'::jsonb),
    'notes', coalesce((SELECT jsonb_agg(jsonb_build_object('author_id', n.author_id, 'note', n.note, 'created_at', n.created_at) ORDER BY n.created_at)
                         FROM public.finance_unmatched_case_notes n WHERE n.case_id = c.id), '[]'::jsonb));
END
$$;
REVOKE ALL ON FUNCTION public.finance_unmatched_get(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finance_unmatched_get(uuid) TO figbloom_app;

CREATE FUNCTION public.finance_unmatched_assign(p_case uuid, p_owner uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_actor uuid; c public.finance_unmatched_cases%ROWTYPE;
BEGIN
  v_actor := public.finance_unmatched_require_operator();
  SELECT * INTO c FROM public.finance_unmatched_cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF c.status <> 'open' THEN RAISE EXCEPTION 'a resolved case cannot be reassigned' USING ERRCODE = '55000'; END IF;
  IF p_owner IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.platform_roles r JOIN public.users u ON u.id = r.user_id AND u.status = 'active' WHERE r.user_id = p_owner AND r.role = 'super_admin') THEN
    RAISE EXCEPTION 'the owner must be an active platform operator' USING ERRCODE = '22023';
  END IF;
  UPDATE public.finance_unmatched_cases SET owner_user_id = p_owner, assigned_at = CASE WHEN p_owner IS NULL THEN NULL ELSE now() END WHERE id = p_case;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, NULL, 'finance.unmatched.assigned', jsonb_build_object('caseId', p_case, 'priorOwner', c.owner_user_id, 'newOwner', p_owner));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.finance_unmatched_assign(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finance_unmatched_assign(uuid, uuid) TO figbloom_app;

CREATE FUNCTION public.finance_unmatched_add_note(p_case uuid, p_note text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_actor uuid;
BEGIN
  v_actor := public.finance_unmatched_require_operator();
  IF NOT EXISTS (SELECT 1 FROM public.finance_unmatched_cases WHERE id = p_case) THEN RETURN false; END IF;
  IF p_note IS NULL OR char_length(btrim(p_note)) < 3 OR char_length(p_note) > 1000 THEN RAISE EXCEPTION 'a note of 3-1000 characters is required' USING ERRCODE = '22023'; END IF;
  INSERT INTO public.finance_unmatched_case_notes (case_id, author_id, note) VALUES (p_case, v_actor, btrim(p_note));
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, NULL, 'finance.unmatched.noted', jsonb_build_object('caseId', p_case));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.finance_unmatched_add_note(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finance_unmatched_add_note(uuid, text) TO figbloom_app;

-- internal: try to home the case's evidence. Hands each DISTINCT stored payload to the payment as an ordinary callback_received event
-- (idempotent). It NEVER settles, fails or credits anything: the provider-confirmed paths still decide the money.
CREATE FUNCTION public.finance_unmatched_try_match(p_case uuid, p_actor uuid, p_auto boolean) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  c public.finance_unmatched_cases%ROWTYPE;
  p record;
  e record;
  v_handed integer := 0;
  v_outcome text;
BEGIN
  SELECT * INTO c FROM public.finance_unmatched_cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT fp.id, fp.tenant_id INTO p FROM public.finance_payments fp WHERE fp.checkout_request_id = c.checkout_request_id AND fp.method = 'mpesa' LIMIT 1;
  IF p.id IS NULL THEN
    UPDATE public.finance_unmatched_cases SET retry_count = retry_count + 1, last_retry_at = now(), last_retry_outcome = 'no_match', last_evaluated_at = now() WHERE id = p_case;
    v_outcome := 'no_match';
  ELSE
    FOR e IN SELECT * FROM public.finance_mpesa_unmatched_callbacks x WHERE x.case_id = p_case ORDER BY x.received_at LOOP
      IF NOT EXISTS (SELECT 1 FROM public.finance_mpesa_events ev WHERE ev.tenant_id = p.tenant_id AND ev.payment_id = p.id AND ev.checkout_request_id = e.checkout_request_id
                       AND ev.source = 'callback' AND ev.result_code IS NOT DISTINCT FROM e.result_code AND ev.callback_amount_minor IS NOT DISTINCT FROM e.callback_amount_minor
                       AND ev.receipt IS NOT DISTINCT FROM e.receipt) THEN
        INSERT INTO public.finance_mpesa_events (tenant_id, payment_id, checkout_request_id, source, result_code, callback_amount_minor, receipt, msisdn_masked, outcome, received_at)
        VALUES (p.tenant_id, p.id, e.checkout_request_id, 'callback', e.result_code, e.callback_amount_minor, e.receipt, e.msisdn_masked, 'callback_received', e.received_at);
        v_handed := v_handed + 1;
      END IF;
    END LOOP;
    v_outcome := CASE WHEN v_handed > 0 THEN 'matched_payment' ELSE 'already_handed' END;
    UPDATE public.finance_unmatched_cases
       SET retry_count = retry_count + 1, last_retry_at = now(), last_retry_outcome = v_outcome, last_evaluated_at = now(),
           matched_tenant_id = p.tenant_id, matched_payment_id = p.id,
           status = 'resolved', resolution = 'matched_by_retry', resolved_at = now(), resolved_by = p_actor,
           resolution_reason = 'The checkout id now belongs to a payment; stored provider evidence was handed to it. Settlement still requires provider confirmation.'
     WHERE id = p_case AND status = 'open';
  END IF;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (p_actor, p.tenant_id, 'finance.unmatched.retried',
          jsonb_build_object('caseId', p_case, 'outcome', v_outcome, 'automatic', p_auto, 'evidenceHanded', v_handed, 'paymentId', p.id, 'priorStatus', c.status));
  RETURN v_outcome;
END
$$;
REVOKE ALL ON FUNCTION public.finance_unmatched_try_match(uuid, uuid, boolean) FROM PUBLIC, figbloom_app, figbloom_worker;

CREATE FUNCTION public.finance_unmatched_retry(p_case uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_actor uuid;
BEGIN
  v_actor := public.finance_unmatched_require_operator();
  IF NOT EXISTS (SELECT 1 FROM public.finance_unmatched_cases WHERE id = p_case AND status = 'open') THEN
    IF EXISTS (SELECT 1 FROM public.finance_unmatched_cases WHERE id = p_case) THEN RAISE EXCEPTION 'only an open case can be retried' USING ERRCODE = '55000'; END IF;
    RETURN NULL;
  END IF;
  RETURN public.finance_unmatched_try_match(p_case, v_actor, false);
END
$$;
REVOKE ALL ON FUNCTION public.finance_unmatched_retry(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finance_unmatched_retry(uuid) TO figbloom_app;

CREATE FUNCTION public.finance_unmatched_escalate(p_case uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_actor uuid; n integer;
BEGIN
  v_actor := public.finance_unmatched_require_operator();
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 3 OR char_length(p_reason) > 500 THEN RAISE EXCEPTION 'a reason is required' USING ERRCODE = '22023'; END IF;
  UPDATE public.finance_unmatched_cases SET escalated_at = coalesce(escalated_at, now()) WHERE id = p_case AND status = 'open';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN RETURN false; END IF;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, NULL, 'finance.unmatched.escalated', jsonb_build_object('caseId', p_case, 'reason', btrim(p_reason), 'automatic', false));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.finance_unmatched_escalate(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finance_unmatched_escalate(uuid, text) TO figbloom_app;

-- operator resolution: reason AND supporting evidence are mandatory; it cannot claim the automatic match disposition; it moves no money
CREATE FUNCTION public.finance_unmatched_resolve(p_case uuid, p_resolution text, p_reason text, p_evidence text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_actor uuid; c public.finance_unmatched_cases%ROWTYPE;
BEGIN
  v_actor := public.finance_unmatched_require_operator();
  IF p_resolution NOT IN ('provider_confirmed_not_ours', 'provider_confirmed_failed', 'duplicate_of_settled', 'other_evidenced')
     OR p_reason IS NULL OR char_length(btrim(p_reason)) < 10 OR char_length(p_reason) > 500
     OR p_evidence IS NULL OR char_length(btrim(p_evidence)) < 10 OR char_length(p_evidence) > 1000 THEN
    RAISE EXCEPTION 'a disposition, a reason and supporting evidence are required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO c FROM public.finance_unmatched_cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF c.status <> 'open' THEN RAISE EXCEPTION 'the case is already resolved' USING ERRCODE = '55000'; END IF;
  -- a checkout id that now belongs to a payment must go through retry (evidence handover), never be declared "not ours"
  IF EXISTS (SELECT 1 FROM public.finance_payments fp WHERE fp.checkout_request_id = c.checkout_request_id AND fp.method = 'mpesa') THEN
    RAISE EXCEPTION 'the checkout id now matches a payment; retry matching instead' USING ERRCODE = '55000';
  END IF;
  UPDATE public.finance_unmatched_cases
     SET status = 'resolved', resolution = p_resolution, resolution_reason = btrim(p_reason), resolution_evidence = btrim(p_evidence), resolved_at = now(), resolved_by = v_actor
   WHERE id = p_case;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, NULL, 'finance.unmatched.resolved', jsonb_build_object('caseId', p_case, 'priorStatus', 'open', 'newStatus', 'resolved', 'resolution', p_resolution, 'reason', btrim(p_reason)));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.finance_unmatched_resolve(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finance_unmatched_resolve(uuid, text, text, text) TO figbloom_app;

CREATE FUNCTION public.finance_unmatched_reopen(p_case uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_actor uuid; c public.finance_unmatched_cases%ROWTYPE;
BEGIN
  v_actor := public.finance_unmatched_require_operator();
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 10 OR char_length(p_reason) > 500 THEN RAISE EXCEPTION 'a reason is required' USING ERRCODE = '22023'; END IF;
  SELECT * INTO c FROM public.finance_unmatched_cases WHERE id = p_case FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF c.status <> 'resolved' THEN RAISE EXCEPTION 'only a resolved case can be reopened' USING ERRCODE = '55000'; END IF;
  UPDATE public.finance_unmatched_cases
     SET status = 'open', reopened_count = reopened_count + 1, resolved_at = NULL, resolution = NULL, resolution_reason = NULL, resolution_evidence = NULL, resolved_by = NULL,
         escalated_at = NULL, last_evaluated_at = NULL
   WHERE id = p_case;
  INSERT INTO public.finance_unmatched_case_notes (case_id, author_id, note) VALUES (p_case, v_actor, 'Reopened: ' || btrim(p_reason));
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, NULL, 'finance.unmatched.reopened', jsonb_build_object('caseId', p_case, 'priorStatus', 'resolved', 'priorResolution', c.resolution, 'newStatus', 'open', 'cause', 'operator', 'reason', btrim(p_reason)));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.finance_unmatched_reopen(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finance_unmatched_reopen(uuid, text) TO figbloom_app;

-- worker sweep: re-evaluate open cases (retry matching) and escalate stale ones (24 h, or 4 h for a provider SUCCESS with no home).
CREATE FUNCTION public.finance_unmatched_sweep(p_worker text) RETURNS TABLE (evaluated integer, matched integer, escalated integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE c record; v_eval integer := 0; v_match integer := 0; v_esc integer := 0; v_out text; v_limit interval;
BEGIN
  IF session_user <> 'figbloom_worker' THEN RAISE EXCEPTION 'only the platform worker runs the unmatched-callback sweep' USING ERRCODE = '42501'; END IF;
  FOR c IN SELECT id, first_seen_at, escalated_at FROM public.finance_unmatched_cases WHERE status = 'open' ORDER BY first_seen_at LIMIT 500 LOOP
    v_out := public.finance_unmatched_try_match(c.id, NULL, true);
    v_eval := v_eval + 1;
    IF v_out IN ('matched_payment', 'already_handed') THEN v_match := v_match + 1; CONTINUE; END IF;
    IF public.finance_unmatched_severity(c.id) = 'high' THEN v_limit := interval '4 hours'; ELSE v_limit := interval '24 hours'; END IF;
    IF c.escalated_at IS NULL AND c.first_seen_at <= now() - v_limit THEN
      UPDATE public.finance_unmatched_cases SET escalated_at = now() WHERE id = c.id;
      INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
      VALUES (NULL, NULL, 'finance.unmatched.escalated', jsonb_build_object('caseId', c.id, 'automatic', true, 'worker', left(coalesce(p_worker, ''), 60)));
      v_esc := v_esc + 1;
    END IF;
  END LOOP;
  RETURN QUERY SELECT v_eval, v_match, v_esc;
END
$$;
REVOKE ALL ON FUNCTION public.finance_unmatched_sweep(text) FROM PUBLIC, figbloom_app;
GRANT EXECUTE ON FUNCTION public.finance_unmatched_sweep(text) TO figbloom_worker;

-- platform counters now come from cases (open count, escalated, unassigned, oldest age)
ALTER FUNCTION public.finance_ops_snapshot() RENAME TO finance_ops_snapshot_base;
REVOKE ALL ON FUNCTION public.finance_ops_snapshot_base() FROM PUBLIC, figbloom_app, figbloom_worker;
CREATE FUNCTION public.finance_ops_snapshot() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT public.finance_ops_snapshot_base() || jsonb_build_object('unmatched_cases', jsonb_build_object(
    'open', (SELECT count(*) FROM public.finance_unmatched_cases WHERE status = 'open'),
    'escalated_open', (SELECT count(*) FROM public.finance_unmatched_cases WHERE status = 'open' AND escalated_at IS NOT NULL),
    'unassigned_open', (SELECT count(*) FROM public.finance_unmatched_cases WHERE status = 'open' AND owner_user_id IS NULL),
    'oldest_open_age_seconds', (SELECT (extract(epoch FROM (now() - min(first_seen_at))))::bigint FROM public.finance_unmatched_cases WHERE status = 'open')));
$$;
REVOKE ALL ON FUNCTION public.finance_ops_snapshot() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finance_ops_snapshot() TO figbloom_app;
