-- Acceptance programme (owner decision 6.1): controlled account provisioning and recovery. Forward-only.
--
-- No public account creation, no default administrator, no backdoor:
--   * school provisioning (tenant + initial school administrator INVITATION) is a super-administrator act;
--   * staff invitations are issued by a school administrator for their own school (school_admin invitations only by a
--     super administrator); the invited person sets their own password when accepting;
--   * password recovery uses single-use, expiring, revocable tokens; requests never reveal whether an account exists;
--   * deactivating a membership revokes the person's sessions for that school.
-- Tokens are random 32-byte values chosen by the API; only their SHA-256 is stored (account_tokens.token_hash). The table is
-- owner-only; every operation goes through the SECURITY DEFINER functions below (fixed search_path, EXECUTE only for the app
-- role, actor taken from the transaction GUCs set by the server, never from a request).
-- Delivery (email/SMS) is NOT implemented here: the API reports delivery 'not_configured' until a provider is wired.

INSERT INTO permissions (code, description) VALUES
  ('identity.accounts.manage', 'Invite staff, revoke invitations, deactivate memberships and issue password resets for the school')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role, permission_code) VALUES ('school_admin', 'identity.accounts.manage') ON CONFLICT DO NOTHING;

CREATE TABLE public.account_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('invitation', 'password_reset')),
  token_hash    text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  tenant_id     uuid REFERENCES public.tenants (id) ON DELETE CASCADE,
  user_id       uuid REFERENCES public.users (id) ON DELETE CASCADE,
  email         text,
  role          text,
  full_name     text,
  created_by    uuid REFERENCES public.users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  revoked_at    timestamptz,
  CONSTRAINT account_tokens_expiry_chk CHECK (expires_at > created_at AND expires_at <= created_at + interval '14 days'),
  CONSTRAINT account_tokens_invitation_chk CHECK (
    kind <> 'invitation' OR (tenant_id IS NOT NULL AND email IS NOT NULL AND role IN ('school_admin', 'teacher', 'staff', 'driver'))),
  CONSTRAINT account_tokens_reset_chk CHECK (kind <> 'password_reset' OR user_id IS NOT NULL)
);
CREATE UNIQUE INDEX account_tokens_open_invitation_uidx ON public.account_tokens (tenant_id, lower(email))
  WHERE kind = 'invitation' AND used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX account_tokens_user_idx ON public.account_tokens (user_id) WHERE kind = 'password_reset';
ALTER TABLE public.account_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY account_tokens_owner ON public.account_tokens FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'account_tokens'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'account_tokens'));
REVOKE ALL ON public.account_tokens FROM PUBLIC, figbloom_app, figbloom_worker;

-- helper: is the caller (from the transaction GUC) a super administrator?
CREATE FUNCTION public.account_actor_is_super() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM public.platform_roles r WHERE r.user_id = public.app_current_user_id() AND r.role = 'super_admin'); $$;
REVOKE ALL ON FUNCTION public.account_actor_is_super() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.account_actor_is_super() TO figbloom_app;

