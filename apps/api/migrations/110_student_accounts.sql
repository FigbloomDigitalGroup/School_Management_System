-- 110: student (learner) accounts. Forward-only; 001-105 untouched. Design: docs/STUDENT-ACCOUNTS.md.
--
-- Owner decisions (2026-11-25):
--   1) the school office (a school administrator, or a teacher/staff member holding the People area) makes a learner's
--      login: login id ST-0001.., a random one-time password shown once, must_change_password at first sign-in, resets by
--      the office; no e-mail needed;
--   2) session: like guardians (30-minute idle timeout, 8-hour absolute), no two-step sign-in for students;
--   3) chat: one-to-one with the teachers of their own class and the school office (administrators) only;
--   4) fees and exams: own invoices and receipts, pay by M-Pesa; published online papers of their own class, own attempts.
--
-- What this migration does:
--   * learner_accounts: the link from a login to a learner record. Owner-only (like guardian_accounts, 073); one live
--     login per learner; a login belongs to one learner for ever; revocable; revoked when the membership is archived.
--   * student_my_learner(): the caller's own live learner in the school of the request (definer: the table is owner-only).
--   * student_account_* functions: create / reset password / revoke / status, for the office only (re-checked here).
--   * permission resource.student.self.read for the student role.
--   * auth_session_idle_seconds: a student gets the guardian idle timeout.
--   * communications_audience_reaches and may_talk: a student branch (class / form-level notices; chat with class
--     teachers and administrators only). Everything else is exactly as in 100.
--   * online_exam_papers.published_at: learners see only published papers.
--   * finance_payment_proofs.submitted_via may be 'learner' (a learner paying their own fees).

INSERT INTO permissions (code, description) VALUES
  ('resource.student.self.read', 'A learner reads their own school records (results, homework, timetable, fees, notices, published online exams)')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role, permission_code) VALUES
  ('student', 'resource.student.self.read'),
  -- platform super administrators hold every catalogued permission; they have no student membership, so no learner
  ('super_admin', 'resource.student.self.read')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------------
CREATE TABLE public.learner_accounts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  learner_id     uuid NOT NULL,
  user_id        uuid NOT NULL UNIQUE REFERENCES public.users (id) ON DELETE RESTRICT,
  created_by     uuid REFERENCES public.users (id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  password_set_at timestamptz NOT NULL DEFAULT now(),
  password_set_by uuid REFERENCES public.users (id) ON DELETE SET NULL,
  revoked_at     timestamptz,
  revoked_by     uuid REFERENCES public.users (id) ON DELETE SET NULL,
  revoke_reason  text,
  CONSTRAINT learner_accounts_learner_fk FOREIGN KEY (learner_id, tenant_id) REFERENCES public.learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT learner_accounts_revoke_chk CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
-- one live login per learner
CREATE UNIQUE INDEX learner_accounts_live_learner_uidx ON public.learner_accounts (learner_id) WHERE revoked_at IS NULL;
CREATE INDEX learner_accounts_tenant_idx ON public.learner_accounts (tenant_id, learner_id);

ALTER TABLE public.learner_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.learner_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY learner_accounts_owner ON public.learner_accounts FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'learner_accounts'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'learner_accounts'));
REVOKE ALL ON public.learner_accounts FROM PUBLIC, figbloom_app, figbloom_worker;

