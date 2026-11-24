-- 100: family reach for announcements and chat (A1, FIG-1869). Forward-only; 001-099 untouched. Design: docs/FAMILY-READS.md.
--
-- Migration 063 left "learner/guardian account-linked reach deferred (OD-F1)". The account link exists since 073 and the
-- "my child" rule since 099, so:
--   1) communications_audience_reaches: a `class` audience also reaches a parent whose child has an active membership of
--      that (active) class; a `form_level` audience a parent whose child is in an active current-year class of that
--      level. Every other kind, and staff reach, are exactly as in 063.
--   2) may_talk: a parent may also talk with a teacher who teaches one of their children (class teacher or an active
--      teaching assignment of an active current-year class the child is an active member of). Staff-to-staff and
--      parent-to-administrator are exactly as in 063; parent-to-parent and everything else stays refused.
-- Both keep 063's bindings: the tenant must be app_current_tenant_id() and the caller one of the users asked about.

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
END;
$$;
REVOKE ALL ON FUNCTION public.may_talk(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.may_talk(uuid, uuid, uuid) TO figbloom_app;
