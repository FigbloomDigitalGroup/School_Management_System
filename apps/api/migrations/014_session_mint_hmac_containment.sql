-- WP-A1 OD-1 / R-02 containment: HMAC-proof SECURITY DEFINER session writes.
-- Forward-only. Migrations 001-013 are not edited.
--
-- Before: figbloom_app held INSERT+UPDATE on sessions. Any SQL running as the
-- runtime role could mint a session for any user (including super admin), then
-- call auth_password_credential / auth_change_own_password for that account.
-- After:
--   * figbloom_app has SELECT only on sessions (validation reads).
--   * INSERT/UPDATE go only through SECURITY DEFINER functions that require a
--     short-lived HMAC proof keyed by an owner-only secret the SQL-injection
--     attacker does not have.
--   * Proofs bind principal, optional tenant, nonce (no replay), and issued_at
--     (short expiry). Audit rows name the initiating actor from the proof.
-- Residual (documented): full application-process compromise still wins (the
-- process holds the HMAC key). This mitigates SQL-injection-level abuse of the
-- runtime role, not total process takeover.
--
-- Hardening contract (same as 010/011/013): SECURITY DEFINER, migrator owner,
-- search_path = pg_catalog, pg_temp, schema-qualified names, EXECUTE only for
-- figbloom_app (or none), REVOKE FROM PUBLIC.