-- ---------------------------------------------------------------------------------------------------------------------
-- The calling account's own learner in the school of the request. All of these must hold, now: a live link for this user
-- in this school, an active account, a non-archived `student` membership of a school that is not suspended, and an active
-- learner. No argument: the user and the school come from the transaction settings the API sets after authorising the
-- request. At most one row (a login belongs to one learner).
CREATE FUNCTION public.student_my_learner()
RETURNS TABLE (learner_id uuid, login_id text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT la.learner_id, m.login_id
    FROM public.learner_accounts la
    JOIN public.users u ON u.id = la.user_id AND u.status = 'active'
    JOIN public.tenants t ON t.id = la.tenant_id AND t.status <> 'suspended'
    JOIN public.school_memberships m
      ON m.user_id = la.user_id AND m.tenant_id = la.tenant_id AND m.archived_at IS NULL AND m.role::text = 'student'
    JOIN public.learners le
      ON le.id = la.learner_id AND le.tenant_id = la.tenant_id AND le.active IS TRUE AND le.archived_at IS NULL
   WHERE la.user_id = public.app_current_user_id()
     AND la.tenant_id = public.app_current_tenant_id()
     AND la.revoked_at IS NULL
$$;
REVOKE ALL ON FUNCTION public.student_my_learner() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.student_my_learner() TO figbloom_app;

-- The school office of the tenant in context: an active account that is a super administrator, a school administrator, or
-- a teacher/staff member holding the People area directly or through a school role. (Organisation administrators are not
-- included: area.people is no longer delegable, owner decision 2026-11-17.)
CREATE FUNCTION public.student_account_actor_may_manage(p_tenant uuid) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_tenant IS NOT DISTINCT FROM public.app_current_tenant_id()
     AND public.app_current_user_id() IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = public.app_current_user_id() AND u.status = 'active')
     AND (
       public.account_actor_is_super()
       OR EXISTS (
         SELECT 1 FROM public.school_memberships m
          WHERE m.tenant_id = p_tenant AND m.user_id = public.app_current_user_id() AND m.archived_at IS NULL
            AND (m.role::text = 'school_admin'
                 OR (m.role::text IN ('teacher', 'staff')
                     AND (EXISTS (SELECT 1 FROM public.staff_area_grants g
                                   WHERE g.tenant_id = p_tenant AND g.user_id = m.user_id AND g.area = 'people')
                          OR EXISTS (SELECT 1 FROM public.school_role_assignments a
                                       JOIN public.school_roles r ON r.id = a.role_id AND r.tenant_id = a.tenant_id
                                      WHERE a.tenant_id = p_tenant AND a.user_id = m.user_id AND 'people' = ANY (r.areas))))))
     )
$$;
-- internal: called only by the student_account_* definers below (no runtime grant)
REVOKE ALL ON FUNCTION public.student_account_actor_may_manage(uuid) FROM PUBLIC;

-- Create a learner's login. The Argon2id hash of the one-time password comes from the API (the clear password is never
-- stored and never audited). Raises 42501 (not the office), 22023 (bad hash), P0002 (no such learner here), 55000
-- (archived learner), 23505 (the learner already has a live login: a second create is refused, never a second account),
-- 54000 (the school has used every ST- number). Concurrent creates for one learner serialise on the learner row; login
-- numbers are allocated under the same per-school advisory lock as every other login id (072, 073).
CREATE FUNCTION public.student_account_create(p_tenant uuid, p_learner uuid, p_hash text)
RETURNS TABLE (user_id uuid, login_id text, learner_account_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
  le public.learners%ROWTYPE;
  v_user uuid;
  v_n integer;
  v_login text;
  v_id uuid;
BEGIN
  IF NOT public.student_account_actor_may_manage(p_tenant) THEN
    RAISE EXCEPTION 'learner logins are made by the school office in the school context' USING ERRCODE = '42501';
  END IF;
  IF p_hash IS NULL OR NOT public.auth_hash_format_ok(p_hash) OR p_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'invalid credential' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO le FROM public.learners x WHERE x.id = p_learner AND x.tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'learner not found' USING ERRCODE = 'P0002'; END IF;
  IF le.archived_at IS NOT NULL OR le.active IS NOT TRUE THEN RAISE EXCEPTION 'learner is archived' USING ERRCODE = '55000'; END IF;
  IF EXISTS (SELECT 1 FROM public.learner_accounts a WHERE a.learner_id = p_learner AND a.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'this learner already has a login' USING ERRCODE = '23505';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('login_id:' || p_tenant::text));
  SELECT coalesce(max(substring(m.login_id from 4)::int), 0) + 1 INTO v_n
    FROM public.school_memberships m WHERE m.tenant_id = p_tenant AND m.login_id ~ '^ST-[0-9]+$';
  IF v_n > 9999 THEN RAISE EXCEPTION 'no student login numbers are left in this school' USING ERRCODE = '54000'; END IF;
  v_login := 'ST-' || lpad(v_n::text, 4, '0');

  INSERT INTO public.users (email, password_hash, full_name, status, must_change_password)
  VALUES (NULL, p_hash, le.full_name, 'active', true)
  RETURNING id INTO v_user;
  INSERT INTO public.school_memberships (user_id, tenant_id, role, login_id) VALUES (v_user, p_tenant, 'student', v_login);
  INSERT INTO public.learner_accounts (tenant_id, learner_id, user_id, created_by, password_set_by)
  VALUES (p_tenant, p_learner, v_user, v_actor, v_actor)
  RETURNING id INTO v_id;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, p_tenant, 'student.account.created',
          jsonb_build_object('learnerAccountId', v_id, 'learnerId', p_learner, 'userId', v_user, 'loginId', v_login));
  RETURN QUERY SELECT v_user, v_login, v_id;
