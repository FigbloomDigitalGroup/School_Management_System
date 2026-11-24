-- 104: accepting a staff invitation links the matching staff record. Forward-only; 001-103 untouched (101-103 are held by
-- other open slices). Design: docs/ACCOUNT-LIFECYCLE.md ("Staff record link").
--
-- Before this, a teacher invited on the API and accepted "taught nothing": class teachers and teaching assignments name a
-- STAFF RECORD, and a staff record reaches an account only through staff_members.user_id, which only a People
-- administrator's PATCH set. Now the accept step links it when the match is certain:
--   * the invitation is for this school (every account invitation is a staff role: school_admin, teacher, staff, driver);
--   * exactly ONE active, unlinked staff record of this school has the invited e-mail (case-insensitive);
--   * the account has no staff record in this school yet.
-- Anything else (no record, two records with that e-mail, the record already linked, the account already linked, an archived
-- record, a record of another school) changes nothing, and a People administrator links by hand as before. This grants no
-- new power: whoever can set a staff record's e-mail (resource.staff.write) can already set its userId directly, and the
-- staff_members_check_user_link trigger (022) still requires an active membership of the same school.
--
-- The body is 072's, unchanged except for the block marked "104". Signature, owner, search_path and grants are unchanged.

CREATE OR REPLACE FUNCTION public.account_accept_invitation(p_token_hash text, p_password_hash text, p_full_name text, p_session_user uuid)
RETURNS TABLE (outcome text, user_id uuid, tenant_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  t public.account_tokens%ROWTYPE;
  v_user uuid;
  v_prefix text;
  v_n integer;
  v_login text;
  v_staff uuid[];
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

  -- 104: link the one matching staff record (see the header). Locked so two accepts cannot both take the same record.
  IF t.role IN ('school_admin', 'teacher', 'staff', 'driver')
     AND NOT EXISTS (SELECT 1 FROM public.staff_members s WHERE s.tenant_id = t.tenant_id AND s.user_id = v_user) THEN
    SELECT array_agg(s.id ORDER BY s.id) INTO v_staff
      FROM (SELECT s.id FROM public.staff_members s
             WHERE s.tenant_id = t.tenant_id AND s.user_id IS NULL AND s.active IS TRUE AND s.archived_at IS NULL
               AND s.email IS NOT NULL AND lower(btrim(s.email)) = t.email
             FOR UPDATE) s;
    IF coalesce(array_length(v_staff, 1), 0) = 1 THEN
      UPDATE public.staff_members sm SET user_id = v_user, updated_at = now() WHERE sm.id = v_staff[1] AND sm.tenant_id = t.tenant_id;
      INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
      VALUES (v_user, t.tenant_id, 'directory.staff.linked_on_invitation', jsonb_build_object('invitationId', t.id, 'staffId', v_staff[1]));
    END IF;
  END IF;

  UPDATE public.account_tokens SET used_at = now() WHERE id = t.id;
  UPDATE public.tenants SET status = 'active' WHERE id = t.tenant_id AND status = 'onboarding' AND t.role = 'school_admin';
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_user, t.tenant_id, 'account.invitation.accepted', jsonb_build_object('invitationId', t.id, 'role', t.role));
  RETURN QUERY SELECT 'accepted'::text, v_user, t.tenant_id;
END
$$;
REVOKE ALL ON FUNCTION public.account_accept_invitation(text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.account_accept_invitation(text, text, text, uuid) TO figbloom_app;
