-- Stage D / F-C1 / F-C2 — narrow access to credentials.
-- Forward-only. Migrations 001-010 are not edited.
--
-- Before: figbloom_app held table-level SELECT and UPDATE on users, so any SQL
-- running as the runtime role could `SELECT password_hash FROM users` for every
-- account. Login by login id additionally opened a transaction with the REQUEST
-- tenant UUID as app.tenant_id so the membership tenant policy could see every
-- non-archived membership of that school while one statement filtered by login id.
--
-- After:
--   * figbloom_app has NO privilege on users.password_hash except UPDATE
--     (password change). It cannot read the column with any statement.
--   * The hash is reachable only through three SECURITY DEFINER functions that
--     take an exact key and return at most the rows for that key:
--        auth_credential_by_email(email)
--        auth_credential_by_login_id(tenant, login_id)
--        auth_password_credential(user_id)
--     They return (user id, hash, status) and nothing else. There is no way to
--     enumerate accounts or dump hashes through them.
--   * Login by login id no longer sets any tenant context: the function joins
--     school_memberships as the table owner, so the request tenant is just an
--     argument (not an authorisation claim, not a scoping GUC). The membership
--     "scoping key" window of Stage C is eliminated, not merely accepted.
--
-- Residual (documented, accepted): arbitrary SQL executing as figbloom_app could
-- still call these functions with a KNOWN email, login id plus tenant, or user
-- id and obtain that one account's hash. That is the same capability the login
-- endpoint already gives an attacker for a guess, and it removes bulk
-- exfiltration. The hash is a scrypt hash, never returned by any API.
--
-- Same hardening contract as migration 010: pg_catalog, pg_temp search_path,
-- schema-qualified references, migrator-owned, EXECUTE only for figbloom_app.

CREATE FUNCTION public.auth_credential_by_email(p_email text)
RETURNS TABLE (user_id uuid, password_hash text, status text)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u.id, u.password_hash, u.status
    FROM public.users u
   WHERE u.email = p_email
$$;

CREATE FUNCTION public.auth_credential_by_login_id(p_tenant_id uuid, p_login_id text)
RETURNS TABLE (user_id uuid, password_hash text, status text)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT m.user_id, u.password_hash, u.status
    FROM public.school_memberships m
    JOIN public.users u ON u.id = m.user_id
   WHERE m.tenant_id = p_tenant_id
     AND lower(m.login_id) = lower(p_login_id)
     AND m.archived_at IS NULL
$$;

CREATE FUNCTION public.auth_password_credential(p_user_id uuid)
RETURNS TABLE (password_hash text, status text)
LANGUAGE sql STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT u.password_hash, u.status
    FROM public.users u
   WHERE u.id = p_user_id
$$;

REVOKE ALL ON FUNCTION public.auth_credential_by_email(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_credential_by_login_id(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_password_credential(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_credential_by_email(text) TO figbloom_app;
GRANT EXECUTE ON FUNCTION public.auth_credential_by_login_id(uuid, text) TO figbloom_app;
GRANT EXECUTE ON FUNCTION public.auth_password_credential(uuid) TO figbloom_app;

-- Column-level privileges. A table-level SELECT cannot be narrowed by a column
-- REVOKE, so the table-level privilege is removed and the non-secret columns are
-- granted by name. A column added to users later is NOT readable by the runtime
-- role until a migration grants it (fail closed).
REVOKE SELECT, UPDATE ON TABLE public.users FROM figbloom_app;
GRANT SELECT (id, email, full_name, phone, status, must_change_password, created_at, updated_at)
  ON TABLE public.users TO figbloom_app;
GRANT UPDATE (password_hash, must_change_password, updated_at)
  ON TABLE public.users TO figbloom_app;
