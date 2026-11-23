-- Acceptance programme: Argon2id for new password hashes with lazy migration. Forward-only.
--   * users.password_hash may now hold either the legacy scrypt format or an Argon2id PHC string
--     ($argon2id$v=19$m=..,t=..,p=..$salt$hash). Existing scrypt hashes stay verifiable; nothing is rewritten here.
--   * auth_change_own_password (013) now accepts either well-formed format for the NEW hash.
--   * auth_rehash_password(user, expected_hash, new_hash): the ONLY write path used by login-time migration. It is a
--     compare-and-swap on the exact hash the caller just verified, accepts only an Argon2id string (never a downgrade,
--     never plaintext), leaves sessions and must_change_password alone, and writes an audit row without hash material.
--     Concurrent logins therefore cannot corrupt or downgrade a hash: the loser's CAS simply changes nothing.

CREATE FUNCTION public.auth_hash_format_ok(p_hash text) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_hash IS NOT NULL AND length(p_hash) <= 512 AND (
    p_hash ~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$'
    OR p_hash ~ '^\$argon2id\$v=19\$m=[0-9]{4,6},t=[0-9]{1,2},p=[0-9]{1,2}\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$'
  );
$$;
REVOKE ALL ON FUNCTION public.auth_hash_format_ok(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_hash_format_ok(text) TO figbloom_app;

CREATE OR REPLACE FUNCTION public.auth_change_own_password(
  p_session_id uuid,
  p_expected_hash text,
  p_new_hash text,
  p_ip inet
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user uuid;
  v_tenant uuid;
BEGIN
  IF p_session_id IS NULL OR p_expected_hash IS NULL OR p_new_hash IS NULL THEN
    RETURN false;
  END IF;
  IF p_new_hash = p_expected_hash OR NOT public.auth_hash_format_ok(p_new_hash) THEN
    RETURN false;
  END IF;
  SELECT s.user_id, s.active_tenant_id
    INTO v_user, v_tenant
    FROM public.sessions s
    JOIN public.users u ON u.id = s.user_id
   WHERE s.id = p_session_id
     AND s.revoked_at IS NULL
     AND s.expires_at > now()
     AND u.status = 'active'
     FOR UPDATE OF u;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE public.users u
     SET password_hash = p_new_hash,
         must_change_password = false,
         updated_at = now()
   WHERE u.id = v_user
     AND u.password_hash = p_expected_hash;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  UPDATE public.sessions s
     SET revoked_at = now()
   WHERE s.user_id = v_user
     AND s.revoked_at IS NULL
     AND s.id <> p_session_id;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail, ip)
  VALUES (v_user, v_tenant, 'auth.password.changed',
          jsonb_build_object('revokedOtherSessions', true, 'keptSessionId', p_session_id), p_ip);
  RETURN true;
END
$$;

CREATE FUNCTION public.auth_rehash_password(p_user_id uuid, p_expected_hash text, p_new_hash text) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_user_id IS NULL OR p_expected_hash IS NULL OR p_new_hash IS NULL
     OR p_new_hash = p_expected_hash
     OR p_new_hash NOT LIKE '$argon2id$%'
     OR NOT public.auth_hash_format_ok(p_new_hash) THEN
    RETURN false;
  END IF;
  UPDATE public.users u
     SET password_hash = p_new_hash, updated_at = now()
   WHERE u.id = p_user_id AND u.status = 'active' AND u.password_hash = p_expected_hash;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (p_user_id, NULL, 'auth.password.rehashed',
          jsonb_build_object('from', CASE WHEN p_expected_hash LIKE 'scrypt$%' THEN 'scrypt' ELSE 'argon2id' END, 'to', 'argon2id'));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.auth_rehash_password(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_rehash_password(uuid, text, text) TO figbloom_app;
