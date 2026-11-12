-- FIG-1573 independent audit remediation (forward-only; 001 is untouched).
-- AUD-03 rate limiter, AUD-05 tenant integrity, AUD-08 append-only audit.

-- ---------------------------------------------------------------- AUD-03
-- Atomic token bucket. The row lock (SELECT ... FOR UPDATE) serialises every
-- API instance. Time comes from the database clock (clock_timestamp()), read
-- AFTER the lock is held, and elapsed time is clamped at zero so a waiter that
-- started before the previous holder committed can never be charged negative
-- refill (the former single-statement version used the transaction-start now()).
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

  INSERT INTO auth_rate_buckets (bucket_key, tokens, last_refill)
  VALUES (p_key, p_capacity, clock_timestamp())
  ON CONFLICT (bucket_key) DO NOTHING;

  SELECT b.tokens, b.last_refill INTO v_tokens, v_last
  FROM auth_rate_buckets b
  WHERE b.bucket_key = p_key
  FOR UPDATE;

  v_now := clock_timestamp();
  IF v_last > v_now THEN
    v_last := v_now; -- never trust a last_refill in the future
  END IF;

  v_steps := FLOOR(EXTRACT(EPOCH FROM (v_now - v_last)) * 1000 / p_interval_ms);
  IF v_steps > 0 THEN
    v_tokens := LEAST(p_capacity, v_tokens + v_steps * p_refill);
    v_last := v_last + (v_steps * p_interval_ms) * interval '1 millisecond';
  END IF;
  v_tokens := LEAST(v_tokens, p_capacity);
  IF v_tokens >= p_capacity THEN
    v_last := v_now; -- a full bucket accrues no partial interval
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

-- Idle buckets are harmless but unbounded; a scheduled job (Phase 2 runtime)
-- calls this. Buckets idle long enough to be full carry no information.
CREATE INDEX IF NOT EXISTS auth_rate_buckets_last_refill_idx ON auth_rate_buckets (last_refill);
CREATE OR REPLACE FUNCTION prune_rate_buckets(p_older_than interval) RETURNS bigint
LANGUAGE sql
AS $$
  WITH d AS (DELETE FROM auth_rate_buckets WHERE last_refill < now() - p_older_than RETURNING 1)
  SELECT count(*) FROM d;
$$;
REVOKE ALL ON FUNCTION prune_rate_buckets(interval) FROM PUBLIC;

-- ---------------------------------------------------------------- AUD-05
-- Tenant integrity at the database: a grant or a role assignment must belong
-- to a real membership of the same tenant, and a role may only be assigned
-- inside the tenant that owns it.
ALTER TABLE school_roles
  ADD CONSTRAINT school_roles_id_tenant_uniq UNIQUE (id, tenant_id);

ALTER TABLE school_role_assignments
  ADD CONSTRAINT school_role_assignments_role_tenant_fk
    FOREIGN KEY (role_id, tenant_id) REFERENCES school_roles (id, tenant_id) ON DELETE CASCADE,
  ADD CONSTRAINT school_role_assignments_membership_fk
    FOREIGN KEY (user_id, tenant_id) REFERENCES school_memberships (user_id, tenant_id) ON DELETE CASCADE;

ALTER TABLE staff_area_grants
  ADD CONSTRAINT staff_area_grants_membership_fk
    FOREIGN KEY (user_id, tenant_id) REFERENCES school_memberships (user_id, tenant_id) ON DELETE CASCADE;

-- ---------------------------------------------------------------- AUD-08
-- Audit events are append-only. The only permitted UPDATE is the foreign-key
-- ON DELETE SET NULL of actor_user_id / tenant_id (so deleting a user or school
-- is still possible); every other change and every DELETE is refused.
CREATE OR REPLACE FUNCTION security_audit_events_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND ROW(NEW.id, NEW.occurred_at, NEW.event_type, NEW.detail, NEW.ip)
         IS NOT DISTINCT FROM ROW(OLD.id, OLD.occurred_at, OLD.event_type, OLD.detail, OLD.ip)
     AND (NEW.actor_user_id IS NULL OR NEW.actor_user_id = OLD.actor_user_id)
     AND (NEW.tenant_id IS NULL OR NEW.tenant_id = OLD.tenant_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'security_audit_events is append-only' USING ERRCODE = '42501';
END;
$$;

CREATE TRIGGER security_audit_events_append_only
  BEFORE UPDATE OR DELETE ON security_audit_events
  FOR EACH ROW EXECUTE FUNCTION security_audit_events_guard();

-- ---------------------------------------------------------------- AUD-15
-- Legacy login IDs are PREFIX-<n padded to at least 4 digits> with an unbounded
-- per-role counter (packages/shared auth.ts padStart(4); next_login_number()),
-- so a large school legitimately reaches ST-10000. 001 allowed exactly 4 digits.
ALTER TABLE school_memberships DROP CONSTRAINT school_memberships_login_id_format;
ALTER TABLE school_memberships ADD CONSTRAINT school_memberships_login_id_format
  CHECK (login_id IS NULL OR login_id ~ '^[A-Z]{2}-[0-9]{4,9}$');
