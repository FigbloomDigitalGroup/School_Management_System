-- WP-A1 review remediation: R-02 (password hash overwrite), R-04 (idempotency housekeeping),
-- and the runtime-role attribute check behind the reported role-creation concern.
-- Forward-only. Migrations 001-012 are not edited.
--
-- R-02. Before this migration figbloom_app held column UPDATE on users.password_hash,
-- must_change_password and updated_at, and users has no RLS. Any SQL running as the
-- runtime role could therefore overwrite ANY account's hash (a super admin's included),
-- silently, with no audit row. After it:
--   * figbloom_app has NO UPDATE privilege of any kind on users (table or column).
--   * The only way to change a hash is public.auth_change_own_password(), which:
--       - takes a SESSION id, not a user id. The account is read from that session row, so
--         the caller cannot name a victim. The session must be unrevoked and unexpired and
--         its user active;
--       - is a compare-and-swap: it changes the hash only if the CURRENT hash equals the one
--         the caller proved it holds (the API verified the password against it), so a stale
--         or concurrent change fails instead of overwriting;
--       - accepts only a well-formed scrypt hash (never plaintext, never an arbitrary string);
--       - in the same transaction revokes the user's other sessions and writes the
--         auth.password.changed audit row, so a hash cannot change without a trace;
--       - returns false (and changes nothing) in every refusal case. No message reveals which.
--   Residual, documented: SQL running as figbloom_app can still INSERT a session for a known
--   user and read that one user's hash through auth_password_credential(), then call this
--   function for that user. That chain needs a known user id and leaves an audit row and a
--   revoked-sessions trail; it is the already-accepted "exact key" residual, no longer a
--   silent, bulk, arbitrary overwrite. The database does not defend against arbitrary SQL
--   as the runtime role (accepted model); it removes the direct write primitive.
--
-- Same hardening contract as migrations 010 and 011: SECURITY DEFINER, owned by the migrator,
-- search_path = pg_catalog, pg_temp, every object schema-qualified, EXECUTE only for figbloom_app.

CREATE FUNCTION public.auth_change_own_password(
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
  IF length(p_new_hash) > 512
     OR p_new_hash = p_expected_hash
     OR p_new_hash !~ '^scrypt\$[0-9]+\$[0-9]+\$[0-9]+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$' THEN
    RETURN false;
  END IF;

  -- The account comes from the session. Lock the user row so concurrent changes serialise.
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
  VALUES (
    v_user,
    v_tenant,
    'auth.password.changed',
    jsonb_build_object('revokedOtherSessions', true, 'keptSessionId', p_session_id),
    p_ip
  );

  RETURN true;
END
$$;

REVOKE ALL ON FUNCTION public.auth_change_own_password(uuid, text, text, inet) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_change_own_password(uuid, text, text, inet) TO figbloom_app;

-- Removes every UPDATE privilege on users, table-level and column-level (PostgreSQL revokes
-- the column privileges together with the table privilege).
REVOKE UPDATE ON TABLE public.users FROM figbloom_app;

-- ---------------------------------------------------------------------------
-- R-04. Owner-run housekeeping for idempotency_keys. Not granted to the runtime role (it
-- has no DELETE on the table). Correctness never depends on it: expired rows are ignored
-- at lookup and replaced by the claim. Run it from the migrator login, in batches:
--   SELECT public.prune_idempotency_keys(interval '0', 10000);   -- repeat until it returns 0
-- p_grace keeps rows for that long after expiry (useful for incident forensics).
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.prune_idempotency_keys(p_grace interval DEFAULT interval '0', p_batch integer DEFAULT 10000)
RETURNS bigint
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $$
  WITH d AS (
    DELETE FROM public.idempotency_keys
     WHERE ctid IN (
       SELECT k.ctid FROM public.idempotency_keys k
        WHERE k.expires_at <= now() - p_grace
        ORDER BY k.expires_at
        LIMIT greatest(p_batch, 1)
     )
    RETURNING 1
  )
  SELECT count(*) FROM d;
$$;
REVOKE ALL ON FUNCTION public.prune_idempotency_keys(interval, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.prune_idempotency_keys(interval, integer) FROM figbloom_app;

-- Deleting a user cascades to idempotency_keys by actor; the unique index leads with tenant_id,
-- so without this index each user delete scans the table.
CREATE INDEX idempotency_keys_actor_idx ON public.idempotency_keys (actor_user_id);

-- ---------------------------------------------------------------------------
-- Runtime role attributes are verified, not assumed. Migration 004 creates the role only
-- when it does not exist (CREATE ROLE defaults to NOLOGIN) and never checks a role that
-- already existed. This fails the migration, changing nothing, if the role carries any
-- privileged attribute. LOGIN is deliberately not asserted here: operations enable it out
-- of band for the API (docs/DB-ROLES.md) and assertRuntimeRole() checks the live role at
-- every start.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r pg_catalog.pg_roles%ROWTYPE;
BEGIN
  SELECT * INTO r FROM pg_catalog.pg_roles WHERE rolname = 'figbloom_app';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime role figbloom_app is missing';
  END IF;
  IF r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolinherit THEN
    RAISE EXCEPTION 'runtime role figbloom_app has a privileged attribute (superuser, bypassrls, createrole, createdb, replication or inherit)';
  END IF;
END
$$;