-- ---------------------------------------------------------------------------------------------------------------------
-- School provisioning (super administrator): organisation (existing or new) + tenant + initial school-admin invitation.
CREATE FUNCTION public.platform_provision_school(
  p_organization_id uuid, p_organization_name text, p_school_name text, p_slug text,
  p_admin_email text, p_admin_name text, p_token_hash text, p_expires_at timestamptz
) RETURNS TABLE (tenant_id uuid, organization_id uuid, invitation_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
  v_org uuid := p_organization_id;
  v_tenant uuid;
  v_inv uuid;
  v_email text := lower(btrim(coalesce(p_admin_email, '')));
BEGIN
  IF v_actor IS NULL OR NOT public.account_actor_is_super() THEN
    RAISE EXCEPTION 'only a super administrator may provision a school' USING ERRCODE = '42501';
  END IF;
  IF char_length(btrim(coalesce(p_school_name, ''))) NOT BETWEEN 2 AND 160 OR coalesce(p_slug, '') !~ '^[a-z0-9][a-z0-9-]{2,35}$'
     OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR char_length(v_email) > 254 THEN
    RAISE EXCEPTION 'invalid school or administrator details' USING ERRCODE = '22023';
  END IF;
  IF v_org IS NULL THEN
    IF char_length(btrim(coalesce(p_organization_name, ''))) NOT BETWEEN 2 AND 160 THEN
      RAISE EXCEPTION 'organisation_name is required when organisation_id is not given' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.organizations (name, slug, kind, status)
    VALUES (btrim(p_organization_name), p_slug || '-org', 'group_owner', 'active') RETURNING id INTO v_org;
  ELSIF NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = v_org AND o.status = 'active') THEN
    RAISE EXCEPTION 'organisation not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO public.tenants (organization_id, name, slug, status) VALUES (v_org, btrim(p_school_name), p_slug, 'onboarding') RETURNING id INTO v_tenant;
  INSERT INTO public.account_tokens (kind, token_hash, tenant_id, email, role, full_name, created_by, expires_at)
  VALUES ('invitation', p_token_hash, v_tenant, v_email, 'school_admin', nullif(btrim(p_admin_name), ''), v_actor, p_expires_at) RETURNING id INTO v_inv;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, v_tenant, 'platform.school.provisioned', jsonb_build_object('organizationId', v_org, 'invitationId', v_inv, 'role', 'school_admin'));
  RETURN QUERY SELECT v_tenant, v_org, v_inv;
