-- Guardian invitation and account linking (acceptance programme 6.2 / workstream 1). Forward-only.
--
-- Principles (owner-approved):
--   * Linking is INVITATION-BASED only. A guardian record (a directory contact) is never linked to a login because a phone number,
--     e-mail address or name happens to match.
--   * The invitation is bound to ONE school, ONE guardian record and ONE intended learner relationship (a live guardian_links row).
--   * The token is 32 random bytes chosen by the API; only its SHA-256 is stored. Single use, expiring, revocable, superseded when a
--     newer invitation is issued for the same guardian.
--   * The accepting person must (a) hold the token, (b) echo the invited contact, and (c) explicitly confirm the relationship.
--     NOTE: with no delivery provider the token is handed to the issuer; contact CONTROL is then evidenced only by token possession
--     plus the contact echo (recorded as contact_verification = 'token_and_contact_echo'). A provider-delivered token
--     would record 'delivered_token'. Delivery itself is an external dependency; nothing here claims it happened.
--   * A guardian record is linked to at most ONE active login; one login may be linked to several guardian records (and schools),
--     which is how one parent sees several learners. Relinking = revoke the link, then invite again.
--   * Tables are owner-only; every operation is a SECURITY DEFINER function with a fixed search_path, executable by figbloom_app
--     only, with the actor taken from the transaction GUCs the server sets.
--   * Archiving a membership (deactivation) revokes the person's guardian links in that school (trigger, not application code).

CREATE TABLE public.guardian_invitations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES public.tenants (id) ON DELETE RESTRICT,
  guardian_id           uuid NOT NULL,
  learner_id            uuid NOT NULL,
  contact_method        text NOT NULL CHECK (contact_method IN ('email', 'sms')),
  contact_value         text NOT NULL CHECK (char_length(contact_value) BETWEEN 3 AND 254),
  token_hash            text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status                text NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'accepted', 'revoked', 'expired', 'superseded')),
  delivery_status       text NOT NULL DEFAULT 'not_configured'
                          CHECK (delivery_status IN ('not_configured', 'pending', 'sent', 'failed')),
  contact_verification  text CHECK (contact_verification IN ('token_and_contact_echo', 'delivered_token')),
  created_by            uuid REFERENCES public.users (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  accepted_at           timestamptz,
  accepted_by           uuid REFERENCES public.users (id) ON DELETE SET NULL,
  closed_at             timestamptz,
  closed_by             uuid REFERENCES public.users (id) ON DELETE SET NULL,
  CONSTRAINT guardian_invitations_expiry_chk CHECK (expires_at > created_at AND expires_at <= created_at + interval '14 days'),
  CONSTRAINT guardian_invitations_accept_chk CHECK ((status = 'accepted') = (accepted_at IS NOT NULL AND accepted_by IS NOT NULL AND contact_verification IS NOT NULL)),
  CONSTRAINT guardian_invitations_guardian_fk FOREIGN KEY (guardian_id, tenant_id) REFERENCES public.guardians (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT guardian_invitations_learner_fk FOREIGN KEY (learner_id, tenant_id) REFERENCES public.learners (id, tenant_id) ON DELETE RESTRICT
);
-- at most one open invitation per guardian record
CREATE UNIQUE INDEX guardian_invitations_open_uidx ON public.guardian_invitations (guardian_id) WHERE status = 'pending';
CREATE INDEX guardian_invitations_tenant_idx ON public.guardian_invitations (tenant_id, created_at DESC);

CREATE TABLE public.guardian_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  guardian_id   uuid NOT NULL,
  user_id       uuid NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
  invitation_id uuid NOT NULL REFERENCES public.guardian_invitations (id) ON DELETE RESTRICT,
  linked_at     timestamptz NOT NULL DEFAULT now(),
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES public.users (id) ON DELETE SET NULL,
  revoke_reason text,
  CONSTRAINT guardian_accounts_guardian_fk FOREIGN KEY (guardian_id, tenant_id) REFERENCES public.guardians (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT guardian_accounts_revoke_chk CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
-- a guardian record has at most one live login; a login is linked to a record at most once
CREATE UNIQUE INDEX guardian_accounts_active_guardian_uidx ON public.guardian_accounts (guardian_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX guardian_accounts_active_user_guardian_uidx ON public.guardian_accounts (user_id, guardian_id) WHERE revoked_at IS NULL;
CREATE INDEX guardian_accounts_user_idx ON public.guardian_accounts (user_id) WHERE revoked_at IS NULL;

DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['guardian_invitations', 'guardian_accounts'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR ALL TO PUBLIC
      USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))
      WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))$p$,
      t || '_owner', t, t, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, figbloom_app, figbloom_worker', t);
  END LOOP;
