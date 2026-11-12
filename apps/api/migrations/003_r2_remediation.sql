-- FIG-1573 Session-2 remediation (R2-08): rate-limit edge cases + EXECUTE grants.
-- Forward-only; 001/002 untouched.

-- When cost exceeds capacity the request can never succeed; return a NULL
-- retry_after so the API does not advertise a short wait that cannot help.
CREATE OR REPLACE FUNCTION consume_rate_token(
  p_key text,
  p_cost numeric,
  p_capacity numeric,
  p_refill numeric,
  p_interval_ms integer
) RETURNS TABLE (out_allowed boolean, out_tokens numeric, out_retry_after_ms integer)
LANGUAGE plpgsql
AS $$
DECLARE
  v_now timestamptz;
  v_tokens numeric;
  v_last timestamptz;
  v_steps numeric;
  v_needed_steps numeric;
  v_retry_ms integer;
BEGIN
  IF p_key IS NULL OR p_cost IS NULL OR p_cost <= 0 OR p_capacity <= 0
     OR p_refill <= 0 OR p_interval_ms <= 0 THEN
    RAISE EXCEPTION 'invalid rate limit parameters';
  END IF;

  -- Impossible cost: do not mutate the bucket; no Retry-After hint.
  IF p_cost > p_capacity THEN
    RETURN QUERY SELECT false, 0::numeric, NULL::integer;
    RETURN;
  END IF;

  INSERT INTO auth_rate_buckets (bucket_key, tokens, last_refill)
  VALUES (p_key, p_capacity, clock_timestamp())
  ON CONFLICT (bucket_key) DO NOTHING;

  SELECT b.tokens, b.last_refill INTO v_tokens, v_last
  FROM auth_rate_buckets b
  WHERE b.bucket_key = p_key
  FOR UPDATE;

  v_now := clock_timestamp();
  IF v_last > v_now THEN
    v_last := v_now;
  END IF;

  v_steps := FLOOR(EXTRACT(EPOCH FROM (v_now - v_last)) * 1000 / p_interval_ms);
  IF v_steps > 0 THEN
    v_tokens := LEAST(p_capacity, v_tokens + v_steps * p_refill);
    v_last := v_last + (v_steps * p_interval_ms) * interval '1 millisecond';
  END IF;
  v_tokens := LEAST(v_tokens, p_capacity);
  IF v_tokens >= p_capacity THEN
    v_last := v_now;
  END IF;

  IF v_tokens >= p_cost THEN
    v_tokens := v_tokens - p_cost;
    UPDATE auth_rate_buckets SET tokens = v_tokens, last_refill = v_last WHERE bucket_key = p_key;
    RETURN QUERY SELECT true, v_tokens, 0;
    RETURN;
  END IF;

  UPDATE auth_rate_buckets SET tokens = v_tokens, last_refill = v_last WHERE bucket_key = p_key;
  v_needed_steps := CEIL((p_cost - v_tokens) / p_refill);
  v_retry_ms := GREATEST(
    1,
    CEIL(EXTRACT(EPOCH FROM (v_last + (v_needed_steps * p_interval_ms) * interval '1 millisecond' - v_now)) * 1000)
  )::integer;
  RETURN QUERY SELECT false, v_tokens, v_retry_ms;
END;
$$;

REVOKE ALL ON FUNCTION consume_rate_token(text, numeric, numeric, numeric, integer) FROM PUBLIC;
-- Application role needs EXECUTE. Local/dev typically connects as the migration
-- owner; grant to PUBLIC is avoided. Grant to the current DB user (migration runner)
-- and document that production app roles must receive the same grant (R2-08).
GRANT EXECUTE ON FUNCTION consume_rate_token(text, numeric, numeric, numeric, integer) TO CURRENT_USER;
GRANT EXECUTE ON FUNCTION prune_rate_buckets(interval) TO CURRENT_USER;

-- R2-06 / AUD-07: archiving a membership must clear grants and role assignments
-- so a grant that committed just before archive cannot remain effective.
CREATE OR REPLACE FUNCTION school_memberships_on_archive() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.archived_at IS NOT NULL
     AND (OLD.archived_at IS NULL OR OLD.archived_at IS DISTINCT FROM NEW.archived_at) THEN
    DELETE FROM staff_area_grants
     WHERE user_id = NEW.user_id AND tenant_id = NEW.tenant_id;
    DELETE FROM school_role_assignments
     WHERE user_id = NEW.user_id AND tenant_id = NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS school_memberships_archive_clears_authz ON school_memberships;
CREATE TRIGGER school_memberships_archive_clears_authz
  AFTER UPDATE OF archived_at ON school_memberships
  FOR EACH ROW EXECUTE FUNCTION school_memberships_on_archive();