END
$$;
REVOKE ALL ON FUNCTION public.platform_provision_school(uuid, text, text, text, text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.platform_provision_school(uuid, text, text, text, text, text, text, timestamptz) TO figbloom_app;

-- ---------------------------------------------------------------------------------------------------------------------
-- Staff invitation (school administrator of THIS school, or super administrator).
CREATE FUNCTION public.account_create_invitation(
  p_tenant uuid, p_email text, p_role text, p_full_name text, p_token_hash text, p_expires_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_id uuid;
BEGIN
  IF v_actor IS NULL OR p_tenant IS DISTINCT FROM public.app_current_tenant_id() THEN
    RAISE EXCEPTION 'invitations are issued in the caller''s own school context' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.account_actor_is_super() OR EXISTS (
      SELECT 1 FROM public.school_memberships m WHERE m.tenant_id = p_tenant AND m.user_id = v_actor AND m.role = 'school_admin' AND m.archived_at IS NULL)) THEN
    RAISE EXCEPTION 'only a school administrator may invite' USING ERRCODE = '42501';
  END IF;
  IF p_role NOT IN ('school_admin', 'teacher', 'staff', 'driver') OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR char_length(v_email) > 254 THEN
    RAISE EXCEPTION 'invalid invitation' USING ERRCODE = '22023';
  END IF;
  IF p_role = 'school_admin' AND NOT public.account_actor_is_super() THEN
    RAISE EXCEPTION 'only a super administrator may invite a school administrator' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.school_memberships m JOIN public.users u ON u.id = m.user_id
              WHERE m.tenant_id = p_tenant AND lower(u.email) = v_email AND m.archived_at IS NULL) THEN
    RAISE EXCEPTION 'this person already belongs to the school' USING ERRCODE = '23505';
  END IF;
  -- an EXPIRED open invitation must not block a new one: retire it
  UPDATE public.account_tokens t SET revoked_at = now()
   WHERE t.tenant_id = p_tenant AND t.kind = 'invitation' AND lower(t.email) = v_email AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at <= now();
  INSERT INTO public.account_tokens (kind, token_hash, tenant_id, email, role, full_name, created_by, expires_at)
  VALUES ('invitation', p_token_hash, p_tenant, v_email, p_role, nullif(btrim(p_full_name), ''), v_actor, p_expires_at)
  RETURNING id INTO v_id;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, p_tenant, 'account.invitation.created', jsonb_build_object('invitationId', v_id, 'role', p_role));
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION public.account_create_invitation(uuid, text, text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.account_create_invitation(uuid, text, text, text, text, timestamptz) TO figbloom_app;

CREATE FUNCTION public.account_revoke_invitation(p_tenant uuid, p_invitation uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
BEGIN
  IF v_actor IS NULL OR p_tenant IS DISTINCT FROM public.app_current_tenant_id() THEN
    RAISE EXCEPTION 'revocation is performed in the caller''s own school context' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.account_actor_is_super() OR EXISTS (
      SELECT 1 FROM public.school_memberships m WHERE m.tenant_id = p_tenant AND m.user_id = v_actor AND m.role = 'school_admin' AND m.archived_at IS NULL)) THEN
    RAISE EXCEPTION 'only a school administrator may revoke an invitation' USING ERRCODE = '42501';
  END IF;
  UPDATE public.account_tokens t SET revoked_at = now()
   WHERE t.id = p_invitation AND t.tenant_id = p_tenant AND t.kind = 'invitation' AND t.used_at IS NULL AND t.revoked_at IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, p_tenant, 'account.invitation.revoked', jsonb_build_object('invitationId', p_invitation));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.account_revoke_invitation(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.account_revoke_invitation(uuid, uuid) TO figbloom_app;

-- Public: accept an invitation by token. A NEW person chooses a password (hash computed by the API, format-checked here).
-- A person who already has an account must be signed in as that account (p_session_user) — an emailed token alone never
-- attaches a school to somebody else's login. Returns the outcome only; no message distinguishes the failure causes.
CREATE FUNCTION public.account_accept_invitation(p_token_hash text, p_password_hash text, p_full_name text, p_session_user uuid)
RETURNS TABLE (outcome text, user_id uuid, tenant_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  t public.account_tokens%ROWTYPE;
  v_user uuid;
  v_prefix text;
  v_n integer;
  v_login text;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  SELECT * INTO t FROM public.account_tokens a WHERE a.token_hash = p_token_hash AND a.kind = 'invitation' FOR UPDATE;
  IF NOT FOUND OR t.used_at IS NOT NULL OR t.revoked_at IS NOT NULL OR t.expires_at <= now() THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants x WHERE x.id = t.tenant_id AND x.status <> 'suspended') THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  SELECT u.id INTO v_user FROM public.users u WHERE lower(u.email) = t.email;
  IF v_user IS NOT NULL THEN
    IF p_session_user IS DISTINCT FROM v_user THEN
      RETURN QUERY SELECT 'login_required'::text, NULL::uuid, NULL::uuid; RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_user AND u.status = 'active') THEN
      RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid; RETURN;
    END IF;
  ELSE
    IF p_password_hash IS NULL OR NOT public.auth_hash_format_ok(p_password_hash) OR p_password_hash NOT LIKE '$argon2id$%' THEN
      RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid; RETURN;
    END IF;
    INSERT INTO public.users (email, password_hash, full_name, status, must_change_password)
    VALUES (t.email, p_password_hash, coalesce(nullif(btrim(p_full_name), ''), nullif(t.full_name, ''), t.email), 'active', false)
    RETURNING id INTO v_user;
  END IF;
  v_prefix := CASE t.role WHEN 'school_admin' THEN 'AD' WHEN 'teacher' THEN 'TC' WHEN 'driver' THEN 'DR' ELSE 'SF' END;
  PERFORM pg_advisory_xact_lock(hashtext('login_id:' || t.tenant_id::text));
  SELECT coalesce(max(substring(m.login_id from 4)::int), 0) + 1 INTO v_n
    FROM public.school_memberships m WHERE m.tenant_id = t.tenant_id AND m.login_id ~ ('^' || v_prefix || '-[0-9]+$');
  v_login := v_prefix || '-' || lpad(v_n::text, 4, '0');
  INSERT INTO public.school_memberships (user_id, tenant_id, role, login_id) VALUES (v_user, t.tenant_id, t.role, v_login)
  ON CONFLICT ON CONSTRAINT school_memberships_user_id_tenant_id_key DO UPDATE SET role = EXCLUDED.role, archived_at = NULL
    WHERE public.school_memberships.archived_at IS NOT NULL;
  UPDATE public.account_tokens SET used_at = now() WHERE id = t.id;
  UPDATE public.tenants SET status = 'active' WHERE id = t.tenant_id AND status = 'onboarding' AND t.role = 'school_admin';
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_user, t.tenant_id, 'account.invitation.accepted', jsonb_build_object('invitationId', t.id, 'role', t.role));
  RETURN QUERY SELECT 'accepted'::text, v_user, t.tenant_id;
