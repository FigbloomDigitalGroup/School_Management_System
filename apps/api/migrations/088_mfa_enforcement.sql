-- 088: server-enforced MFA. Forward-only; 001-087 untouched.
--  * auth_mfa_state(): one identity-level decision per request: is MFA required for this user, is the session assured,
--    is a verified factor enrolled. "Required" = platform administrators, organisation administrators, school administrators,
--    anyone holding the Fees (finance) area directly or through a school role, plus roles named in MFA_REQUIRED_ROLES.
--  * persisted wrong-code counters (committed outside the failing transaction by the application),
--  * lost-device reset by an authorised administrator (audited), self-service assurance clearing on disable,
--  * secret re-encryption under the dedicated MFA key.

ALTER TABLE mfa_factors
  ADD COLUMN failed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN failed_window_start timestamptz;
GRANT UPDATE (failed_count, failed_window_start, secret_encrypted) ON mfa_factors TO figbloom_app;

CREATE FUNCTION public.auth_mfa_state(p_session uuid, p_user uuid, p_extra_roles text[])
RETURNS TABLE (required boolean, assured boolean, enrolled boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT
    (   EXISTS (SELECT 1 FROM public.platform_roles r WHERE r.user_id = p_user)
     OR EXISTS (SELECT 1 FROM public.organization_memberships o WHERE o.user_id = p_user)
     OR EXISTS (SELECT 1 FROM public.school_memberships m
                 WHERE m.user_id = p_user AND m.archived_at IS NULL
                   AND (m.role = 'school_admin' OR m.role = ANY (COALESCE(p_extra_roles, ARRAY[]::text[]))))
     OR EXISTS (SELECT 1 FROM public.staff_area_grants g
                  JOIN public.school_memberships m ON m.user_id = g.user_id AND m.tenant_id = g.tenant_id AND m.archived_at IS NULL
                 WHERE g.user_id = p_user AND g.area = 'fees')
     OR EXISTS (SELECT 1 FROM public.school_role_assignments a
                  JOIN public.school_roles sr ON sr.id = a.role_id
                  JOIN public.school_memberships m ON m.user_id = a.user_id AND m.tenant_id = a.tenant_id AND m.archived_at IS NULL
                 WHERE a.user_id = p_user AND 'fees' = ANY (sr.areas))
    ) AS required,
    EXISTS (SELECT 1 FROM public.sessions s
             WHERE s.id = p_session AND s.user_id = p_user AND s.revoked_at IS NULL AND s.mfa_verified_at IS NOT NULL) AS assured,
    EXISTS (SELECT 1 FROM public.mfa_factors f
             WHERE f.user_id = p_user AND f.disabled_at IS NULL AND f.verified_at IS NOT NULL) AS enrolled
$$;

-- The caller drops the MFA assurance of all of their own sessions (used when the factor is disabled or replaced).
CREATE FUNCTION public.mfa_clear_own_assurance() RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_user uuid := public.app_current_user_id(); v_n integer;
BEGIN
  IF v_user IS NULL THEN RAISE EXCEPTION 'mfa_clear_own_assurance requires app.user_id' USING ERRCODE = '42501'; END IF;
  UPDATE public.sessions SET mfa_verified_at = NULL WHERE user_id = v_user AND mfa_verified_at IS NOT NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;

-- Lost-device reset. Platform super administrators may reset anyone but themselves. A school administrator may reset
-- a member of a school they administer, never another school administrator, organisation or platform administrator.
-- Disables the factor, voids recovery codes, drops assurance on every session of the target (a mandatory account must
-- re-enrol before it can do anything else) and writes an audit event.
CREATE FUNCTION public.mfa_admin_reset(p_target uuid, p_reason text) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
  v_super boolean;
  v_n integer;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'mfa_admin_reset requires app.user_id' USING ERRCODE = '42501'; END IF;
  IF p_target IS NULL OR p_target = v_actor THEN RAISE EXCEPTION 'You cannot reset your own MFA through the administrator path' USING ERRCODE = '42501'; END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) NOT BETWEEN 5 AND 500 THEN RAISE EXCEPTION 'A reason of 5-500 characters is required' USING ERRCODE = '22023'; END IF;
  v_super := EXISTS (SELECT 1 FROM public.platform_roles r WHERE r.user_id = v_actor AND r.role = 'super_admin');
  IF NOT v_super THEN
    IF EXISTS (SELECT 1 FROM public.platform_roles r WHERE r.user_id = p_target)
       OR EXISTS (SELECT 1 FROM public.organization_memberships o WHERE o.user_id = p_target)
       OR NOT EXISTS (
            SELECT 1 FROM public.school_memberships a
              JOIN public.school_memberships t ON t.tenant_id = a.tenant_id AND t.archived_at IS NULL
             WHERE a.user_id = v_actor AND a.role = 'school_admin' AND a.archived_at IS NULL AND t.user_id = p_target)
       OR EXISTS (SELECT 1 FROM public.school_memberships t WHERE t.user_id = p_target AND t.role = 'school_admin' AND t.archived_at IS NULL) THEN
      RAISE EXCEPTION 'Not authorised to reset this account' USING ERRCODE = '42501';
    END IF;
  END IF;
  UPDATE public.mfa_factors SET disabled_at = now() WHERE user_id = p_target AND disabled_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE public.mfa_recovery_codes SET used_at = now() WHERE user_id = p_target AND used_at IS NULL;
  UPDATE public.sessions SET mfa_verified_at = NULL WHERE user_id = p_target AND mfa_verified_at IS NOT NULL;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, NULL, 'auth.mfa.admin_reset', jsonb_build_object('targetUserId', p_target, 'factorsDisabled', v_n, 'byPlatformAdmin', v_super));
  RETURN v_n;
END;
$$;

REVOKE ALL ON FUNCTION public.auth_mfa_state(uuid, uuid, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mfa_clear_own_assurance() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mfa_admin_reset(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_mfa_state(uuid, uuid, text[]) TO figbloom_app;
GRANT EXECUTE ON FUNCTION public.mfa_clear_own_assurance() TO figbloom_app;
GRANT EXECUTE ON FUNCTION public.mfa_admin_reset(uuid, text) TO figbloom_app;
