-- 099: family reads (A1, FIG-1869). Forward-only; 001-098 untouched. Design: docs/FAMILY-READS.md.
--
-- A parent reads the records of the learners they are linked to. "Linked" is decided in ONE place, the definer function
-- below, because guardian_accounts is owner-only. Every per-child endpoint asks it on every request; nothing is cached.
-- No table is created and no table grant is widened: the reads use tables the runtime role already reads under the forced
-- tenant policy, filtered by the learner this function verified.

INSERT INTO permissions (code, description) VALUES
  ('resource.family.read', 'Read the records of own linked children (attendance, results, report cards, homework, timetable, fees, activities, items, health)')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role, permission_code) VALUES
  ('parent', 'resource.family.read'),
  -- platform super administrators hold every catalogued permission; they have no parent membership, so no children
  ('super_admin', 'resource.family.read')
ON CONFLICT DO NOTHING;

-- The calling account's children in the school of the request. All of these must hold, now:
--   * a live account link (guardian_accounts.revoked_at IS NULL) for this user in this school;
--   * the account is active, and is a parent member (not archived) of this school, which is not suspended;
--   * the guardian record is active, the guardian-learner relationship is live, and the learner is active.
-- No argument: the user and the school come from the transaction settings the API sets after authorising the request,
-- so nobody can ask about another account. One row per learner (a learner reached through two guardian records of the
-- same account gives the primary-payer link, then the oldest).
CREATE FUNCTION public.family_my_children()
RETURNS TABLE (learner_id uuid, guardian_id uuid, relationship text, is_primary_payer boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT DISTINCT ON (gl.learner_id) gl.learner_id, gl.guardian_id, gl.relationship, gl.is_primary_payer
    FROM public.guardian_accounts ga
    JOIN public.users u ON u.id = ga.user_id AND u.status = 'active'
    JOIN public.tenants t ON t.id = ga.tenant_id AND t.status <> 'suspended'
    JOIN public.school_memberships m
      ON m.user_id = ga.user_id AND m.tenant_id = ga.tenant_id AND m.archived_at IS NULL AND m.role::text = 'parent'
    JOIN public.guardians g
      ON g.id = ga.guardian_id AND g.tenant_id = ga.tenant_id AND g.active IS TRUE AND g.archived_at IS NULL
    JOIN public.guardian_links gl
      ON gl.guardian_id = ga.guardian_id AND gl.tenant_id = ga.tenant_id AND gl.archived_at IS NULL
    JOIN public.learners le
      ON le.id = gl.learner_id AND le.tenant_id = gl.tenant_id AND le.active IS TRUE AND le.archived_at IS NULL
   WHERE ga.user_id = public.app_current_user_id()
     AND ga.tenant_id = public.app_current_tenant_id()
     AND ga.revoked_at IS NULL
   ORDER BY gl.learner_id, gl.is_primary_payer DESC, gl.created_at, gl.id
$$;
REVOKE ALL ON FUNCTION public.family_my_children() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.family_my_children() TO figbloom_app;
