-- Stage 12–13 security definer oracle hardening, user-level restrictive RLS, gate visits & sick bay integrity (S12-01..S12-10, S12-12, S13-11, S13-02). Forward-only.
--
-- 1) S12-01: Bind communications_audience_reaches(uuid, jsonb, uuid) and may_talk(uuid, uuid, uuid)
--    to app_current_tenant_id() and app_current_user_id() so figbloom_app cannot probe cross-tenant
--    memberships or enumerate third-party user role pairs. Also resolve class and form_level audiences
--    for assigned teachers (S12-08) while learner/guardian account-linked reach remains deferred (OD-F1).
-- 2) S13-11 & S13-02: Convert inventory_out_count(uuid) to SECURITY INVOKER so RLS on inventory_issues
--    enforces tenant isolation for figbloom_app, and count status IN ('out', 'lost', 'damaged') so
--    lost/damaged stock does not return to the available pool.
-- 3) S12-02: Add AS RESTRICTIVE user-level RLS policies for figbloom_app on conversations,
--    conversation_members, chat_messages (including WITH CHECK sender_id = app_current_user_id()),
--    medical_notices, and communications_announcement_reads.
-- 4) S12-04: Add row_version and correction_reason to sick_bay_visits, enforce discharge finality
--    (time_out IS NOT NULL) unless correction_reason is supplied, and increment row_version on update.
-- 5) S12-07: Narrow gate_visits UPDATE column grants on figbloom_app to operational status/timestamp
--    columns, add explicit CHECK constraints, and fix gate_visits_learner_fk to ON DELETE SET NULL (learner_id).
-- 6) S12-10 & S12-12: Audit cross-user device token reclamation in device_tokens_register, and add
--    worker-only communications_announcement_push_eligible_count(uuid) consulting notification_preferences.

