-- Residual closure (2026-11-21). Forward-only.
--
-- 1. Worker housekeeping. The pruning functions of migrations 002/013/015 existed but nothing ever called them, and the tables for
--    account tokens and guardian invitations (072/073) had no retention at all. `worker_housekeeping()` is the ONE bounded,
--    non-overlapping, failure-isolated entry point the worker calls from its maintenance cycle. It removes only records that are
--    expired or terminal AND past a retention window, in batches of at most 1000 per operation, and never touches money,
--    reconciliation, audit or job rows:
--      * idempotency keys expired more than 1 day ago           (replay protection no longer possible or needed)
--      * rate-limit buckets idle for more than 1 day            (a bucket that old has fully refilled; absence is identical)
--      * session proof nonces already consumed and expired      (existing purge function, 1 hour grace)
--      * account tokens whose terminal moment (used, revoked or expiry) is more than 30 days old (they carry e-mail addresses)
--      * guardian invitations: pending past expiry are first marked 'expired'; expired/revoked/superseded ones closed more than
--        90 days ago are deleted. ACCEPTED invitations are kept: guardian_accounts references them (RESTRICT) and they are the
--        provenance of a live link.
--    Audit history (security_audit_events) is never pruned here. Every operation runs in its own sub-transaction, so one failing
--    operation is recorded and does not skip the others. A transaction-scoped advisory lock makes concurrent runs skip, not queue.
--    Status (when, outcome, failed operation names, counts) is stored on worker_heartbeats and surfaced by finance_ops_snapshot().
-- 2. M-9: the operator-reconciliation permission is re-checked INSIDE the settlement transaction (finance_assert_administer_actor):
--    the actor's live membership, account status and the school's status are read with row locks (FOR SHARE) in the same
--    transaction that settles, so a revocation either committed before (refused) or must wait until the settlement commits.

ALTER TABLE public.worker_heartbeats
  ADD COLUMN last_maintenance_at timestamptz,
  ADD COLUMN last_maintenance_outcome text CHECK (last_maintenance_outcome IN ('ok', 'partial', 'failed', 'skipped')),
  ADD COLUMN last_maintenance_detail jsonb;

