-- Post-remediation audit (N-4, N-5, N-7). Forward-only; 001–065 are historical and untouched.
--
-- N-4 sick-bay discharge finality. 063 let a stale correction_reason (kept on the row after the first correction)
--   satisfy the guard for every later edit. A correction is now a per-statement act:
--     * the reason must be supplied IN THE STATEMENT (>= 3 chars) for every update of a discharged visit;
--     * the guard records it, with the acting user (app_current_user_id()), in the append-only
--       sick_bay_visit_corrections table, then CLEARS the row's column, so nothing can go stale;
--     * a discharged visit still cannot be reopened and its identity is immutable.
-- N-5 gate visits. ON DELETE SET NULL (learner_id) collided with gate_visits_host_target_chk and with the stamp
--   trigger, so an eligible learner could not be deleted. The visit already snapshots learner_name; the visit is a
--   historical record and keeps it. A learner-hosted visit may therefore carry learner_id NULL when the snapshot
--   name remains. Same-tenant references are still enforced by the composite FK; every other host/learner
--   combination stays invalid.
-- N-7 medical_notices. The RESTRICTIVE ALL policy on guardian_user_id blocked any staff INSERT. It is split: the
--   guardian reads/marks-read only their own notices; a notice may be INSERTED only by a staff member of the tenant
--   for a parent member of the same tenant.

-- ---------------------------------------------------------------------------------------------------------
-- N-4
CREATE TABLE public.sick_bay_visit_corrections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,
  visit_id      uuid NOT NULL,
  row_version   integer NOT NULL,
  reason        text NOT NULL,
  corrected_by  uuid REFERENCES public.users (id) ON DELETE SET NULL,
  corrected_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sick_bay_visit_corrections_visit_fk FOREIGN KEY (visit_id, tenant_id)
    REFERENCES public.sick_bay_visits (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT sick_bay_visit_corrections_reason_chk CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500)
);
CREATE INDEX sick_bay_visit_corrections_visit_idx ON public.sick_bay_visit_corrections (tenant_id, visit_id, corrected_at);
ALTER TABLE public.sick_bay_visit_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sick_bay_visit_corrections FORCE ROW LEVEL SECURITY;
-- FOR ALL keeps the tenant predicate uniform; append-only is enforced by the grants (SELECT only for the app).
CREATE POLICY sick_bay_visit_corrections_tenant ON public.sick_bay_visit_corrections FOR ALL TO figbloom_app
  USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id());
CREATE POLICY sick_bay_visit_corrections_owner ON public.sick_bay_visit_corrections FOR ALL TO PUBLIC
  USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                          WHERE n.nspname = 'public' AND c.relname = 'sick_bay_visit_corrections'))
  WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                               WHERE n.nspname = 'public' AND c.relname = 'sick_bay_visit_corrections'));
-- Append-only: the application can read history, never write it directly.
REVOKE ALL ON public.sick_bay_visit_corrections FROM PUBLIC;
GRANT SELECT ON public.sick_bay_visit_corrections TO figbloom_app;

