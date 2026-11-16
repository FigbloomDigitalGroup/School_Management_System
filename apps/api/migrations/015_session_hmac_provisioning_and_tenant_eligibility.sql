-- WP-A1 final remediation. Forward-only; 001-014 are not edited.
--
--  1. Safe HMAC secret provisioning (no silent rotation), an owner-run rotation
--     with an overlap window (two active keys), and a readiness self-test that
--     reports ok / mismatch / no_secret without exposing key material.
--  2. Bounded, owner-run housekeeping for auth_session_proof_nonces.
--  3. auth_set_session_tenant re-checks tenant eligibility inside the database
--     (parity with the application's selectTenant rules) and derives the
--     organisation from the tenant instead of trusting the proof.
--
-- Hardening contract (same as 010/011/013/014): SECURITY DEFINER where the
-- runtime role may call it, migrator owner, search_path = pg_catalog, pg_temp,
-- schema-qualified names, REVOKE FROM PUBLIC, EXECUTE only where stated.
--
-- Session impact of key changes: sessions are validated by token hash only
-- (auth_touch_session); the HMAC protects mint / revoke / set-tenant proofs.
-- Provisioning, rotation and retirement therefore never invalidate an existing
-- session. They only decide which API instances can create new proofs.

-- ---------------------------------------------------------------------------
-- 1a. Constant-time verification against every ACTIVE key (at most two)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.auth_session_hmac_matches(p_payload text, p_mac text)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_secret text;
  v_ok boolean := false;
BEGIN
  IF p_payload IS NULL OR p_mac IS NULL THEN
    RETURN false;
  END IF;
  -- No early exit: every active key is compared so timing does not reveal which matched.
  FOR v_secret IN
    SELECT s.secret
      FROM public.auth_session_hmac_secrets s
     WHERE s.revoked_at IS NULL
     ORDER BY s.created_at DESC, s.key_id
     LIMIT 2
  LOOP
    IF public.auth_hmac_hex_equals(
         public.auth_hmac_sha256_hex(convert_to(p_payload, 'UTF8'), convert_to(v_secret, 'UTF8')),
         p_mac
       ) THEN
      v_ok := true;
    END IF;
  END LOOP;
  RETURN v_ok;
END
$$;

REVOKE ALL ON FUNCTION public.auth_session_hmac_matches(text, text) FROM PUBLIC;

-- Same signature and ACL as 014; now accepts a proof signed by any active key.
CREATE OR REPLACE FUNCTION public.auth_consume_session_proof(
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
  IF NOT public.auth_session_hmac_matches(p_payload, p_mac) THEN
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
-- 1b. Provisioning: never silently rotates. Idempotent for the same key.
--     Replaces the 014 function, which revoked every other key. Owner only.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.auth_install_session_hmac_secret(
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
  LOCK TABLE public.auth_session_hmac_secrets IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (
    SELECT 1 FROM public.auth_session_hmac_secrets s
     WHERE s.key_id = p_key_id AND s.secret = p_secret AND s.revoked_at IS NULL
  ) THEN
    RETURN; -- already provisioned with this exact key: nothing to do
  END IF;
  IF EXISTS (SELECT 1 FROM public.auth_session_hmac_secrets s WHERE s.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'session hmac secret already provisioned; use rotate';
  END IF;
  IF EXISTS (SELECT 1 FROM public.auth_session_hmac_secrets s WHERE s.key_id = p_key_id) THEN
    RAISE EXCEPTION 'session hmac key id already used';
  END IF;
  INSERT INTO public.auth_session_hmac_secrets (key_id, secret) VALUES (p_key_id, p_secret);
END
$$;

REVOKE ALL ON FUNCTION public.auth_install_session_hmac_secret(text, text) FROM PUBLIC;

-- Rotation step 1: add a second active key. Both verify until the old one is retired.
CREATE FUNCTION public.auth_rotate_session_hmac_secret(
  p_new_key_id text,
  p_new_secret text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_active integer;
BEGIN
  IF p_new_key_id IS NULL OR p_new_secret IS NULL
     OR char_length(p_new_key_id) < 1 OR char_length(p_new_key_id) > 64
     OR char_length(p_new_secret) < 32 OR char_length(p_new_secret) > 256 THEN
    RAISE EXCEPTION 'invalid session hmac secret';
  END IF;
  LOCK TABLE public.auth_session_hmac_secrets IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) INTO v_active FROM public.auth_session_hmac_secrets s WHERE s.revoked_at IS NULL;
  IF v_active <> 1 THEN
    RAISE EXCEPTION 'rotation requires exactly one active session hmac secret';
  END IF;
  IF EXISTS (SELECT 1 FROM public.auth_session_hmac_secrets s WHERE s.key_id = p_new_key_id) THEN
    RAISE EXCEPTION 'session hmac key id already used';
  END IF;
  INSERT INTO public.auth_session_hmac_secrets (key_id, secret) VALUES (p_new_key_id, p_new_secret);
END
$$;

REVOKE ALL ON FUNCTION public.auth_rotate_session_hmac_secret(text, text) FROM PUBLIC;

-- Rotation step 2 (after every API instance holds the new key): retire the old one.
CREATE FUNCTION public.auth_retire_session_hmac_secret(p_key_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_active integer;
BEGIN
  IF p_key_id IS NULL THEN
    RAISE EXCEPTION 'invalid session hmac key id';
  END IF;
  LOCK TABLE public.auth_session_hmac_secrets IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) INTO v_active FROM public.auth_session_hmac_secrets s WHERE s.revoked_at IS NULL;
  IF v_active < 2 THEN
    RAISE EXCEPTION 'cannot retire the only active session hmac secret';
  END IF;
  UPDATE public.auth_session_hmac_secrets s
     SET revoked_at = now()
   WHERE s.key_id = p_key_id AND s.revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown or already retired session hmac key id';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.auth_retire_session_hmac_secret(text) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 1c. Readiness self-test. The API signs `v1|selftest|<nonce>` with its key; the
--     database answers ok / mismatch / no_secret / invalid. It only ever verifies
--     the selftest payload shape (not a general verification oracle), consumes
--     nothing and returns no key material.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.auth_session_hmac_status(p_nonce text, p_mac text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.auth_session_hmac_secrets s WHERE s.revoked_at IS NULL) THEN
    RETURN 'no_secret';
  END IF;
  IF p_nonce IS NULL OR p_mac IS NULL
     OR char_length(p_nonce) < 16 OR char_length(p_nonce) > 128
     OR p_mac !~ '^[0-9a-f]{64}$' THEN
    RETURN 'invalid';
  END IF;
  IF public.auth_session_hmac_matches('v1|selftest|' || p_nonce, p_mac) THEN
    RETURN 'ok';
  END IF;
  RETURN 'mismatch';
END
$$;

REVOKE ALL ON FUNCTION public.auth_session_hmac_status(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_session_hmac_status(text, text) TO figbloom_app;

-- ---------------------------------------------------------------------------
-- 2. Nonce housekeeping. Owner-run (same model as idempotency_keys cleanup).
--    A proof is accepted only within 60 s of issued_at (+5 s skew), and a nonce
--    row lives one day from consumption. Rows are removed only when BOTH the
--    stored expiry has passed AND the row is more than an hour old, so a nonce is
--    never removed while its proof could still be accepted. Bounded batches use
--    SKIP LOCKED so a purge never blocks or is blocked by concurrent minting.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.auth_purge_session_proof_nonces(p_batch integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 10000 THEN
    RAISE EXCEPTION 'batch must be between 1 and 10000';
  END IF;
  WITH doomed AS (
    SELECT n.nonce
      FROM public.auth_session_proof_nonces n
     WHERE n.expires_at < now()
       AND n.consumed_at < now() - interval '1 hour'
     ORDER BY n.expires_at
     LIMIT p_batch
       FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.auth_session_proof_nonces n
   USING doomed d
   WHERE n.nonce = d.nonce;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END
$$;

REVOKE ALL ON FUNCTION public.auth_purge_session_proof_nonces(integer) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 3. Tenant eligibility inside the database security boundary.
--    Rules mirror the application's selectTenant (src/modules/auth/service.ts):
--      * the user is active and the tenant exists;
--      * platform super_admin may select any tenant, including a suspended one;
--      * everyone else needs an unarchived school membership OR an organisation
--        membership on an ACTIVE organisation that owns the tenant, and the
--        tenant must not be suspended.
--    Owner-only helper; the runtime role cannot call it directly.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.auth_session_tenant_eligible(p_user_id uuid, p_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.tenants t
      JOIN public.users u ON u.id = p_user_id AND u.status = 'active'
     WHERE t.id = p_tenant_id
       AND (
         EXISTS (
           SELECT 1 FROM public.platform_roles pr
            WHERE pr.user_id = p_user_id AND pr.role = 'super_admin'
         )
         OR (
           t.status <> 'suspended'
           AND (
             EXISTS (
               SELECT 1 FROM public.school_memberships m
                WHERE m.user_id = p_user_id AND m.tenant_id = t.id AND m.archived_at IS NULL
             )
             OR EXISTS (
               SELECT 1
                 FROM public.organization_memberships om
                 JOIN public.organizations o ON o.id = om.organization_id AND o.status = 'active'
                WHERE om.user_id = p_user_id AND om.organization_id = t.organization_id
             )
           )
         )
       )
  )
$$;

REVOKE ALL ON FUNCTION public.auth_session_tenant_eligible(uuid, uuid) FROM PUBLIC;

-- Same signature, OUT columns and ACL as 014. A valid proof is still required first;
-- an ineligible tenant then raises 42501 (rolls the whole transaction back).
CREATE OR REPLACE FUNCTION public.auth_set_session_tenant(
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
  v_org uuid;
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

  -- Authoritative eligibility: never trust the tenant or organisation in the proof.
  IF NOT public.auth_session_tenant_eligible(v_owner, p_tenant_id) THEN
    RAISE EXCEPTION 'tenant not eligible for this session' USING ERRCODE = '42501';
  END IF;
  SELECT t.organization_id INTO v_org FROM public.tenants t WHERE t.id = p_tenant_id;
  IF v_org IS DISTINCT FROM p_organization_id THEN
    RAISE EXCEPTION 'tenant not eligible for this session' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  UPDATE public.sessions s
     SET active_tenant_id = p_tenant_id,
         active_organization_id = v_org,
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