END
$rls$;

-- caller must be a school administrator of the tenant in context (or a super administrator)
CREATE FUNCTION public.guardian_actor_may_manage(p_tenant uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_tenant IS NOT DISTINCT FROM public.app_current_tenant_id() AND public.app_current_user_id() IS NOT NULL AND (
    public.account_actor_is_super() OR EXISTS (
      SELECT 1 FROM public.school_memberships m
       WHERE m.tenant_id = p_tenant AND m.user_id = public.app_current_user_id() AND m.role = 'school_admin' AND m.archived_at IS NULL));
$$;
REVOKE ALL ON FUNCTION public.guardian_actor_may_manage(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guardian_actor_may_manage(uuid) TO figbloom_app;

-- Issue an invitation. The token hash comes from the API (the clear token is never stored). Supersedes any open invitation for the
-- same guardian record. Raises 55000 when the guardian already has a live login (revoke it first).
CREATE FUNCTION public.guardian_create_invitation(
  p_tenant uuid, p_guardian uuid, p_learner uuid, p_method text, p_token_hash text, p_expires_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
  g public.guardians%ROWTYPE;
  v_contact text;
  v_id uuid;
BEGIN
  IF NOT public.guardian_actor_may_manage(p_tenant) THEN
    RAISE EXCEPTION 'guardian invitations are issued by a school administrator in the school context' USING ERRCODE = '42501';
  END IF;
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' OR p_method NOT IN ('email', 'sms') OR p_expires_at <= now() OR p_expires_at > now() + interval '14 days' THEN
    RAISE EXCEPTION 'invalid invitation parameters' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO g FROM public.guardians x WHERE x.id = p_guardian AND x.tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'guardian not found' USING ERRCODE = 'P0002'; END IF;
  IF g.archived_at IS NOT NULL OR g.active IS NOT TRUE THEN RAISE EXCEPTION 'guardian is archived' USING ERRCODE = '55000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.guardian_links l JOIN public.learners le ON le.id = l.learner_id AND le.tenant_id = l.tenant_id
                  WHERE l.guardian_id = p_guardian AND l.learner_id = p_learner AND l.tenant_id = p_tenant AND l.archived_at IS NULL AND le.archived_at IS NULL) THEN
    RAISE EXCEPTION 'the learner relationship is not active' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM public.guardian_accounts a WHERE a.guardian_id = p_guardian AND a.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'guardian already linked to an account' USING ERRCODE = '55000';
  END IF;
  v_contact := CASE p_method WHEN 'email' THEN lower(btrim(coalesce(g.email, ''))) ELSE regexp_replace(coalesce(g.phone, ''), '[^0-9]', '', 'g') END;
  IF v_contact = '' THEN RAISE EXCEPTION 'the guardian has no %', CASE p_method WHEN 'email' THEN 'e-mail address' ELSE 'phone number' END USING ERRCODE = '22023'; END IF;

  UPDATE public.guardian_invitations i SET status = 'expired', closed_at = now()
   WHERE i.guardian_id = p_guardian AND i.status = 'pending' AND i.expires_at <= now();
  UPDATE public.guardian_invitations i SET status = 'superseded', closed_at = now(), closed_by = v_actor
   WHERE i.guardian_id = p_guardian AND i.status = 'pending';
  INSERT INTO public.guardian_invitations (tenant_id, guardian_id, learner_id, contact_method, contact_value, token_hash, created_by, expires_at)
  VALUES (p_tenant, p_guardian, p_learner, p_method, v_contact, p_token_hash, v_actor, p_expires_at) RETURNING id INTO v_id;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, p_tenant, 'guardian.invitation.created', jsonb_build_object('invitationId', v_id, 'guardianId', p_guardian, 'learnerId', p_learner, 'method', p_method));
  RETURN v_id;
END
$$;
REVOKE ALL ON FUNCTION public.guardian_create_invitation(uuid, uuid, uuid, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guardian_create_invitation(uuid, uuid, uuid, text, text, timestamptz) TO figbloom_app;

CREATE FUNCTION public.guardian_revoke_invitation(p_tenant uuid, p_invitation uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_actor uuid := public.app_current_user_id(); v_n integer;
BEGIN
  IF NOT public.guardian_actor_may_manage(p_tenant) THEN RAISE EXCEPTION 'insufficient permissions' USING ERRCODE = '42501'; END IF;
  UPDATE public.guardian_invitations SET status = 'revoked', closed_at = now(), closed_by = v_actor
   WHERE id = p_invitation AND tenant_id = p_tenant AND status = 'pending';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RETURN false; END IF;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, p_tenant, 'guardian.invitation.revoked', jsonb_build_object('invitationId', p_invitation));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.guardian_revoke_invitation(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guardian_revoke_invitation(uuid, uuid) TO figbloom_app;

-- Delivery outcome reported by the (future) provider boundary. Never marks an invitation accepted.
CREATE FUNCTION public.guardian_record_delivery(p_tenant uuid, p_invitation uuid, p_status text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_n integer;
BEGIN
  IF NOT public.guardian_actor_may_manage(p_tenant) THEN RAISE EXCEPTION 'insufficient permissions' USING ERRCODE = '42501'; END IF;
  IF p_status NOT IN ('not_configured', 'pending', 'sent', 'failed') THEN RAISE EXCEPTION 'invalid delivery status' USING ERRCODE = '22023'; END IF;
  UPDATE public.guardian_invitations SET delivery_status = p_status WHERE id = p_invitation AND tenant_id = p_tenant AND status = 'pending';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END
$$;
REVOKE ALL ON FUNCTION public.guardian_record_delivery(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guardian_record_delivery(uuid, uuid, text) TO figbloom_app;

-- Staff listing: metadata only (no token hash, contact masked).
CREATE FUNCTION public.guardian_list_invitations(p_tenant uuid, p_status text, p_limit integer)
RETURNS TABLE (id uuid, guardian_id uuid, learner_id uuid, contact_method text, contact_hint text, status text, delivery_status text,
               created_at timestamptz, expires_at timestamptz, accepted_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT public.guardian_actor_may_manage(p_tenant) THEN RAISE EXCEPTION 'insufficient permissions' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
    SELECT i.id, i.guardian_id, i.learner_id, i.contact_method,
           CASE WHEN i.contact_method = 'email' THEN left(i.contact_value, 2) || '***' || substring(i.contact_value from '@.*$')
                ELSE '***' || right(i.contact_value, 3) END,
           CASE WHEN i.status = 'pending' AND i.expires_at <= now() THEN 'expired' ELSE i.status END,
           i.delivery_status, i.created_at, i.expires_at, i.accepted_at
      FROM public.guardian_invitations i
     WHERE i.tenant_id = p_tenant AND (p_status IS NULL OR i.status = p_status)
     ORDER BY i.created_at DESC LIMIT greatest(1, least(coalesce(p_limit, 50), 200));
END
$$;
REVOKE ALL ON FUNCTION public.guardian_list_invitations(uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guardian_list_invitations(uuid, text, integer) TO figbloom_app;

-- Public preview: proves nothing about any account. Reveals only the school name and relationship to someone already holding a
-- live token; every failure answers identically.
CREATE FUNCTION public.guardian_preview_invitation(p_token_hash text)
RETURNS TABLE (school_name text, relationship text, contact_method text, existing_account boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;
  RETURN QUERY
    SELECT t.name, l.relationship, i.contact_method,
           (i.contact_method = 'sms' OR EXISTS (SELECT 1 FROM public.users u WHERE lower(u.email) = i.contact_value))
      FROM public.guardian_invitations i
      JOIN public.tenants t ON t.id = i.tenant_id AND t.status <> 'suspended'
      JOIN public.guardian_links l ON l.guardian_id = i.guardian_id AND l.learner_id = i.learner_id AND l.archived_at IS NULL
     WHERE i.token_hash = p_token_hash AND i.status = 'pending' AND i.expires_at > now();
END
$$;
REVOKE ALL ON FUNCTION public.guardian_preview_invitation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guardian_preview_invitation(text) TO figbloom_app;

-- Accept. Outcomes: accepted | login_required | confirmation_required | invalid (identical for every other cause).
CREATE FUNCTION public.guardian_accept_invitation(
  p_token_hash text, p_contact text, p_confirm boolean, p_password_hash text, p_full_name text, p_session_user uuid
) RETURNS TABLE (outcome text, user_id uuid, tenant_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  i public.guardian_invitations%ROWTYPE;
  g public.guardians%ROWTYPE;
  v_contact text;
  v_user uuid;
  v_role text;
  v_n integer;
  v_login text;
  v_account uuid;
  v_new boolean := false;
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  SELECT * INTO i FROM public.guardian_invitations x WHERE x.token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR i.status <> 'pending' OR i.expires_at <= now() THEN
    IF FOUND AND i.status = 'pending' AND i.expires_at <= now() THEN
      UPDATE public.guardian_invitations SET status = 'expired', closed_at = now() WHERE id = i.id;
    END IF;
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = i.tenant_id AND t.status <> 'suspended') THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  SELECT * INTO g FROM public.guardians x WHERE x.id = i.guardian_id AND x.tenant_id = i.tenant_id FOR UPDATE;
  IF NOT FOUND OR g.archived_at IS NOT NULL OR g.active IS NOT TRUE
     OR NOT EXISTS (SELECT 1 FROM public.guardian_links l JOIN public.learners le ON le.id = l.learner_id AND le.tenant_id = l.tenant_id
                     WHERE l.guardian_id = i.guardian_id AND l.learner_id = i.learner_id AND l.archived_at IS NULL AND le.archived_at IS NULL)
     OR EXISTS (SELECT 1 FROM public.guardian_accounts a WHERE a.guardian_id = i.guardian_id AND a.revoked_at IS NULL) THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  -- contact echo: the person must know the invited contact (e-mail, or the phone digits)
  v_contact := CASE i.contact_method WHEN 'email' THEN lower(btrim(coalesce(p_contact, ''))) ELSE regexp_replace(coalesce(p_contact, ''), '[^0-9]', '', 'g') END;
  IF v_contact = '' OR v_contact IS DISTINCT FROM i.contact_value THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  IF p_confirm IS NOT TRUE THEN
    RETURN QUERY SELECT 'confirmation_required'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;

  IF i.contact_method = 'email' THEN
    SELECT u.id INTO v_user FROM public.users u WHERE lower(u.email) = i.contact_value;
  ELSE
    v_user := p_session_user; -- a phone invitation can only attach to an account the person is already signed in to
    IF v_user IS NULL THEN RETURN QUERY SELECT 'login_required'::text, NULL::uuid, NULL::uuid; RETURN; END IF;
  END IF;
  IF v_user IS NOT NULL THEN
    IF p_session_user IS DISTINCT FROM v_user THEN
      RETURN QUERY SELECT 'login_required'::text, NULL::uuid, NULL::uuid; RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_user AND u.status = 'active') THEN
      RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid; RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM public.platform_roles r WHERE r.user_id = v_user) THEN
      RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid; RETURN;
    END IF;
  ELSE
    IF p_password_hash IS NULL OR NOT public.auth_hash_format_ok(p_password_hash) OR p_password_hash NOT LIKE '$argon2id$%' THEN
      RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid; RETURN;
    END IF;
    INSERT INTO public.users (email, password_hash, full_name, status, must_change_password)
    VALUES (i.contact_value, p_password_hash, coalesce(nullif(btrim(p_full_name), ''), g.full_name), 'active', false)
    RETURNING id INTO v_user;
    v_new := true;
  END IF;

  -- school membership as a parent; a person who already holds a DIFFERENT role in this school is not silently re-roled
  SELECT m.role INTO v_role FROM public.school_memberships m WHERE m.user_id = v_user AND m.tenant_id = i.tenant_id;
  IF v_role IS NOT NULL AND v_role <> 'parent' THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  IF v_role IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('login_id:' || i.tenant_id::text));
    SELECT coalesce(max(substring(m.login_id from 4)::int), 0) + 1 INTO v_n
      FROM public.school_memberships m WHERE m.tenant_id = i.tenant_id AND m.login_id ~ '^PT-[0-9]+$';
    v_login := 'PT-' || lpad(v_n::text, 4, '0');
    INSERT INTO public.school_memberships (user_id, tenant_id, role, login_id) VALUES (v_user, i.tenant_id, 'parent', v_login);
  ELSE
    UPDATE public.school_memberships m SET archived_at = NULL WHERE m.user_id = v_user AND m.tenant_id = i.tenant_id AND m.archived_at IS NOT NULL;
  END IF;

  INSERT INTO public.guardian_accounts (tenant_id, guardian_id, user_id, invitation_id) VALUES (i.tenant_id, i.guardian_id, v_user, i.id)
  RETURNING id INTO v_account;
  UPDATE public.guardian_invitations SET status = 'accepted', accepted_at = now(), accepted_by = v_user, closed_at = now(),
         contact_verification = CASE WHEN delivery_status = 'sent' THEN 'delivered_token' ELSE 'token_and_contact_echo' END
   WHERE id = i.id;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_user, i.tenant_id, 'guardian.invitation.accepted',
          jsonb_build_object('invitationId', i.id, 'guardianId', i.guardian_id, 'learnerId', i.learner_id, 'newAccount', v_new, 'guardianAccountId', v_account));
  RETURN QUERY SELECT 'accepted'::text, v_user, i.tenant_id;
END
$$;
REVOKE ALL ON FUNCTION public.guardian_accept_invitation(text, text, boolean, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guardian_accept_invitation(text, text, boolean, text, text, uuid) TO figbloom_app;

-- Revoke a live link (the first half of relinking). Final.
CREATE FUNCTION public.guardian_revoke_account_link(p_tenant uuid, p_guardian uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_actor uuid := public.app_current_user_id(); v_user uuid; v_id uuid;
BEGIN
  IF NOT public.guardian_actor_may_manage(p_tenant) THEN RAISE EXCEPTION 'insufficient permissions' USING ERRCODE = '42501'; END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 3 OR char_length(p_reason) > 300 THEN RAISE EXCEPTION 'a reason is required' USING ERRCODE = '22023'; END IF;
  UPDATE public.guardian_accounts SET revoked_at = now(), revoked_by = v_actor, revoke_reason = btrim(p_reason)
   WHERE tenant_id = p_tenant AND guardian_id = p_guardian AND revoked_at IS NULL RETURNING id, user_id INTO v_id, v_user;
  IF v_id IS NULL THEN RETURN false; END IF;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, p_tenant, 'guardian.account.revoked', jsonb_build_object('guardianAccountId', v_id, 'guardianId', p_guardian, 'userId', v_user));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.guardian_revoke_account_link(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guardian_revoke_account_link(uuid, uuid, text) TO figbloom_app;

-- The signed-in person's own live links (the basis for later child-scoped reads). Own user only; no tenant filter needed.
CREATE FUNCTION public.guardian_my_links() RETURNS TABLE (tenant_id uuid, guardian_id uuid, learner_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT a.tenant_id, a.guardian_id, l.learner_id
    FROM public.guardian_accounts a
    JOIN public.users u ON u.id = a.user_id AND u.status = 'active'
    JOIN public.school_memberships m ON m.user_id = a.user_id AND m.tenant_id = a.tenant_id AND m.archived_at IS NULL
    JOIN public.guardian_links l ON l.guardian_id = a.guardian_id AND l.tenant_id = a.tenant_id AND l.archived_at IS NULL
   WHERE a.user_id = public.app_current_user_id() AND a.revoked_at IS NULL;
$$;
REVOKE ALL ON FUNCTION public.guardian_my_links() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.guardian_my_links() TO figbloom_app;

-- Deactivation (membership archived) revokes the person's links in that school, in the database.
CREATE FUNCTION public.guardian_accounts_on_membership_archive() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
    WITH r AS (
      UPDATE public.guardian_accounts a SET revoked_at = now(), revoke_reason = 'membership deactivated'
       WHERE a.user_id = NEW.user_id AND a.tenant_id = NEW.tenant_id AND a.revoked_at IS NULL RETURNING a.id, a.guardian_id)
    INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
    SELECT public.app_current_user_id(), NEW.tenant_id, 'guardian.account.revoked',
           jsonb_build_object('guardianAccountId', r.id, 'guardianId', r.guardian_id, 'userId', NEW.user_id, 'cause', 'membership_deactivated') FROM r;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.guardian_accounts_on_membership_archive() FROM PUBLIC;
CREATE TRIGGER guardian_accounts_on_membership_archive
  AFTER UPDATE OF archived_at ON public.school_memberships
  FOR EACH ROW EXECUTE FUNCTION public.guardian_accounts_on_membership_archive();