END
$$;
REVOKE ALL ON FUNCTION public.account_accept_invitation(text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.account_accept_invitation(text, text, text, uuid) TO figbloom_app;

-- ---------------------------------------------------------------------------------------------------------------------
-- Password recovery. A request for an unknown or disabled account is a silent no-op (the API answers identically).
CREATE FUNCTION public.account_request_password_reset(p_email text, p_token_hash text, p_expires_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_user uuid;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
  SELECT u.id INTO v_user FROM public.users u WHERE lower(u.email) = lower(btrim(coalesce(p_email, ''))) AND u.status = 'active';
  IF v_user IS NULL THEN RETURN false; END IF;
  UPDATE public.account_tokens SET revoked_at = now() WHERE user_id = v_user AND kind = 'password_reset' AND used_at IS NULL AND revoked_at IS NULL;
  INSERT INTO public.account_tokens (kind, token_hash, user_id, email, created_by, expires_at)
  VALUES ('password_reset', p_token_hash, v_user, lower(btrim(p_email)), NULL, p_expires_at);
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_user, NULL, 'auth.password.reset_requested', jsonb_build_object('via', 'self_service'));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.account_request_password_reset(text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.account_request_password_reset(text, text, timestamptz) TO figbloom_app;

-- School administrator issues a reset for a member of THEIR school (token returned to the administrator by the API).
CREATE FUNCTION public.account_admin_issue_reset(p_tenant uuid, p_user uuid, p_token_hash text, p_expires_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
BEGIN
  IF v_actor IS NULL OR p_tenant IS DISTINCT FROM public.app_current_tenant_id() OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'resets are issued in the caller''s own school context' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.account_actor_is_super() OR EXISTS (
      SELECT 1 FROM public.school_memberships m WHERE m.tenant_id = p_tenant AND m.user_id = v_actor AND m.role = 'school_admin' AND m.archived_at IS NULL)) THEN
    RAISE EXCEPTION 'only a school administrator may issue a reset' USING ERRCODE = '42501';
  END IF;
  IF p_user = v_actor OR NOT EXISTS (SELECT 1 FROM public.school_memberships m JOIN public.users u ON u.id = m.user_id
                                      WHERE m.tenant_id = p_tenant AND m.user_id = p_user AND m.archived_at IS NULL AND u.status = 'active') THEN
    RETURN false;
  END IF;
  IF EXISTS (SELECT 1 FROM public.platform_roles r WHERE r.user_id = p_user) THEN
    RAISE EXCEPTION 'platform administrators are not reset by a school' USING ERRCODE = '42501';
  END IF;
  UPDATE public.account_tokens SET revoked_at = now() WHERE user_id = p_user AND kind = 'password_reset' AND used_at IS NULL AND revoked_at IS NULL;
  INSERT INTO public.account_tokens (kind, token_hash, user_id, email, created_by, expires_at)
  SELECT 'password_reset', p_token_hash, u.id, lower(u.email), v_actor, p_expires_at FROM public.users u WHERE u.id = p_user;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, p_tenant, 'auth.password.reset_issued', jsonb_build_object('targetUserId', p_user));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.account_admin_issue_reset(uuid, uuid, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.account_admin_issue_reset(uuid, uuid, text, timestamptz) TO figbloom_app;

-- Complete a reset: single-use, unexpired, unrevoked; replaces the hash, activates an invited bootstrap account, clears the
-- forced-change flag and REVOKES EVERY SESSION of the user.
CREATE FUNCTION public.account_complete_password_reset(p_token_hash text, p_new_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  t public.account_tokens%ROWTYPE;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_new_hash IS NULL OR p_new_hash NOT LIKE '$argon2id$%' OR NOT public.auth_hash_format_ok(p_new_hash) THEN
    RETURN false;
  END IF;
  SELECT * INTO t FROM public.account_tokens a WHERE a.token_hash = p_token_hash AND a.kind = 'password_reset' FOR UPDATE;
  IF NOT FOUND OR t.used_at IS NOT NULL OR t.revoked_at IS NOT NULL OR t.expires_at <= now() THEN RETURN false; END IF;
  UPDATE public.users u SET password_hash = p_new_hash, must_change_password = false, updated_at = now(),
         status = CASE WHEN u.status = 'invited' THEN 'active' ELSE u.status END
   WHERE u.id = t.user_id AND u.status IN ('active', 'invited');
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.account_tokens SET used_at = now() WHERE id = t.id;
  UPDATE public.account_tokens SET revoked_at = now() WHERE user_id = t.user_id AND kind = 'password_reset' AND used_at IS NULL AND revoked_at IS NULL;
  UPDATE public.sessions s SET revoked_at = now() WHERE s.user_id = t.user_id AND s.revoked_at IS NULL;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (t.user_id, NULL, 'auth.password.reset', jsonb_build_object('revokedAllSessions', true));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.account_complete_password_reset(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.account_complete_password_reset(text, text) TO figbloom_app;

-- ---------------------------------------------------------------------------------------------------------------------
-- Deactivate a person's membership in THIS school and revoke their sessions that act in it (all sessions when it was their last).
CREATE FUNCTION public.account_deactivate_membership(p_tenant uuid, p_user uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
  v_left integer;
BEGIN
  IF v_actor IS NULL OR p_tenant IS DISTINCT FROM public.app_current_tenant_id() THEN
    RAISE EXCEPTION 'deactivation is performed in the caller''s own school context' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.account_actor_is_super() OR EXISTS (
      SELECT 1 FROM public.school_memberships m WHERE m.tenant_id = p_tenant AND m.user_id = v_actor AND m.role = 'school_admin' AND m.archived_at IS NULL)) THEN
    RAISE EXCEPTION 'only a school administrator may deactivate a member' USING ERRCODE = '42501';
  END IF;
  IF p_user = v_actor THEN
    RAISE EXCEPTION 'you cannot deactivate yourself' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM public.platform_roles r WHERE r.user_id = p_user) THEN
    RAISE EXCEPTION 'platform administrators are not deactivated by a school' USING ERRCODE = '42501';
  END IF;
  UPDATE public.school_memberships m SET archived_at = now() WHERE m.tenant_id = p_tenant AND m.user_id = p_user AND m.archived_at IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT count(*) INTO v_left FROM public.school_memberships m WHERE m.user_id = p_user AND m.archived_at IS NULL;
  UPDATE public.sessions s SET revoked_at = now()
   WHERE s.user_id = p_user AND s.revoked_at IS NULL AND (v_left = 0 OR s.active_tenant_id = p_tenant);
  UPDATE public.account_tokens SET revoked_at = now() WHERE user_id = p_user AND kind = 'password_reset' AND used_at IS NULL AND revoked_at IS NULL;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, p_tenant, 'account.membership.deactivated', jsonb_build_object('targetUserId', p_user, 'remainingMemberships', v_left));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.account_deactivate_membership(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.account_deactivate_membership(uuid, uuid) TO figbloom_app;
