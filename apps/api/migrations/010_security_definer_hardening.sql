-- Stage D / FIG-1611 / AD-13 — SECURITY DEFINER and helper-function hardening.
-- Forward-only. Migrations 001-009 are not edited.
--
-- Threat: a SECURITY DEFINER function runs with its owner's privileges. If it
-- resolves an unqualified table name through the CALLER's search_path, a caller
-- that can create a TEMP table of that name makes the owner-privileged function
-- read or write the caller's table instead of the real one. PostgreSQL searches
-- pg_temp FIRST for relations unless pg_temp is named explicitly, so
-- `SET search_path = public` (migration 004) is exploitable, and
-- `public, pg_temp` (migration 008) only works because the real table exists in
-- `public`. A forgotten qualification must fail loudly, not silently shadow.
--
-- Contract for every function in this file:
--   * SET search_path = pg_catalog, pg_temp   (pg_temp explicitly LAST; `public`
--     is deliberately absent, so any reference that is not schema-qualified
--     stops the function from working instead of being hijacked)
--   * every table, function and type reference outside pg_catalog is qualified
--   * owner = the migrator that owns the tables the function touches (asserted
--     by test/securityDefiner.test.ts; ownership is not changed here)
--   * EXECUTE revoked from PUBLIC; granted only to the roles that need it
--
-- Behaviour is unchanged: the same rules, the same SQLSTATEs, the same messages.

-- ---------------------------------------------------------------------------
-- SECURITY DEFINER trigger functions (004, 008)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.security_audit_events_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
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

CREATE OR REPLACE FUNCTION public.school_memberships_on_archive() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_areas text[];
  v_role_ids uuid[];
BEGIN
  IF NEW.archived_at IS NOT NULL
     AND (OLD.archived_at IS NULL OR OLD.archived_at IS DISTINCT FROM NEW.archived_at) THEN
    SELECT COALESCE(array_agg(g.area ORDER BY g.area), ARRAY[]::text[])
      INTO v_areas
      FROM public.staff_area_grants g
     WHERE g.user_id = NEW.user_id AND g.tenant_id = NEW.tenant_id;

    SELECT COALESCE(array_agg(a.role_id), ARRAY[]::uuid[])
      INTO v_role_ids
      FROM public.school_role_assignments a
     WHERE a.user_id = NEW.user_id AND a.tenant_id = NEW.tenant_id;

    DELETE FROM public.staff_area_grants g
     WHERE g.user_id = NEW.user_id AND g.tenant_id = NEW.tenant_id;
    DELETE FROM public.school_role_assignments a
     WHERE a.user_id = NEW.user_id AND a.tenant_id = NEW.tenant_id;

    INSERT INTO public.security_audit_events (event_type, actor_user_id, tenant_id, detail)
    VALUES (
      'membership.archived.authz_revoked',
      NEW.user_id,
      NEW.tenant_id,
      jsonb_build_object(
        'membershipId', NEW.id,
        'revokedAreas', to_jsonb(v_areas),
        'revokedRoleAssignmentIds', to_jsonb(v_role_ids),
        'note', 'Restoring membership does not restore these grants; explicit re-grant required'
      )
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guardian_links_active_learner_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_active boolean;
BEGIN
  SELECT l.active INTO v_active
  FROM public.learners l
  WHERE l.id = NEW.learner_id AND l.tenant_id = NEW.tenant_id
  FOR SHARE;

  IF NOT FOUND OR v_active IS NOT TRUE THEN
    -- SQLSTATE P0002: mapped to HTTP 404 by the API layer (see migration 008).
    RAISE EXCEPTION 'learner is not an active learner of this school'
      USING ERRCODE = 'P0002';
  END IF;
  RETURN NEW;
END;
$$;

-- Trigger functions are never called directly and need no EXECUTE for the role
-- that fires them (PostgreSQL checks EXECUTE when the trigger is created).
REVOKE ALL ON FUNCTION public.security_audit_events_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.security_audit_events_guard() FROM figbloom_app;
REVOKE ALL ON FUNCTION public.school_memberships_on_archive() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.school_memberships_on_archive() FROM figbloom_app;
REVOKE ALL ON FUNCTION public.guardian_links_active_learner_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guardian_links_active_learner_guard() FROM figbloom_app;

-- ---------------------------------------------------------------------------
-- Invoker helpers: same contract, for consistency and so a forgotten
-- qualification is never silently shadowed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.app_current_tenant_id() RETURNS uuid
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v text;
BEGIN
  v := current_setting('app.tenant_id', true);
  IF v IS NULL OR btrim(v) = '' THEN RETURN NULL; END IF;
  RETURN v::uuid;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.app_current_user_id() RETURNS uuid
LANGUAGE plpgsql STABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v text;
BEGIN
  v := current_setting('app.user_id', true);
  IF v IS NULL OR btrim(v) = '' THEN RETURN NULL; END IF;
  RETURN v::uuid;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END;
$$;

-- Only the runtime role evaluates the tenant/self policies (TO figbloom_app);
-- the owner policy does not call these. PUBLIC needs no EXECUTE.
REVOKE ALL ON FUNCTION public.app_current_tenant_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_current_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_current_tenant_id() TO figbloom_app;
GRANT EXECUTE ON FUNCTION public.app_current_user_id() TO figbloom_app;

CREATE OR REPLACE FUNCTION public.consume_rate_token(
  p_key text,
  p_cost numeric,
  p_capacity numeric,
  p_refill numeric,
  p_interval_ms integer
) RETURNS TABLE (out_allowed boolean, out_tokens numeric, out_retry_after_ms integer)
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
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

  INSERT INTO public.auth_rate_buckets (bucket_key, tokens, last_refill)
  VALUES (p_key, p_capacity, clock_timestamp())
  ON CONFLICT (bucket_key) DO NOTHING;

  SELECT b.tokens, b.last_refill INTO v_tokens, v_last
  FROM public.auth_rate_buckets b
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
    UPDATE public.auth_rate_buckets SET tokens = v_tokens, last_refill = v_last WHERE bucket_key = p_key;
    RETURN QUERY SELECT true, v_tokens, 0;
    RETURN;
  END IF;

  UPDATE public.auth_rate_buckets SET tokens = v_tokens, last_refill = v_last WHERE bucket_key = p_key;
  v_needed_steps := CEIL((p_cost - v_tokens) / p_refill);
  v_retry_ms := GREATEST(
    1,
    CEIL(EXTRACT(EPOCH FROM (v_last + (v_needed_steps * p_interval_ms) * interval '1 millisecond' - v_now)) * 1000)
  )::integer;
  RETURN QUERY SELECT false, v_tokens, v_retry_ms;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_rate_token(text, numeric, numeric, numeric, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.consume_rate_token(text, numeric, numeric, numeric, integer) TO figbloom_app;

CREATE OR REPLACE FUNCTION public.prune_rate_buckets(p_older_than interval) RETURNS bigint
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $$
  WITH d AS (DELETE FROM public.auth_rate_buckets WHERE last_refill < now() - p_older_than RETURNING 1)
  SELECT count(*) FROM d;
$$;
REVOKE ALL ON FUNCTION public.prune_rate_buckets(interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prune_rate_buckets(interval) FROM figbloom_app;

-- ---------------------------------------------------------------------------
-- Functions created later by the migrator must not be callable by PUBLIC by
-- default (PostgreSQL grants EXECUTE to PUBLIC on every new function). A new
-- function then needs an explicit GRANT, which the inventory test forces a
-- reviewer to see. This applies to the role running this migration.
-- ---------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