END
$$;
REVOKE ALL ON FUNCTION public.student_account_create(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.student_account_create(uuid, uuid, text) TO figbloom_app;

-- The office sets a new one-time password: replaces the hash, forces a change at the next sign-in, ends every session of
-- the login and voids any open reset token. A disabled account stays disabled (P0002 for no live login, 55000 for a
-- disabled one).
CREATE FUNCTION public.student_account_reset_password(p_tenant uuid, p_learner uuid, p_hash text)
RETURNS TABLE (user_id uuid, login_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
  v_id uuid;
  v_user uuid;
  v_login text;
BEGIN
  IF NOT public.student_account_actor_may_manage(p_tenant) THEN
    RAISE EXCEPTION 'learner logins are reset by the school office in the school context' USING ERRCODE = '42501';
  END IF;
  IF p_hash IS NULL OR NOT public.auth_hash_format_ok(p_hash) OR p_hash NOT LIKE '$argon2id$%' THEN
    RAISE EXCEPTION 'invalid credential' USING ERRCODE = '22023';
  END IF;
  SELECT a.id, a.user_id, m.login_id INTO v_id, v_user, v_login
    FROM public.learner_accounts a
    JOIN public.school_memberships m ON m.user_id = a.user_id AND m.tenant_id = a.tenant_id AND m.archived_at IS NULL
   WHERE a.tenant_id = p_tenant AND a.learner_id = p_learner AND a.revoked_at IS NULL
   FOR UPDATE OF a;
  IF v_id IS NULL THEN RAISE EXCEPTION 'no live login for this learner' USING ERRCODE = 'P0002'; END IF;
  UPDATE public.users u SET password_hash = p_hash, must_change_password = true, updated_at = now()
   WHERE u.id = v_user AND u.status = 'active';
  IF NOT FOUND THEN RAISE EXCEPTION 'the login is disabled' USING ERRCODE = '55000'; END IF;
  UPDATE public.learner_accounts SET password_set_at = now(), password_set_by = v_actor WHERE id = v_id;
  UPDATE public.sessions s SET revoked_at = now() WHERE s.user_id = v_user AND s.revoked_at IS NULL;
  UPDATE public.account_tokens t SET revoked_at = now()
   WHERE t.user_id = v_user AND t.kind = 'password_reset' AND t.used_at IS NULL AND t.revoked_at IS NULL;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, p_tenant, 'student.account.password_reset',
          jsonb_build_object('learnerAccountId', v_id, 'learnerId', p_learner, 'userId', v_user, 'loginId', v_login, 'revokedAllSessions', true));
  RETURN QUERY SELECT v_user, v_login;
END
$$;
REVOKE ALL ON FUNCTION public.student_account_reset_password(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.student_account_reset_password(uuid, uuid, text) TO figbloom_app;

-- Revoke a learner's login: the link is closed (final), the student membership archived (the login id no longer signs in)
-- and every session of the login ended. A new login is a new create (a new account and login id).
CREATE FUNCTION public.student_account_revoke(p_tenant uuid, p_learner uuid, p_reason text) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_actor uuid := public.app_current_user_id();
  v_id uuid;
  v_user uuid;
BEGIN
  IF NOT public.student_account_actor_may_manage(p_tenant) THEN
    RAISE EXCEPTION 'learner logins are revoked by the school office in the school context' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR char_length(btrim(p_reason)) < 3 OR char_length(p_reason) > 300 THEN
    RAISE EXCEPTION 'a reason is required' USING ERRCODE = '22023';
  END IF;
  UPDATE public.learner_accounts a SET revoked_at = now(), revoked_by = v_actor, revoke_reason = btrim(p_reason)
   WHERE a.tenant_id = p_tenant AND a.learner_id = p_learner AND a.revoked_at IS NULL
  RETURNING a.id, a.user_id INTO v_id, v_user;
  IF v_id IS NULL THEN RETURN false; END IF;
  UPDATE public.school_memberships m SET archived_at = now()
   WHERE m.user_id = v_user AND m.tenant_id = p_tenant AND m.archived_at IS NULL;
  UPDATE public.sessions s SET revoked_at = now() WHERE s.user_id = v_user AND s.revoked_at IS NULL;
  INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
  VALUES (v_actor, p_tenant, 'student.account.revoked',
          jsonb_build_object('learnerAccountId', v_id, 'learnerId', p_learner, 'userId', v_user));
  RETURN true;
END
$$;
REVOKE ALL ON FUNCTION public.student_account_revoke(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.student_account_revoke(uuid, uuid, text) TO figbloom_app;

-- What the office sees about one learner's login: no password material, ever. P0002 when the learner is not in this school.
CREATE FUNCTION public.student_account_status(p_tenant uuid, p_learner uuid)
RETURNS TABLE (has_login boolean, login_id text, account_status text, must_change_password boolean,
               created_at timestamptz, password_set_at timestamptz, last_sign_in_at timestamptz, revoked_logins integer)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT public.student_account_actor_may_manage(p_tenant) THEN
    RAISE EXCEPTION 'insufficient permissions' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.learners le WHERE le.id = p_learner AND le.tenant_id = p_tenant) THEN
    RAISE EXCEPTION 'learner not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN QUERY
    SELECT (a.id IS NOT NULL), m.login_id, u.status, u.must_change_password, a.created_at, a.password_set_at,
           (SELECT max(s.created_at) FROM public.sessions s WHERE s.user_id = a.user_id),
           (SELECT count(*)::int FROM public.learner_accounts r WHERE r.tenant_id = p_tenant AND r.learner_id = p_learner AND r.revoked_at IS NOT NULL)
      FROM (SELECT 1) one
      LEFT JOIN public.learner_accounts a ON a.tenant_id = p_tenant AND a.learner_id = p_learner AND a.revoked_at IS NULL
      LEFT JOIN public.school_memberships m ON m.user_id = a.user_id AND m.tenant_id = a.tenant_id AND m.archived_at IS NULL
      LEFT JOIN public.users u ON u.id = a.user_id;
END
$$;
REVOKE ALL ON FUNCTION public.student_account_status(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.student_account_status(uuid, uuid) TO figbloom_app;

-- Deactivation (membership archived) revokes the learner's login link in that school, in the database (like 073).
CREATE FUNCTION public.learner_accounts_on_membership_archive() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
    WITH r AS (
      UPDATE public.learner_accounts a SET revoked_at = now(), revoke_reason = 'membership deactivated'
       WHERE a.user_id = NEW.user_id AND a.tenant_id = NEW.tenant_id AND a.revoked_at IS NULL RETURNING a.id, a.learner_id)
    INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
    SELECT public.app_current_user_id(), NEW.tenant_id, 'student.account.revoked',
           jsonb_build_object('learnerAccountId', r.id, 'learnerId', r.learner_id, 'userId', NEW.user_id, 'cause', 'membership_deactivated') FROM r;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION public.learner_accounts_on_membership_archive() FROM PUBLIC;
CREATE TRIGGER learner_accounts_on_membership_archive
  AFTER UPDATE OF archived_at ON public.school_memberships
  FOR EACH ROW EXECUTE FUNCTION public.learner_accounts_on_membership_archive();

-- ---------------------------------------------------------------------------------------------------------------------
-- Session policy (decision 2): a student is timed out like a guardian (30 minutes idle). Staff, organisation and platform
-- accounts keep 15 minutes; an account with any such role keeps the stricter value. Otherwise exactly as in 069.
CREATE OR REPLACE FUNCTION public.auth_session_idle_seconds(p_user_id uuid) RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.platform_roles r WHERE r.user_id = p_user_id)
      OR EXISTS (SELECT 1 FROM public.organization_memberships o WHERE o.user_id = p_user_id)
      OR EXISTS (SELECT 1 FROM public.school_memberships m WHERE m.user_id = p_user_id AND m.archived_at IS NULL AND m.role::text NOT IN ('parent', 'student'))
      THEN 900
    WHEN EXISTS (SELECT 1 FROM public.school_memberships m WHERE m.user_id = p_user_id AND m.archived_at IS NULL AND m.role::text IN ('parent', 'student'))
      THEN 1800
    ELSE 900
  END;
$$;
REVOKE ALL ON FUNCTION public.auth_session_idle_seconds(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.auth_session_idle_seconds(uuid) TO figbloom_app;

-- ---------------------------------------------------------------------------------------------------------------------
-- Announcements: a `class` audience also reaches a student whose own learner has an active membership of that (active)
-- class; a `form_level` audience a student whose learner is in an active current-year class of that level. Everything else
-- is exactly as in 100.
CREATE OR REPLACE FUNCTION public.communications_audience_reaches(p_tenant uuid, p_audience jsonb, p_user uuid) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_role text;
  v_kind text := p_audience->>'kind';
  v_class_id uuid;
  v_form_level integer;
BEGIN
  IF p_audience IS NULL OR p_user IS NULL OR p_tenant IS NULL THEN
    RETURN false;
  END IF;
  IF p_tenant IS DISTINCT FROM public.app_current_tenant_id() THEN
    RAISE EXCEPTION 'cross-tenant audience evaluation refused' USING ERRCODE = '42501';
  END IF;
  IF p_user IS DISTINCT FROM public.app_current_user_id() THEN
    RAISE EXCEPTION 'third-party audience evaluation refused' USING ERRCODE = '42501';
  END IF;

  SELECT m.role::text INTO v_role
    FROM public.school_memberships m
   WHERE m.tenant_id = p_tenant AND m.user_id = p_user AND m.archived_at IS NULL
   LIMIT 1;
  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  IF v_kind = 'whole_school' THEN RETURN true; END IF;
  IF v_kind = 'role' THEN RETURN p_audience->>'role' = v_role; END IF;
  IF v_kind = 'roles' THEN
    RETURN jsonb_typeof(p_audience->'roles') = 'array' AND (p_audience->'roles') ? v_role;
  END IF;
  IF v_kind = 'user' THEN RETURN p_audience->>'user_id' = p_user::text; END IF;
  IF v_kind = 'people' THEN
    RETURN jsonb_typeof(p_audience->'profile_ids') = 'array' AND (p_audience->'profile_ids') ? p_user::text;
  END IF;

  IF v_kind = 'class' THEN
    IF (p_audience->>'class_id') IS NULL
       OR (p_audience->>'class_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN false;
    END IF;
    v_class_id := (p_audience->>'class_id')::uuid;
    IF v_role = 'parent' THEN
      -- 099's rule (p_user is app_current_user_id(), p_tenant is app_current_tenant_id(), both checked above)
      RETURN EXISTS (
        SELECT 1 FROM public.family_my_children() k
          JOIN public.class_memberships cm
            ON cm.tenant_id = p_tenant AND cm.learner_id = k.learner_id AND cm.class_id = v_class_id
           AND cm.active = true AND cm.archived_at IS NULL
          JOIN public.classes c ON c.tenant_id = p_tenant AND c.id = cm.class_id AND c.active = true AND c.archived_at IS NULL
      );
    END IF;
    IF v_role = 'student' THEN
      -- 110's rule (the caller's own live learner)
      RETURN EXISTS (
        SELECT 1 FROM public.student_my_learner() k
          JOIN public.class_memberships cm
            ON cm.tenant_id = p_tenant AND cm.learner_id = k.learner_id AND cm.class_id = v_class_id
           AND cm.active = true AND cm.archived_at IS NULL
          JOIN public.classes c ON c.tenant_id = p_tenant AND c.id = cm.class_id AND c.active = true AND c.archived_at IS NULL
      );
    END IF;
    RETURN EXISTS (
      SELECT 1 FROM public.classes c
       JOIN public.staff_members sm
         ON sm.tenant_id = c.tenant_id
        AND sm.user_id = p_user
        AND sm.active = true
        AND sm.archived_at IS NULL
       WHERE c.tenant_id = p_tenant
         AND c.id = v_class_id
         AND c.active = true
         AND c.archived_at IS NULL
         AND (
           c.class_teacher_staff_id = sm.id
           OR EXISTS (
             SELECT 1 FROM public.teaching_assignments ta
              WHERE ta.tenant_id = p_tenant
                AND ta.class_id = c.id
                AND ta.staff_member_id = sm.id
                AND ta.active = true
           )
         )
    );
  END IF;

  IF v_kind = 'form_level' THEN
    IF jsonb_typeof(p_audience->'form_level') <> 'number'
       OR (p_audience->>'form_level') !~ '^[0-9]+$' THEN
      RETURN false;
    END IF;
    v_form_level := (p_audience->>'form_level')::integer;
    IF v_role = 'parent' THEN
      RETURN EXISTS (
        SELECT 1 FROM public.family_my_children() k
          JOIN public.class_memberships cm
            ON cm.tenant_id = p_tenant AND cm.learner_id = k.learner_id AND cm.active = true AND cm.archived_at IS NULL
          JOIN public.classes c
            ON c.tenant_id = p_tenant AND c.id = cm.class_id AND c.form_level = v_form_level
           AND c.active = true AND c.archived_at IS NULL
          JOIN public.academic_years y ON y.tenant_id = p_tenant AND y.id = cm.academic_year_id AND y.is_current = true
      );
    END IF;
    IF v_role = 'student' THEN
      RETURN EXISTS (
        SELECT 1 FROM public.student_my_learner() k
          JOIN public.class_memberships cm
            ON cm.tenant_id = p_tenant AND cm.learner_id = k.learner_id AND cm.active = true AND cm.archived_at IS NULL
          JOIN public.classes c
            ON c.tenant_id = p_tenant AND c.id = cm.class_id AND c.form_level = v_form_level
           AND c.active = true AND c.archived_at IS NULL
          JOIN public.academic_years y ON y.tenant_id = p_tenant AND y.id = cm.academic_year_id AND y.is_current = true
      );
    END IF;
    RETURN EXISTS (
      SELECT 1 FROM public.classes c
       JOIN public.staff_members sm
         ON sm.tenant_id = c.tenant_id
        AND sm.user_id = p_user
        AND sm.active = true
        AND sm.archived_at IS NULL
       WHERE c.tenant_id = p_tenant
         AND c.form_level = v_form_level
         AND c.active = true
         AND c.archived_at IS NULL
         AND (
           c.class_teacher_staff_id = sm.id
           OR EXISTS (
             SELECT 1 FROM public.teaching_assignments ta
              WHERE ta.tenant_id = p_tenant
                AND ta.class_id = c.id
                AND ta.staff_member_id = sm.id
                AND ta.active = true
           )
         )
    );
  END IF;

  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION public.communications_audience_reaches(uuid, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.communications_audience_reaches(uuid, jsonb, uuid) TO figbloom_app;

-- ---------------------------------------------------------------------------------------------------------------------
-- Chat (decision 3). A student may talk with a school administrator, and with a teacher of their own learner's class (class
-- teacher, or an active teaching assignment, of an active current-year class the learner is an active member of). Nothing
-- else: no student-to-student, no student-to-parent, no other staff. The student's side needs a live login link and an
-- active learner. Staff-to-staff and every parent rule are exactly as in 100.
CREATE OR REPLACE FUNCTION public.may_talk(p_tenant uuid, p_a uuid, p_b uuid) RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_role_a text;
  v_role_b text;
  v_parent uuid;
  v_student uuid;
  v_other uuid;
  v_role text;
  v_learner uuid;
BEGIN
  IF p_tenant IS NULL OR p_a IS NULL OR p_b IS NULL OR p_a = p_b THEN
    RETURN false;
  END IF;
  IF p_tenant IS DISTINCT FROM public.app_current_tenant_id() THEN
    RAISE EXCEPTION 'cross-tenant pairing evaluation refused' USING ERRCODE = '42501';
  END IF;
  IF public.app_current_user_id() IS NULL
     OR (p_a IS DISTINCT FROM public.app_current_user_id() AND p_b IS DISTINCT FROM public.app_current_user_id()) THEN
    RAISE EXCEPTION 'third-party pairing evaluation refused' USING ERRCODE = '42501';
  END IF;

  SELECT m.role::text INTO v_role_a
    FROM public.school_memberships m
   WHERE m.tenant_id = p_tenant AND m.user_id = p_a AND m.archived_at IS NULL;
  SELECT m.role::text INTO v_role_b
    FROM public.school_memberships m
   WHERE m.tenant_id = p_tenant AND m.user_id = p_b AND m.archived_at IS NULL;
  IF v_role_a IS NULL OR v_role_b IS NULL THEN
    RETURN false;
  END IF;

  IF v_role_a IN ('school_admin', 'teacher', 'driver', 'staff')
     AND v_role_b IN ('school_admin', 'teacher', 'driver', 'staff') THEN
    RETURN true;
  END IF;

  IF v_role_a = 'parent' OR v_role_b = 'parent' THEN
    IF v_role_a = 'parent' THEN
      v_parent := p_a; v_other := p_b; v_role := v_role_b;
    ELSE
      v_parent := p_b; v_other := p_a; v_role := v_role_a;
    END IF;

    IF v_role = 'school_admin' THEN
      RETURN true;
    END IF;

    -- A parent and a teacher of one of their children. Either may be the caller, so the parent's links are read here for
    -- v_parent (the same conditions as family_my_children()), not through app_current_user_id().
    IF v_role = 'teacher' THEN
      RETURN EXISTS (
        SELECT 1
          FROM public.guardian_accounts ga
          JOIN public.users u ON u.id = ga.user_id AND u.status = 'active'
          JOIN public.guardians g
            ON g.id = ga.guardian_id AND g.tenant_id = ga.tenant_id AND g.active IS TRUE AND g.archived_at IS NULL
          JOIN public.guardian_links gl
            ON gl.guardian_id = ga.guardian_id AND gl.tenant_id = ga.tenant_id AND gl.archived_at IS NULL
          JOIN public.learners le
            ON le.id = gl.learner_id AND le.tenant_id = gl.tenant_id AND le.active IS TRUE AND le.archived_at IS NULL
          JOIN public.class_memberships cm
            ON cm.tenant_id = p_tenant AND cm.learner_id = le.id AND cm.active IS TRUE AND cm.archived_at IS NULL
          JOIN public.classes c
            ON c.tenant_id = p_tenant AND c.id = cm.class_id AND c.active IS TRUE AND c.archived_at IS NULL
          JOIN public.academic_years y ON y.tenant_id = p_tenant AND y.id = cm.academic_year_id AND y.is_current IS TRUE
          JOIN public.staff_members sm
            ON sm.tenant_id = p_tenant AND sm.user_id = v_other AND sm.active IS TRUE AND sm.archived_at IS NULL
         WHERE ga.user_id = v_parent AND ga.tenant_id = p_tenant AND ga.revoked_at IS NULL
           AND (c.class_teacher_staff_id = sm.id
                OR EXISTS (SELECT 1 FROM public.teaching_assignments ta
                            WHERE ta.tenant_id = p_tenant AND ta.class_id = c.id AND ta.staff_member_id = sm.id AND ta.active IS TRUE))
      );
    END IF;

    RETURN false;
  END IF;

  IF v_role_a = 'student' OR v_role_b = 'student' THEN
    IF v_role_a = 'student' AND v_role_b = 'student' THEN
      RETURN false;
    END IF;
    IF v_role_a = 'student' THEN
      v_student := p_a; v_other := p_b; v_role := v_role_b;
    ELSE
      v_student := p_b; v_other := p_a; v_role := v_role_a;
    END IF;
    IF v_role NOT IN ('school_admin', 'teacher') THEN
      RETURN false;
    END IF;
    -- The student's own live learner (the same conditions as student_my_learner(), read for v_student: either side may be
    -- the caller).
    SELECT la.learner_id INTO v_learner
      FROM public.learner_accounts la
      JOIN public.users u ON u.id = la.user_id AND u.status = 'active'
      JOIN public.school_memberships sm2
        ON sm2.user_id = la.user_id AND sm2.tenant_id = la.tenant_id AND sm2.archived_at IS NULL AND sm2.role::text = 'student'
      JOIN public.learners le
        ON le.id = la.learner_id AND le.tenant_id = la.tenant_id AND le.active IS TRUE AND le.archived_at IS NULL
     WHERE la.user_id = v_student AND la.tenant_id = p_tenant AND la.revoked_at IS NULL;
    IF v_learner IS NULL THEN
      RETURN false;
    END IF;
    IF v_role = 'school_admin' THEN
      RETURN true;
    END IF;
    RETURN EXISTS (
      SELECT 1
        FROM public.class_memberships cm
        JOIN public.classes c
          ON c.tenant_id = p_tenant AND c.id = cm.class_id AND c.active IS TRUE AND c.archived_at IS NULL
        JOIN public.academic_years y ON y.tenant_id = p_tenant AND y.id = cm.academic_year_id AND y.is_current IS TRUE
        JOIN public.staff_members sm
          ON sm.tenant_id = p_tenant AND sm.user_id = v_other AND sm.active IS TRUE AND sm.archived_at IS NULL
       WHERE cm.tenant_id = p_tenant AND cm.learner_id = v_learner AND cm.active IS TRUE AND cm.archived_at IS NULL
         AND (c.class_teacher_staff_id = sm.id
              OR EXISTS (SELECT 1 FROM public.teaching_assignments ta
                          WHERE ta.tenant_id = p_tenant AND ta.class_id = c.id AND ta.staff_member_id = sm.id AND ta.active IS TRUE))
    );
  END IF;

  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION public.may_talk(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.may_talk(uuid, uuid, uuid) TO figbloom_app;

-- ---------------------------------------------------------------------------------------------------------------------
-- Online exams (decision 4): a learner sees a paper only once a teacher publishes it. Existing papers stay unpublished.
ALTER TABLE public.online_exam_papers ADD COLUMN published_at timestamptz;
GRANT UPDATE (published_at) ON public.online_exam_papers TO figbloom_app;

-- A learner who pays their own fees sends a proof as 'learner' (decision 4).
ALTER TABLE public.finance_payment_proofs DROP CONSTRAINT finance_payment_proofs_via_chk;
ALTER TABLE public.finance_payment_proofs
  ADD CONSTRAINT finance_payment_proofs_via_chk CHECK (submitted_via IN ('office', 'guardian', 'learner'));