CREATE OR REPLACE FUNCTION public.sick_bay_visits_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_reason text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.row_version := 1;
    NEW.correction_reason := NULL;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.learner_id IS DISTINCT FROM OLD.learner_id
       OR NEW.logged_by IS DISTINCT FROM OLD.logged_by OR NEW.time_in IS DISTINCT FROM OLD.time_in THEN
      RAISE EXCEPTION 'sick bay visit identity is immutable' USING ERRCODE = '23514';
    END IF;
    IF OLD.time_out IS NOT NULL THEN
      IF NEW.time_out IS NULL THEN
        RAISE EXCEPTION 'a discharged sick bay visit cannot be reopened' USING ERRCODE = '23514';
      END IF;
      IF OLD.correction_reason IS NOT NULL AND NEW.correction_reason IS NOT DISTINCT FROM OLD.correction_reason THEN
        RAISE EXCEPTION 'a stale correction_reason cannot authorise another correction' USING ERRCODE = '23514';
      END IF;
      v_reason := btrim(coalesce(NEW.correction_reason, ''));
      IF char_length(v_reason) < 3 THEN
        RAISE EXCEPTION 'a discharged sick bay visit is final; a correction_reason is required in every correcting statement' USING ERRCODE = '23514';
      END IF;
      IF public.app_current_user_id() IS NULL THEN
        RAISE EXCEPTION 'a correction must be attributable to a signed-in user' USING ERRCODE = '42501';
      END IF;
      INSERT INTO public.sick_bay_visit_corrections (tenant_id, visit_id, row_version, reason, corrected_by)
      VALUES (OLD.tenant_id, OLD.id, OLD.row_version + 1, v_reason, public.app_current_user_id());
    END IF;
    -- The reason is consumed: it lives in the correction history, never on the row, so it cannot go stale.
    NEW.correction_reason := NULL;
    NEW.row_version := OLD.row_version + 1;
  END IF;
  NEW.complaint := btrim(NEW.complaint);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.sick_bay_visits_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sick_bay_visits_guard() FROM figbloom_app;

-- Legacy rows (063/064) still carry the reason of their last correction on the row. Preserve it as history, then clear it
-- so it cannot authorise anything (the trigger is bypassed only for this one-off data fix, inside this migration).
INSERT INTO public.sick_bay_visit_corrections (tenant_id, visit_id, row_version, reason, corrected_by, corrected_at)
SELECT v.tenant_id, v.id, v.row_version, btrim(v.correction_reason), NULL, v.updated_at
  FROM public.sick_bay_visits v WHERE v.correction_reason IS NOT NULL;
ALTER TABLE public.sick_bay_visits DISABLE TRIGGER sick_bay_visits_guard;
UPDATE public.sick_bay_visits SET correction_reason = NULL WHERE correction_reason IS NOT NULL;
ALTER TABLE public.sick_bay_visits ENABLE TRIGGER sick_bay_visits_guard;

-- ---------------------------------------------------------------------------------------------------------
-- N-5
ALTER TABLE public.gate_visits DROP CONSTRAINT gate_visits_host_target_chk;
ALTER TABLE public.gate_visits ADD CONSTRAINT gate_visits_host_target_chk CHECK (
  (host_kind = 'teacher' AND host_user_id IS NOT NULL AND learner_id IS NULL)
  OR (host_kind = 'learner' AND host_user_id IS NULL AND (learner_id IS NOT NULL OR learner_name IS NOT NULL))
  OR (host_kind IN ('office', 'principal') AND host_user_id IS NULL AND learner_id IS NULL)
);

