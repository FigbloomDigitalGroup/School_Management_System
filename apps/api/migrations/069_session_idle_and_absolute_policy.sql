-- Acceptance programme: server-enforced session policy. Forward-only.
--   * Idle timeout: 15 minutes for staff/administrators (any non-parent school role, org or platform role),
--     30 minutes for guardians (accounts whose only active school role is 'parent'). Enforced INSIDE
--     auth_touch_session on every authenticated request from sessions.last_seen_at, never by a client timer.
--     An idle-expired session can never be revived: last_seen_at is only ever advanced for sessions that are still valid.
--   * Absolute lifetime: 8 hours. New sessions may not outlive created_at + 8 h (+ 1 min clock slack); the check is
--     NOT VALID so pre-existing sessions (minted under the old 12 h default) are not rewritten and simply expire.
--   * auth_session_idle_seconds(user) is a pure policy lookup (no secrets); unknown/no-role accounts get the stricter 15 min.

CREATE FUNCTION public.auth_session_idle_seconds(p_user_id uuid) RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.platform_roles r WHERE r.user_id = p_user_id)
      OR EXISTS (SELECT 1 FROM public.organization_memberships o WHERE o.user_id = p_user_id)
      OR EXISTS (SELECT 1 FROM public.school_memberships m WHERE m.user_id = p_user_id AND m.archived_at IS NULL AND m.role::text <> 'parent')
      THEN 900
    WHEN EXISTS (SELECT 1 FROM public.school_memberships m WHERE m.user_id = p_user_id AND m.archived_at IS NULL AND m.role::text = 'parent')
      THEN 1800
    ELSE 900
  END;
$$;
REVOKE ALL ON FUNCTION public.auth_session_idle_seconds(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_session_idle_seconds(uuid) TO figbloom_app;

CREATE OR REPLACE FUNCTION public.auth_touch_session(
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
       AND s.last_seen_at > now() - make_interval(secs => public.auth_session_idle_seconds(s.user_id))
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

ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_absolute_lifetime_chk CHECK (expires_at <= created_at + interval '8 hours 1 minute') NOT VALID;