CREATE FUNCTION public.worker_housekeeping(p_worker text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  c_batch constant integer := 1000;
  v_counts jsonb := '{}'::jsonb;
  v_failed text[] := ARRAY[]::text[];
  v_n bigint;
  v_total bigint := 0;
  v_outcome text;
BEGIN
  IF session_user IS DISTINCT FROM 'figbloom_worker' THEN
    RAISE EXCEPTION 'worker_housekeeping is executable only as figbloom_worker' USING ERRCODE = '42501';
  END IF;
  IF p_worker IS NULL OR char_length(p_worker) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'worker name required' USING ERRCODE = '22023';
  END IF;
  -- a second concurrent run skips instead of queueing (the lock is released when this transaction ends)
  IF NOT pg_try_advisory_xact_lock(hashtext('figbloom.worker_housekeeping')) THEN
    INSERT INTO public.worker_heartbeats (worker_name, last_seen_at, last_maintenance_at, last_maintenance_outcome, last_maintenance_detail)
    VALUES (p_worker, now(), now(), 'skipped', jsonb_build_object('reason', 'overlap'))
    ON CONFLICT (worker_name) DO UPDATE SET last_maintenance_at = now(), last_maintenance_outcome = 'skipped', last_maintenance_detail = jsonb_build_object('reason', 'overlap');
    RETURN jsonb_build_object('skipped', 'overlap');
  END IF;

  BEGIN
    DELETE FROM public.idempotency_keys WHERE ctid IN (
      SELECT k.ctid FROM public.idempotency_keys k WHERE k.expires_at <= now() - interval '1 day' ORDER BY k.expires_at LIMIT c_batch);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('idempotency_keys', v_n); v_total := v_total + v_n;
  EXCEPTION WHEN OTHERS THEN v_failed := v_failed || 'idempotency_keys'::text;
  END;

  BEGIN
    DELETE FROM public.auth_rate_buckets WHERE bucket_key IN (
      SELECT b.bucket_key FROM public.auth_rate_buckets b WHERE b.last_refill < now() - interval '1 day' ORDER BY b.last_refill LIMIT c_batch);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('rate_buckets', v_n); v_total := v_total + v_n;
  EXCEPTION WHEN OTHERS THEN v_failed := v_failed || 'rate_buckets'::text;
  END;

  BEGIN
    v_n := public.auth_purge_session_proof_nonces(c_batch);
    v_counts := v_counts || jsonb_build_object('proof_nonces', v_n); v_total := v_total + v_n;
  EXCEPTION WHEN OTHERS THEN v_failed := v_failed || 'proof_nonces'::text;
  END;

  BEGIN
    DELETE FROM public.account_tokens WHERE id IN (
      SELECT t.id FROM public.account_tokens t
       WHERE coalesce(t.used_at, t.revoked_at, t.expires_at) < now() - interval '30 days'
       ORDER BY coalesce(t.used_at, t.revoked_at, t.expires_at) LIMIT c_batch);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('account_tokens', v_n); v_total := v_total + v_n;
  EXCEPTION WHEN OTHERS THEN v_failed := v_failed || 'account_tokens'::text;
  END;

  BEGIN
    UPDATE public.guardian_invitations SET status = 'expired', closed_at = now()
     WHERE id IN (SELECT i.id FROM public.guardian_invitations i WHERE i.status = 'pending' AND i.expires_at <= now() ORDER BY i.expires_at LIMIT c_batch);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('guardian_invitations_expired', v_n); v_total := v_total + v_n;
    DELETE FROM public.guardian_invitations WHERE id IN (
      SELECT i.id FROM public.guardian_invitations i
       WHERE i.status IN ('expired', 'revoked', 'superseded') AND i.closed_at < now() - interval '90 days'
         AND NOT EXISTS (SELECT 1 FROM public.guardian_accounts a WHERE a.invitation_id = i.id)
       ORDER BY i.closed_at LIMIT c_batch);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('guardian_invitations_deleted', v_n); v_total := v_total + v_n;
  EXCEPTION WHEN OTHERS THEN v_failed := v_failed || 'guardian_invitations'::text;
  END;

  v_outcome := CASE WHEN cardinality(v_failed) = 0 THEN 'ok' WHEN cardinality(v_failed) < 5 THEN 'partial' ELSE 'failed' END;
  v_counts := v_counts || jsonb_build_object('failed', to_jsonb(v_failed));
  INSERT INTO public.worker_heartbeats (worker_name, last_seen_at, last_maintenance_at, last_maintenance_outcome, last_maintenance_detail)
  VALUES (p_worker, now(), now(), v_outcome, v_counts)
  ON CONFLICT (worker_name) DO UPDATE SET last_maintenance_at = now(), last_maintenance_outcome = v_outcome, last_maintenance_detail = v_counts;
  -- the audit trail records a run only when it changed something or failed (no row per idle cycle)
  IF v_total > 0 OR cardinality(v_failed) > 0 THEN
    INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
    VALUES (NULL, NULL, 'worker.housekeeping.run', jsonb_build_object('worker', left(p_worker, 60), 'outcome', v_outcome, 'counts', v_counts));
  END IF;
  RETURN v_counts || jsonb_build_object('outcome', v_outcome);
END
$$;
REVOKE ALL ON FUNCTION public.worker_housekeeping(text) FROM PUBLIC, figbloom_app;
GRANT EXECUTE ON FUNCTION public.worker_housekeeping(text) TO figbloom_worker;

-- surface maintenance status per worker (ages and outcomes only; no payloads)
CREATE OR REPLACE FUNCTION public.finance_ops_snapshot() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT public.finance_ops_snapshot_base() || jsonb_build_object(
    'unmatched_cases', jsonb_build_object(
      'open', (SELECT count(*) FROM public.finance_unmatched_cases WHERE status = 'open'),
      'escalated_open', (SELECT count(*) FROM public.finance_unmatched_cases WHERE status = 'open' AND escalated_at IS NOT NULL),
      'unassigned_open', (SELECT count(*) FROM public.finance_unmatched_cases WHERE status = 'open' AND owner_user_id IS NULL),
      'oldest_open_age_seconds', (SELECT (extract(epoch FROM (now() - min(first_seen_at))))::bigint FROM public.finance_unmatched_cases WHERE status = 'open')),
    'maintenance', coalesce((SELECT jsonb_agg(jsonb_build_object('worker', w.worker_name,
                    'last_maintenance_age_seconds', extract(epoch FROM now() - w.last_maintenance_at)::bigint,
                    'outcome', w.last_maintenance_outcome,
                    'failed', coalesce(w.last_maintenance_detail -> 'failed', '[]'::jsonb)))
                  FROM public.worker_heartbeats w WHERE w.last_maintenance_at IS NOT NULL), '[]'::jsonb));
$$;

-- M-9: authorization re-checked inside the settlement transaction ---------------------------------------------------------------
-- resource.finance.administer is held only by a school administrator of THIS school or a platform super administrator (see
-- authorize.ts: it is not implied by any admin area and not delegable). The check reads the live state with row locks.
CREATE FUNCTION public.finance_assert_administer_actor(p_tenant uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
  v_ok boolean := false;
BEGIN
  IF v_actor IS NULL OR p_tenant IS DISTINCT FROM public.app_current_tenant_id() THEN
    RAISE EXCEPTION 'actor or school context missing' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.users u WHERE u.id = v_actor AND u.status = 'active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'the acting account is no longer active' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM public.tenants t WHERE t.id = p_tenant AND t.status <> 'suspended' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'the school is not active' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM public.platform_roles r WHERE r.user_id = v_actor AND r.role = 'super_admin') THEN
    v_ok := true;
  ELSE
    PERFORM 1 FROM public.school_memberships m
     WHERE m.user_id = v_actor AND m.tenant_id = p_tenant AND m.role = 'school_admin' AND m.archived_at IS NULL FOR SHARE;
    v_ok := FOUND;
  END IF;
  IF NOT v_ok THEN RAISE EXCEPTION 'the acting person no longer holds resource.finance.administer' USING ERRCODE = '42501'; END IF;
END
$$;
REVOKE ALL ON FUNCTION public.finance_assert_administer_actor(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.finance_assert_administer_actor(uuid) TO figbloom_app;
