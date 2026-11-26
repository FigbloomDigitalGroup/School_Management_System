-- 119: the notice to the family when a serious behaviour entry is recorded (docs/BEHAVIOUR.md, S2b). Forward-only; 001-118 untouched.
--
-- guardian_accounts is owner-only (migration 073), so the runtime role cannot read which accounts belong to a learner's
-- guardians. This one narrow definer function answers exactly one question: which parent accounts should be told about THIS entry.
-- It returns nothing unless every one of these holds, decided inside the database so no route can widen it by mistake:
--   * there is a school and a signed-in account in the request (app_current_tenant_id, app_current_user_id), and the entry is
--     this school's;
--   * the caller IS the person who recorded the entry, and recorded it in the last 10 minutes (so it answers "whom do I tell
--     about the entry I just wrote", never "who are this learner's guardians");
--   * the entry is serious and not voided, and the school lets families see that kind of entry (parents_see_demerits for a
--     demerit, parents_see_incidents for an incident; a merit is never a notice);
-- and then returns only the opaque account ids (no name, no contact) of parent accounts that are live by the same rule as
-- family_my_children(): a live account link, an active account, a parent membership of this school, an active guardian record, a
-- live guardian-learner relationship, an active learner, a school that is not suspended.

CREATE FUNCTION public.behaviour_notice_family_users(p_entry uuid)
RETURNS TABLE (user_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_tenant  uuid := public.app_current_tenant_id();
  v_actor   uuid := public.app_current_user_id();
  v_learner uuid;
  v_kind    text;
BEGIN
  IF v_tenant IS NULL OR v_actor IS NULL THEN
    RAISE EXCEPTION 'behaviour_notice_family_users requires an authenticated school context' USING ERRCODE = '42501';
  END IF;
  SELECT e.learner_id, e.kind INTO v_learner, v_kind
    FROM public.behaviour_entries e
   WHERE e.id = p_entry AND e.tenant_id = v_tenant
     AND e.recorded_by = v_actor
     AND e.voided_at IS NULL
     AND e.severity = 'serious'
     AND e.created_at > now() - interval '10 minutes';
  IF NOT FOUND THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.behaviour_settings s
                  WHERE s.tenant_id = v_tenant
                    AND ((v_kind = 'demerit' AND s.parents_see_demerits) OR (v_kind = 'incident' AND s.parents_see_incidents))) THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT DISTINCT ga.user_id
      FROM public.guardian_links gl
      JOIN public.guardians g ON g.id = gl.guardian_id AND g.tenant_id = gl.tenant_id AND g.active IS TRUE AND g.archived_at IS NULL
      JOIN public.guardian_accounts ga ON ga.guardian_id = gl.guardian_id AND ga.tenant_id = gl.tenant_id AND ga.revoked_at IS NULL
      JOIN public.users u ON u.id = ga.user_id AND u.status = 'active'
      JOIN public.tenants t ON t.id = ga.tenant_id AND t.status <> 'suspended'
      JOIN public.school_memberships m
        ON m.user_id = ga.user_id AND m.tenant_id = ga.tenant_id AND m.archived_at IS NULL AND m.role::text = 'parent'
      JOIN public.learners le ON le.id = gl.learner_id AND le.tenant_id = gl.tenant_id AND le.active IS TRUE AND le.archived_at IS NULL
     WHERE gl.tenant_id = v_tenant AND gl.learner_id = v_learner AND gl.archived_at IS NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.behaviour_notice_family_users(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.behaviour_notice_family_users(uuid) TO figbloom_app;
