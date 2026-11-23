-- Post-remediation audit (N-8): import preview PII lifecycle. Forward-only; 001–066 are historical.
--
-- 062 redacted preview_json only AFTER a successful apply; a preview that was never applied kept raw learner
-- PII (names, dates of birth, admission numbers) forever. A previewed batch now has an expiry:
--   * expires_at defaults to created_at + 7 days and can never be set beyond 30 days (CHECK);
--   * status 'expired' is terminal: its preview_json is replaced by counts only, and it can never be applied;
--   * import_batches_expire_due() (worker-only, cross-tenant by design like jobs_claim) redacts due batches one
--     row at a time under FOR UPDATE SKIP LOCKED, so a concurrent apply (which holds the row lock) always wins and
--     the sweeper never touches another tenant's data beyond redacting that row's own preview;
--   * each redaction is audited by the function itself (job-style, actingVia worker); the audit trail is retained.
-- The 7-day default is an engineering default, NOT a legal retention period: owner decision OD-RET-1.

ALTER TABLE public.import_batches ADD COLUMN expires_at timestamptz;
UPDATE public.import_batches SET expires_at = created_at + interval '7 days' WHERE status = 'previewed' AND expires_at IS NULL;
ALTER TABLE public.import_batches ALTER COLUMN expires_at SET DEFAULT (now() + interval '7 days');
ALTER TABLE public.import_batches DROP CONSTRAINT import_batches_status_chk;
ALTER TABLE public.import_batches ADD CONSTRAINT import_batches_status_chk CHECK (status IN ('previewed', 'applied', 'cancelled', 'expired'));
ALTER TABLE public.import_batches ADD CONSTRAINT import_batches_expiry_chk CHECK (
  (status <> 'previewed' OR expires_at IS NOT NULL)
  AND (expires_at IS NULL OR expires_at <= created_at + interval '30 days')
);
CREATE INDEX import_batches_expiry_idx ON public.import_batches (expires_at) WHERE status = 'previewed';

CREATE FUNCTION public.import_batches_expire_due(p_limit integer DEFAULT 200) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_n integer;
BEGIN
  IF session_user IS DISTINCT FROM 'figbloom_worker' THEN
    RAISE EXCEPTION 'import_batches_expire_due is executable only as figbloom_worker' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'limit must be 1..1000' USING ERRCODE = '22023';
  END IF;
  WITH due AS (
    SELECT b.id FROM public.import_batches b
     WHERE b.status = 'previewed' AND b.expires_at <= now()
     ORDER BY b.expires_at, b.id
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  ), done AS (
    UPDATE public.import_batches b
       SET status = 'expired',
           preview_json = jsonb_build_object(
             'redacted', true, 'redacted_at', now(), 'reason', 'expired',
             'row_count', b.row_count, 'valid_count', b.valid_count, 'error_count', b.error_count)
      FROM due
     WHERE b.id = due.id AND b.status = 'previewed'
    RETURNING b.id, b.tenant_id, b.payload_sha256, b.row_count, b.valid_count, b.error_count
  ), ev AS (
    INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
    SELECT NULL, d.tenant_id, 'import.learners.preview_expired',
           jsonb_build_object('importId', d.id, 'payloadSha256', d.payload_sha256, 'rowCount', d.row_count,
                              'validCount', d.valid_count, 'errorCount', d.error_count, 'actingVia', 'worker')
      FROM done d
    RETURNING 1
  )
  SELECT count(*) INTO v_n FROM done;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.import_batches_expire_due(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.import_batches_expire_due(integer) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.import_batches_expire_due(integer) TO figbloom_worker;