-- ---------------------------------------------------------------------------
-- 1. S12-01 & S12-08: communications_audience_reaches(uuid, jsonb, uuid)
-- ---------------------------------------------------------------------------
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

  -- S12-08: class and form_level resolve for assigned teachers (classes.class_teacher_staff_id or
  -- teaching_assignments.staff_member_id via staff_members.user_id). Learner/parent account-linked
  -- reach remains deferred until OD-F1 user_id linking.
  IF v_kind = 'class' THEN
    IF (p_audience->>'class_id') IS NULL
       OR (p_audience->>'class_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN false;
    END IF;
    v_class_id := (p_audience->>'class_id')::uuid;
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

-- ---------------------------------------------------------------------------
-- 2. S12-01: may_talk(uuid, uuid, uuid)
-- ---------------------------------------------------------------------------
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
  v_other uuid;
  v_role text;
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

  IF v_role_a = 'parent' THEN
    v_parent := p_a; v_other := p_b; v_role := v_role_b;
  ELSIF v_role_b = 'parent' THEN
    v_parent := p_b; v_other := p_a; v_role := v_role_a;
  ELSE
    RETURN false;
  END IF;

  IF v_role = 'school_admin' THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$;
REVOKE ALL ON FUNCTION public.may_talk(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.may_talk(uuid, uuid, uuid) TO figbloom_app;

-- ---------------------------------------------------------------------------
-- 3. S13-11 & S13-02: inventory_out_count(uuid) -> SECURITY INVOKER + lost/damaged accounting
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.inventory_out_count(p_item uuid) RETURNS integer
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(sum(quantity), 0)::int
    FROM public.inventory_issues
   WHERE item_id = p_item
     AND status IN ('out', 'lost', 'damaged');
$$;
REVOKE ALL ON FUNCTION public.inventory_out_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.inventory_out_count(uuid) TO figbloom_app;

-- ---------------------------------------------------------------------------
-- 4. S12-02: User-level AS RESTRICTIVE RLS policies on chat, medical notices & reads
-- ---------------------------------------------------------------------------
ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_created_by_in_pair_chk CHECK (
    created_by IS NULL
    OR split_part(pair_key, ':', 1) = created_by::text
    OR split_part(pair_key, ':', 2) = created_by::text
  );

CREATE POLICY conversations_user_scope ON public.conversations
  AS RESTRICTIVE FOR ALL TO figbloom_app
  USING (
    split_part(pair_key, ':', 1) = public.app_current_user_id()::text
    OR split_part(pair_key, ':', 2) = public.app_current_user_id()::text
  )
  WITH CHECK (
    split_part(pair_key, ':', 1) = public.app_current_user_id()::text
    OR split_part(pair_key, ':', 2) = public.app_current_user_id()::text
  );

CREATE POLICY conversation_members_user_scope ON public.conversation_members
  AS RESTRICTIVE FOR ALL TO figbloom_app
  USING (
    EXISTS (
      SELECT 1 FROM public.conversations c
       WHERE c.id = conversation_members.conversation_id
         AND c.tenant_id = conversation_members.tenant_id
         AND (
           split_part(c.pair_key, ':', 1) = public.app_current_user_id()::text
           OR split_part(c.pair_key, ':', 2) = public.app_current_user_id()::text
         )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.conversations c
       WHERE c.id = conversation_members.conversation_id
         AND c.tenant_id = conversation_members.tenant_id
         AND (
           split_part(c.pair_key, ':', 1) = public.app_current_user_id()::text
           OR split_part(c.pair_key, ':', 2) = public.app_current_user_id()::text
         )
         AND (
           split_part(c.pair_key, ':', 1) = conversation_members.user_id::text
           OR split_part(c.pair_key, ':', 2) = conversation_members.user_id::text
         )
    )
  );

CREATE POLICY conversation_members_update_own ON public.conversation_members
  AS RESTRICTIVE FOR UPDATE TO figbloom_app
  USING (user_id = public.app_current_user_id())
  WITH CHECK (user_id = public.app_current_user_id());

CREATE POLICY chat_messages_user_scope ON public.chat_messages
  AS RESTRICTIVE FOR ALL TO figbloom_app
  USING (
    EXISTS (
      SELECT 1 FROM public.conversation_members cm
       WHERE cm.conversation_id = chat_messages.conversation_id
         AND cm.tenant_id = chat_messages.tenant_id
         AND cm.user_id = public.app_current_user_id()
    )
  )
  WITH CHECK (
    sender_id = public.app_current_user_id()
    AND EXISTS (
      SELECT 1 FROM public.conversation_members cm
       WHERE cm.conversation_id = chat_messages.conversation_id
         AND cm.tenant_id = chat_messages.tenant_id
         AND cm.user_id = public.app_current_user_id()
    )
  );

CREATE POLICY medical_notices_user_scope ON public.medical_notices
  AS RESTRICTIVE FOR ALL TO figbloom_app
  USING (guardian_user_id = public.app_current_user_id())
  WITH CHECK (guardian_user_id = public.app_current_user_id());

CREATE POLICY communications_announcement_reads_user_scope ON public.communications_announcement_reads
  AS RESTRICTIVE FOR ALL TO figbloom_app
  USING (user_id = public.app_current_user_id())
  WITH CHECK (user_id = public.app_current_user_id());

-- ---------------------------------------------------------------------------
-- 5. S12-04: Sick bay row_version, discharge finality & correction_reason
-- ---------------------------------------------------------------------------
ALTER TABLE public.sick_bay_visits
  ADD COLUMN row_version integer NOT NULL DEFAULT 1,
  ADD COLUMN correction_reason text,
  ADD CONSTRAINT sick_bay_visits_row_version_chk CHECK (row_version >= 1),
  ADD CONSTRAINT sick_bay_visits_correction_reason_chk CHECK (
    correction_reason IS NULL OR char_length(btrim(correction_reason)) BETWEEN 3 AND 500
  ),
  ADD CONSTRAINT sick_bay_visits_hospital_referral_chk CHECK (
    outcome IS DISTINCT FROM 'hospital'
    OR (referred_to IS NOT NULL AND char_length(btrim(referred_to)) >= 1)
  );

CREATE OR REPLACE FUNCTION public.sick_bay_visits_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.row_version := 1;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.learner_id IS DISTINCT FROM OLD.learner_id
       OR NEW.logged_by IS DISTINCT FROM OLD.logged_by OR NEW.time_in IS DISTINCT FROM OLD.time_in THEN
      RAISE EXCEPTION 'sick bay visit identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.time_out IS NOT NULL THEN
      IF NEW.time_out IS NULL THEN
        RAISE EXCEPTION 'a discharged sick bay visit cannot be reopened' USING ERRCODE = '23514';
      END IF;
      IF NEW.correction_reason IS NULL OR char_length(btrim(NEW.correction_reason)) < 3 THEN
        RAISE EXCEPTION 'a discharged sick bay visit is final; correction_reason is required' USING ERRCODE = '23514';
      END IF;
      NEW.correction_reason := btrim(NEW.correction_reason);
    END IF;
    NEW.row_version := OLD.row_version + 1;
  END IF;
  NEW.complaint := btrim(NEW.complaint);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sick_bay_visits_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sick_bay_visits_guard() FROM figbloom_app;

GRANT UPDATE (row_version, correction_reason) ON public.sick_bay_visits TO figbloom_app;

-- ---------------------------------------------------------------------------
-- 6. S12-07: gate_visits narrow UPDATE grants, explicit CHECKs & composite FK fix
-- ---------------------------------------------------------------------------
ALTER TABLE public.gate_visits DROP CONSTRAINT gate_visits_learner_fk;
ALTER TABLE public.gate_visits
  ADD CONSTRAINT gate_visits_learner_fk
  FOREIGN KEY (learner_id, tenant_id) REFERENCES public.learners (id, tenant_id)
  ON DELETE SET NULL (learner_id);

ALTER TABLE public.gate_visits
  ADD CONSTRAINT gate_visits_host_target_chk CHECK (
    (host_kind = 'teacher' AND host_user_id IS NOT NULL AND learner_id IS NULL)
    OR (host_kind = 'learner' AND learner_id IS NOT NULL AND host_user_id IS NULL)
    OR (host_kind IN ('office', 'principal') AND host_user_id IS NULL AND learner_id IS NULL)
  ),
  ADD CONSTRAINT gate_visits_status_timestamps_chk CHECK (
    (status <> 'left' OR left_at IS NOT NULL)
    AND (reception_at IS NULL OR reception_at >= arrived_at)
    AND (with_host_at IS NULL OR with_host_at >= arrived_at)
    AND (left_at IS NULL OR left_at >= arrived_at)
  );

REVOKE UPDATE ON public.gate_visits FROM figbloom_app;
GRANT UPDATE (
  status, note, escalated, escalated_at,
  reception_at, with_host_at, left_at,
  host_notified_at, escalation_notified_at, updated_at
) ON public.gate_visits TO figbloom_app;

-- ---------------------------------------------------------------------------
-- 7. S12-10: device_tokens_register cross-user reclamation audit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.device_tokens_register(p_user uuid, p_token text, p_platform text) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_prev_user uuid;
BEGIN
  IF p_user IS NULL OR p_user IS DISTINCT FROM public.app_current_user_id() THEN
    RAISE EXCEPTION 'device token registration requires the signed-in user' USING ERRCODE = '42501';
  END IF;
  IF p_platform NOT IN ('android', 'ios') THEN
    RAISE EXCEPTION 'invalid platform' USING ERRCODE = '22023';
  END IF;
  SELECT user_id INTO v_prev_user FROM public.device_tokens WHERE token = p_token;
  DELETE FROM public.device_tokens WHERE token = p_token;
  INSERT INTO public.device_tokens (user_id, token, platform)
  VALUES (p_user, p_token, p_platform)
  RETURNING id INTO v_id;
  IF v_prev_user IS NOT NULL AND v_prev_user IS DISTINCT FROM p_user THEN
    INSERT INTO public.security_audit_events (actor_user_id, tenant_id, event_type, detail)
    VALUES (
      p_user,
      NULL,
      'communications.device_token.reclaimed',
      jsonb_build_object('deviceTokenId', v_id, 'previousUserId', v_prev_user, 'platform', p_platform)
    );
  END IF;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.device_tokens_register(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.device_tokens_register(uuid, text, text) TO figbloom_app;

-- ---------------------------------------------------------------------------
-- 8. S12-12: Worker-only announcement push preference eligibility counter
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.communications_announcement_push_eligible_count(p_announcement_id uuid) RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant uuid := public.app_current_tenant_id();
  v_audience jsonb;
  v_kind text;
  v_count integer := 0;
BEGIN
  IF session_user <> 'figbloom_worker' OR v_tenant IS NULL THEN
    RAISE EXCEPTION 'push eligibility count requires worker session and tenant context' USING ERRCODE = '42501';
  END IF;
  SELECT a.audience INTO v_audience
    FROM public.communications_announcements a
   WHERE a.tenant_id = v_tenant AND a.id = p_announcement_id AND a.published_at IS NOT NULL;
  IF v_audience IS NULL THEN
    RETURN 0;
  END IF;
  v_kind := v_audience->>'kind';
  SELECT count(*)::int INTO v_count
    FROM public.school_memberships m
    LEFT JOIN public.notification_preferences np ON np.user_id = m.user_id
   WHERE m.tenant_id = v_tenant
     AND m.archived_at IS NULL
     AND coalesce(np.general_notices, false) = true
     AND (
       v_kind = 'whole_school'
       OR (v_kind = 'role' AND m.role::text = v_audience->>'role')
       OR (v_kind = 'roles' AND jsonb_typeof(v_audience->'roles') = 'array' AND (v_audience->'roles') ? m.role::text)
       OR (v_kind = 'user' AND m.user_id::text = v_audience->>'user_id')
       OR (v_kind = 'people' AND jsonb_typeof(v_audience->'profile_ids') = 'array' AND (v_audience->'profile_ids') ? m.user_id::text)
     );
  RETURN v_count;
END;
$$;
REVOKE ALL ON FUNCTION public.communications_announcement_push_eligible_count(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.communications_announcement_push_eligible_count(uuid) FROM figbloom_app;
GRANT EXECUTE ON FUNCTION public.communications_announcement_push_eligible_count(uuid) TO figbloom_worker;