CREATE OR REPLACE FUNCTION public.gate_visits_stamp() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_host_name text;
  v_host_role text;
  v_learner_name text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'A visit cannot be moved to another school' USING ERRCODE = '42501';
  END IF;

  NEW.visitor_name := btrim(NEW.visitor_name);
  NEW.purpose := btrim(NEW.purpose);

  IF NEW.host_kind = 'teacher' THEN
    IF TG_OP = 'INSERT' OR NEW.host_user_id IS DISTINCT FROM OLD.host_user_id OR OLD.host_kind IS DISTINCT FROM 'teacher' THEN
      SELECT u.full_name, m.role::text INTO v_host_name, v_host_role
        FROM public.users u
        JOIN public.school_memberships m ON m.user_id = u.id AND m.tenant_id = NEW.tenant_id AND m.archived_at IS NULL
       WHERE u.id = NEW.host_user_id AND u.status = 'active';
      IF v_host_name IS NULL OR v_host_role NOT IN ('teacher', 'school_admin') THEN
        RAISE EXCEPTION 'Pick a member of staff at this school' USING ERRCODE = '22023';
      END IF;
      NEW.host_name := v_host_name;
    END IF;
  ELSE
    NEW.host_user_id := NULL;
    NEW.host_name := CASE NEW.host_kind
      WHEN 'office' THEN 'the office'
      WHEN 'principal' THEN 'the principal'
      ELSE NULL
    END;
  END IF;

  IF NEW.host_kind = 'learner' THEN
    IF TG_OP = 'UPDATE' AND NEW.learner_id IS NULL AND OLD.learner_id IS NOT NULL AND OLD.host_kind = 'learner'
       AND OLD.learner_name IS NOT NULL THEN
      -- The learner row was removed (FK ON DELETE SET NULL): keep the visit as history with its name snapshot.
      NEW.learner_name := OLD.learner_name;
    ELSIF TG_OP = 'INSERT' OR NEW.learner_id IS DISTINCT FROM OLD.learner_id OR OLD.host_kind IS DISTINCT FROM 'learner' THEN
      SELECT l.full_name INTO v_learner_name
        FROM public.learners l
       WHERE l.id = NEW.learner_id AND l.tenant_id = NEW.tenant_id AND l.archived_at IS NULL;
      IF v_learner_name IS NULL THEN
        RAISE EXCEPTION 'Pick a learner at this school' USING ERRCODE = '22023';
      END IF;
      NEW.learner_name := v_learner_name;
    END IF;
  ELSE
    NEW.learner_id := NULL;
    NEW.learner_name := NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.arrived_at := now();
    NEW.escalated_at := NULL;
    NEW.escalated := (NEW.host_kind = 'principal');
    IF NEW.escalated THEN NEW.escalated_at := now(); END IF;
    IF NEW.entry_point = 'reception' AND NEW.status = 'expected' THEN
      NEW.status := 'at_reception';
      NEW.reception_at := now();
    END IF;
  ELSE
    NEW.recorded_by := OLD.recorded_by;
    NEW.arrived_at := OLD.arrived_at;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      IF OLD.status = 'left' THEN
        RAISE EXCEPTION 'A signed-out visit is final' USING ERRCODE = '23514';
      END IF;
      IF NEW.status = 'at_reception' AND OLD.status = 'expected' THEN
        NEW.reception_at := coalesce(NEW.reception_at, now());
      ELSIF NEW.status = 'with_host' AND OLD.status IN ('expected', 'at_reception') THEN
        NEW.with_host_at := coalesce(NEW.with_host_at, now());
        NEW.reception_at := coalesce(NEW.reception_at, OLD.reception_at, now());
      ELSIF NEW.status = 'left' AND OLD.status IN ('expected', 'at_reception', 'with_host') THEN
        NEW.left_at := coalesce(NEW.left_at, now());
      ELSE
        RAISE EXCEPTION 'Invalid visit status transition' USING ERRCODE = '23514';
      END IF;
    END IF;
    IF NEW.host_kind = 'principal' AND NOT OLD.escalated THEN
      NEW.escalated := true;
      NEW.escalated_at := coalesce(NEW.escalated_at, now());
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.gate_visits_stamp() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.gate_visits_stamp() FROM figbloom_app;

-- ---------------------------------------------------------------------------------------------------------
-- N-7
DROP POLICY medical_notices_user_scope ON public.medical_notices;
CREATE POLICY medical_notices_guardian_read ON public.medical_notices
  AS RESTRICTIVE FOR SELECT TO figbloom_app
  USING (guardian_user_id = public.app_current_user_id());
CREATE POLICY medical_notices_guardian_update ON public.medical_notices
  AS RESTRICTIVE FOR UPDATE TO figbloom_app
  USING (guardian_user_id = public.app_current_user_id())
  WITH CHECK (guardian_user_id = public.app_current_user_id());
CREATE POLICY medical_notices_staff_insert ON public.medical_notices
  AS RESTRICTIVE FOR INSERT TO figbloom_app
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.school_memberships s
             WHERE s.tenant_id = medical_notices.tenant_id AND s.user_id = public.app_current_user_id()
               AND s.archived_at IS NULL AND s.role::text IN ('school_admin', 'teacher', 'staff'))
    AND EXISTS (SELECT 1 FROM public.school_memberships g
                 WHERE g.tenant_id = medical_notices.tenant_id AND g.user_id = medical_notices.guardian_user_id
                   AND g.archived_at IS NULL AND g.role::text = 'parent')
  );
