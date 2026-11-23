-- Re-authentication for sensitive actions (owner decision 6.5). Forward-only.
-- A session counts as RECENTLY AUTHENTICATED when its login (created_at) or its last password re-confirmation (reauthenticated_at)
-- is within the window the API enforces (default 5 minutes). Sensitive operations (administrator resets, deactivation, school
-- provisioning, financial and unmatched-callback resolutions, guardian-link revocation) require it; an old session must
-- confirm the password again. Freshness is read and stamped only through definer functions bound to the transaction user.
ALTER TABLE public.sessions ADD COLUMN reauthenticated_at timestamptz;

CREATE FUNCTION public.auth_session_recent(p_session uuid, p_seconds integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce((
    SELECT greatest(s.created_at, coalesce(s.reauthenticated_at, s.created_at)) > now() - make_interval(secs => greatest(p_seconds, 1))
      FROM public.sessions s
     WHERE s.id = p_session AND s.user_id = public.app_current_user_id() AND s.revoked_at IS NULL AND s.expires_at > now()), false);
$$;
REVOKE ALL ON FUNCTION public.auth_session_recent(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_session_recent(uuid, integer) TO figbloom_app;

CREATE FUNCTION public.auth_mark_reauthenticated(p_session uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_n integer;
BEGIN
  UPDATE public.sessions SET reauthenticated_at = now()
   WHERE id = p_session AND user_id = public.app_current_user_id() AND revoked_at IS NULL AND expires_at > now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 1 THEN
    INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
    VALUES (public.app_current_user_id(), NULL, 'auth.reauthenticated', '{}'::jsonb);
  END IF;
  RETURN v_n = 1;
END
$$;
REVOKE ALL ON FUNCTION public.auth_mark_reauthenticated(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_mark_reauthenticated(uuid) TO figbloom_app;