-- ---------------------------------------------------------------------------
-- Owner-only secret + nonce store (no grants to figbloom_app)
-- ---------------------------------------------------------------------------
CREATE TABLE public.auth_session_hmac_secrets (
  key_id text PRIMARY KEY,
  secret text NOT NULL CHECK (char_length(secret) >= 32 AND char_length(secret) <= 256),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE public.auth_session_proof_nonces (
  nonce text PRIMARY KEY CHECK (char_length(nonce) >= 16 AND char_length(nonce) <= 128),
  purpose text NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX auth_session_proof_nonces_expires_idx
  ON public.auth_session_proof_nonces (expires_at);

REVOKE ALL ON TABLE public.auth_session_hmac_secrets FROM PUBLIC;
REVOKE ALL ON TABLE public.auth_session_proof_nonces FROM PUBLIC;
DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON TABLE public.auth_session_hmac_secrets FROM figbloom_app';
  EXECUTE 'REVOKE ALL ON TABLE public.auth_session_proof_nonces FROM figbloom_app';
EXCEPTION WHEN undefined_object THEN
  NULL;
END
$$;

ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS minted_by text
    CHECK (minted_by IS NULL OR minted_by IN ('login', 'refresh')),
  ADD COLUMN IF NOT EXISTS minted_actor_user_id uuid REFERENCES public.users (id);

-- Install / rotate the HMAC secret. Callable only by the migrator/owner (no
-- EXECUTE grant to figbloom_app or PUBLIC).
CREATE FUNCTION public.auth_install_session_hmac_secret(
  p_key_id text,
  p_secret text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_key_id IS NULL OR p_secret IS NULL
     OR char_length(p_key_id) < 1 OR char_length(p_key_id) > 64
     OR char_length(p_secret) < 32 OR char_length(p_secret) > 256 THEN
    RAISE EXCEPTION 'invalid session hmac secret';
  END IF;
  UPDATE public.auth_session_hmac_secrets
     SET revoked_at = now()
   WHERE revoked_at IS NULL
     AND key_id <> p_key_id;
  INSERT INTO public.auth_session_hmac_secrets (key_id, secret)
  VALUES (p_key_id, p_secret)
  ON CONFLICT (key_id) DO UPDATE
    SET secret = EXCLUDED.secret,
        created_at = now(),
        revoked_at = NULL;
END
$$;

REVOKE ALL ON FUNCTION public.auth_install_session_hmac_secret(text, text) FROM PUBLIC;

-- Resolve pgcrypto hmac into a schema-qualified helper (Supabase: extensions; vanilla: public).
DO $$
DECLARE
  sch text;
BEGIN
  SELECT n.nspname INTO sch
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.proname = 'hmac'
     AND pg_get_function_identity_arguments(p.oid) IN ('bytea, bytea, text', 'text, text, text')
   ORDER BY CASE n.nspname WHEN 'extensions' THEN 0 WHEN 'public' THEN 1 ELSE 2 END,
            CASE pg_get_function_identity_arguments(p.oid) WHEN 'bytea, bytea, text' THEN 0 ELSE 1 END
   LIMIT 1;
  IF sch IS NULL THEN
    RAISE EXCEPTION 'pgcrypto hmac not found (create extension pgcrypto)';
  END IF;
  EXECUTE format($f$
    CREATE OR REPLACE FUNCTION public.auth_hmac_sha256_hex(p_data bytea, p_key bytea)
    RETURNS text
    LANGUAGE sql
    IMMUTABLE
    STRICT
    SET search_path = pg_catalog, pg_temp
    AS $fn$ SELECT encode(%I.hmac($1, $2, 'sha256'), 'hex') $fn$
  $f$, sch);
END
$$;

REVOKE ALL ON FUNCTION public.auth_hmac_sha256_hex(bytea, bytea) FROM PUBLIC;

-- Constant-time hex compare (equal length assumed by caller after length check).
CREATE FUNCTION public.auth_hmac_hex_equals(p_a text, p_b text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_len int;
  v_diff int := 0;
  i int;
BEGIN
  IF p_a IS NULL OR p_b IS NULL THEN
    RETURN false;
  END IF;
  v_len := char_length(p_a);
  IF v_len <> char_length(p_b) OR v_len = 0 THEN
    RETURN false;
  END IF;
  FOR i IN 1..v_len LOOP
    v_diff := v_diff | (ascii(substr(p_a, i, 1)) # ascii(substr(p_b, i, 1)));
  END LOOP;
  RETURN v_diff = 0;
END
$$;

REVOKE ALL ON FUNCTION public.auth_hmac_hex_equals(text, text) FROM PUBLIC;

CREATE FUNCTION public.auth_active_session_hmac_secret()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_secret text;
BEGIN
  SELECT s.secret INTO v_secret
    FROM public.auth_session_hmac_secrets s
   WHERE s.revoked_at IS NULL
   ORDER BY s.created_at DESC
   LIMIT 1;
  RETURN v_secret;
END
$$;

REVOKE ALL ON FUNCTION public.auth_active_session_hmac_secret() FROM PUBLIC;

CREATE FUNCTION public.auth_consume_session_proof(
  p_purpose text,
  p_payload text,
  p_mac text,
  p_issued_at timestamptz,
  p_nonce text,
  p_max_age interval DEFAULT interval '60 seconds'
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_secret text;
  v_expected text;
BEGIN
  IF p_purpose IS NULL OR p_payload IS NULL OR p_mac IS NULL
     OR p_issued_at IS NULL OR p_nonce IS NULL THEN
    RETURN false;
  END IF;
  IF p_issued_at > now() + interval '5 seconds' THEN
    RETURN false;
  END IF;
  IF p_issued_at < now() - p_max_age THEN
    RETURN false;
  END IF;
  IF char_length(p_nonce) < 16 OR char_length(p_nonce) > 128 THEN
    RETURN false;
  END IF;
  IF char_length(p_mac) <> 64 OR p_mac !~ '^[0-9a-f]{64}$' THEN
    RETURN false;
  END IF;

  v_secret := public.auth_active_session_hmac_secret();
  IF v_secret IS NULL THEN
    RETURN false;
  END IF;

  v_expected := public.auth_hmac_sha256_hex(
    convert_to(p_payload, 'UTF8'),
    convert_to(v_secret, 'UTF8')
  );
  IF NOT public.auth_hmac_hex_equals(v_expected, lower(p_mac)) THEN
    RETURN false;
  END IF;

  BEGIN
    INSERT INTO public.auth_session_proof_nonces (nonce, purpose, expires_at)
    VALUES (p_nonce, p_purpose, now() + interval '1 day');
  EXCEPTION WHEN unique_violation THEN
    RETURN false; -- replay
  END;

  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION public.auth_consume_session_proof(text, text, text, timestamptz, text, interval) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Session write path
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.auth_mint_session(
  p_user_id uuid,
  p_token_hash text,
  p_expires_at timestamptz,
  p_active_tenant_id uuid,
  p_active_organization_id uuid,
  p_user_agent text,
  p_ip inet,
  p_minted_by text,
  p_actor_user_id uuid,
  p_issued_at timestamptz,
  p_nonce text,
  p_mac text
) RETURNS TABLE (
  id uuid,
  user_id uuid,
  active_tenant_id uuid,
  active_organization_id uuid,
  expires_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_payload text;
  v_tenant_ok boolean := false;
BEGIN
  IF p_user_id IS NULL OR p_token_hash IS NULL OR p_expires_at IS NULL
     OR p_minted_by IS NULL OR p_actor_user_id IS NULL
     OR p_minted_by NOT IN ('login', 'refresh')
     OR char_length(p_token_hash) < 32 OR char_length(p_token_hash) > 128 THEN
    RETURN;
  END IF;

  -- Principal must exist and be active; actor must equal principal for mint
  -- (login/refresh always mint for the authenticated account).
  IF p_actor_user_id <> p_user_id THEN
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users u
     WHERE u.id = p_user_id AND u.status = 'active'
  ) THEN
    RETURN;
  END IF;

  IF p_active_tenant_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.school_memberships m
       WHERE m.user_id = p_user_id
         AND m.tenant_id = p_active_tenant_id
         AND m.archived_at IS NULL
      UNION ALL
      SELECT 1
        FROM public.platform_roles pr
       WHERE pr.user_id = p_user_id AND pr.role = 'super_admin'
      UNION ALL
      SELECT 1
        FROM public.organization_memberships om
        JOIN public.tenants t ON t.organization_id = om.organization_id
       WHERE om.user_id = p_user_id AND t.id = p_active_tenant_id
    ) INTO v_tenant_ok;
    IF NOT v_tenant_ok THEN
      RETURN;
    END IF;
  END IF;

  v_payload := concat_ws(
    '|',
    'v1',
    'mint',
    p_user_id::text,
    p_token_hash,
    to_char(p_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    to_char(p_issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    p_nonce,
    p_minted_by,
    p_actor_user_id::text,
    COALESCE(p_active_tenant_id::text, '-'),
    COALESCE(p_active_organization_id::text, '-')
  );

  IF NOT public.auth_consume_session_proof('mint', v_payload, p_mac, p_issued_at, p_nonce) THEN
    RETURN;
  END IF;

  RETURN QUERY
  INSERT INTO public.sessions (
    user_id, token_hash, active_tenant_id, active_organization_id,
    expires_at, user_agent, ip, minted_by, minted_actor_user_id
  ) VALUES (
    p_user_id, p_token_hash, p_active_tenant_id, p_active_organization_id,
    p_expires_at, p_user_agent, p_ip, p_minted_by, p_actor_user_id
  )
  RETURNING
    sessions.id,
    sessions.user_id,
    sessions.active_tenant_id,
    sessions.active_organization_id,
    sessions.expires_at,
    sessions.revoked_at;

  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail, ip)
  VALUES (
    p_actor_user_id,
    p_active_tenant_id,
    'auth.session.minted',
    jsonb_build_object(
      'mintedBy', p_minted_by,
      'ipClientSupplied', true,
      'userId', p_user_id
    ),
    p_ip
  );
END
$$;

REVOKE ALL ON FUNCTION public.auth_mint_session(
  uuid, text, timestamptz, uuid, uuid, text, inet, text, uuid, timestamptz, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_mint_session(
  uuid, text, timestamptz, uuid, uuid, text, inet, text, uuid, timestamptz, text, text
) TO figbloom_app;

CREATE FUNCTION public.auth_touch_session(
  p_token_hash text,
  p_interval_seconds double precision
) RETURNS TABLE (
  id uuid,
  user_id uuid,
  active_tenant_id uuid,
  active_organization_id uuid,
  expires_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_token_hash IS NULL OR char_length(p_token_hash) < 32 THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH valid AS (
    SELECT s.id, s.user_id, s.active_tenant_id, s.active_organization_id, s.expires_at, s.revoked_at
      FROM public.sessions s
     WHERE s.token_hash = p_token_hash
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
  ), touched AS (
    UPDATE public.sessions s
       SET last_seen_at = now()
      FROM valid v
     WHERE s.id = v.id
       AND s.last_seen_at <= now() - make_interval(secs => COALESCE(p_interval_seconds, 0)::double precision)
    RETURNING s.id
  )
  SELECT v.id, v.user_id, v.active_tenant_id, v.active_organization_id, v.expires_at, v.revoked_at
    FROM valid v;
END
$$;

REVOKE ALL ON FUNCTION public.auth_touch_session(text, double precision) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_touch_session(text, double precision) TO figbloom_app;

CREATE FUNCTION public.auth_revoke_session(
  p_session_id uuid,
  p_actor_user_id uuid,
  p_issued_at timestamptz,
  p_nonce text,
  p_mac text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_payload text;
  v_owner uuid;
BEGIN
  IF p_session_id IS NULL OR p_actor_user_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT s.user_id INTO v_owner
    FROM public.sessions s
   WHERE s.id = p_session_id;
  IF NOT FOUND OR v_owner <> p_actor_user_id THEN
    RETURN false;
  END IF;

  v_payload := concat_ws(
    '|',
    'v1',
    'revoke',
    p_session_id::text,
    to_char(p_issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    p_nonce,
    p_actor_user_id::text
  );

  IF NOT public.auth_consume_session_proof('revoke', v_payload, p_mac, p_issued_at, p_nonce) THEN
    RETURN false;
  END IF;

  UPDATE public.sessions s
     SET revoked_at = now()
   WHERE s.id = p_session_id
     AND s.revoked_at IS NULL;
  RETURN FOUND;
END
$$;

REVOKE ALL ON FUNCTION public.auth_revoke_session(uuid, uuid, timestamptz, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_revoke_session(uuid, uuid, timestamptz, text, text) TO figbloom_app;

CREATE FUNCTION public.auth_revoke_all_user_sessions(
  p_user_id uuid,
  p_actor_user_id uuid,
  p_keep_session_id uuid,
  p_issued_at timestamptz,
  p_nonce text,
  p_mac text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_payload text;
  v_count integer;
BEGIN
  IF p_user_id IS NULL OR p_actor_user_id IS NULL OR p_actor_user_id <> p_user_id THEN
    RETURN 0;
  END IF;

  v_payload := concat_ws(
    '|',
    'v1',
    'revoke_all',
    p_user_id::text,
    COALESCE(p_keep_session_id::text, '-'),
    to_char(p_issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    p_nonce,
    p_actor_user_id::text
  );

  IF NOT public.auth_consume_session_proof('revoke_all', v_payload, p_mac, p_issued_at, p_nonce) THEN
    RETURN 0;
  END IF;

  UPDATE public.sessions s
     SET revoked_at = now()
   WHERE s.user_id = p_user_id
     AND s.revoked_at IS NULL
     AND (p_keep_session_id IS NULL OR s.id <> p_keep_session_id);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;

REVOKE ALL ON FUNCTION public.auth_revoke_all_user_sessions(uuid, uuid, uuid, timestamptz, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_revoke_all_user_sessions(uuid, uuid, uuid, timestamptz, text, text) TO figbloom_app;

CREATE FUNCTION public.auth_set_session_tenant(
  p_session_id uuid,
  p_tenant_id uuid,
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_issued_at timestamptz,
  p_nonce text,
  p_mac text
) RETURNS TABLE (
  id uuid,
  user_id uuid,
  active_tenant_id uuid,
  active_organization_id uuid,
  expires_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_payload text;
  v_owner uuid;
BEGIN
  IF p_session_id IS NULL OR p_tenant_id IS NULL OR p_organization_id IS NULL
     OR p_actor_user_id IS NULL THEN
    RETURN;
  END IF;

  SELECT s.user_id INTO v_owner
    FROM public.sessions s
   WHERE s.id = p_session_id
     AND s.revoked_at IS NULL
     AND s.expires_at > now();
  IF NOT FOUND OR v_owner <> p_actor_user_id THEN
    RETURN;
  END IF;

  v_payload := concat_ws(
    '|',
    'v1',
    'set_tenant',
    p_session_id::text,
    p_tenant_id::text,
    p_organization_id::text,
    to_char(p_issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    p_nonce,
    p_actor_user_id::text
  );

  IF NOT public.auth_consume_session_proof('set_tenant', v_payload, p_mac, p_issued_at, p_nonce) THEN
    RETURN;
  END IF;

  RETURN QUERY
  UPDATE public.sessions s
     SET active_tenant_id = p_tenant_id,
         active_organization_id = p_organization_id,
         last_seen_at = now()
   WHERE s.id = p_session_id
  RETURNING
    s.id, s.user_id, s.active_tenant_id, s.active_organization_id, s.expires_at, s.revoked_at;
END
$$;

REVOKE ALL ON FUNCTION public.auth_set_session_tenant(
  uuid, uuid, uuid, uuid, timestamptz, text, text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_set_session_tenant(
  uuid, uuid, uuid, uuid, timestamptz, text, text
) TO figbloom_app;

-- Runtime role: SELECT only. All writes are through the definers above.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.sessions FROM figbloom_app;
GRANT SELECT ON TABLE public.sessions TO figbloom_app;
