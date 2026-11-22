-- WS-8: MFA TOTP enrollment, challenge, and recovery codes (D-6).
-- Forward-only. Preserves all migrations 001–084.

ALTER TABLE sessions
  ADD COLUMN mfa_verified_at timestamptz;

CREATE TABLE mfa_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'totp',
  secret_encrypted text NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CONSTRAINT mfa_factors_kind_chk CHECK (kind = 'totp')
);

CREATE UNIQUE INDEX mfa_factors_active_user_uidx
  ON mfa_factors (user_id)
  WHERE disabled_at IS NULL;

ALTER TABLE mfa_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_factors FORCE ROW LEVEL SECURITY;

CREATE POLICY mfa_factors_own ON mfa_factors
  FOR ALL TO figbloom_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

CREATE POLICY mfa_factors_owner ON mfa_factors
  FOR ALL TO PUBLIC
  USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'mfa_factors'
  ))
  WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'mfa_factors'
  ));

GRANT SELECT, INSERT ON mfa_factors TO figbloom_app;
GRANT UPDATE (verified_at, disabled_at) ON mfa_factors TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON mfa_factors FROM figbloom_app;

CREATE TABLE mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX mfa_recovery_codes_user_idx
  ON mfa_recovery_codes (user_id)
  WHERE used_at IS NULL;

ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE mfa_recovery_codes FORCE ROW LEVEL SECURITY;

CREATE POLICY mfa_recovery_codes_own ON mfa_recovery_codes
  FOR ALL TO figbloom_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());

CREATE POLICY mfa_recovery_codes_owner ON mfa_recovery_codes
  FOR ALL TO PUBLIC
  USING (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'mfa_recovery_codes'
  ))
  WITH CHECK (current_user = (
    SELECT pg_get_userbyid(c.relowner) FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'mfa_recovery_codes'
  ));

GRANT SELECT, INSERT ON mfa_recovery_codes TO figbloom_app;
GRANT UPDATE (used_at) ON mfa_recovery_codes TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON mfa_recovery_codes FROM figbloom_app;

CREATE FUNCTION public.auth_stamp_session_mfa(p_session_id uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user uuid := public.app_current_user_id();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'auth_stamp_session_mfa requires app.user_id' USING ERRCODE = '42501';
  END IF;
  UPDATE public.sessions
     SET mfa_verified_at = now()
   WHERE id = p_session_id
     AND user_id = v_user
     AND revoked_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.auth_stamp_session_mfa(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_stamp_session_mfa(uuid) TO figbloom_app;
