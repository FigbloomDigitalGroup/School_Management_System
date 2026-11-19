-- Stage 9/10 owner decisions OD-1, OD-3, OD-4, OD-5 (approved by Ancel, implemented 2026-11-19).
-- Forward-only. Migrations 029–034 are not edited.
--
-- Pattern used three times (marks, CBE results, HE grades): a change to a locked/current row is
-- only possible together with an append-only revision row written in the same transaction. The
-- revision row must name the exact previous value and the exact resulting row_version, and the
-- row being changed must carry the same new value and that version. A revision row therefore
-- authorises exactly one transition, cannot be reused, and two concurrent corrections collide
-- on the (…, resulting_row_version) unique key. Revision tables are SELECT + INSERT only.
--
--   OD-1  Published marks are locked. Any INSERT or UPDATE of mark_entries on an assessment that
--         is not 'draft' needs a matching mark_corrections row (previous score/grade, new
--         score/grade, reason, actor, time). Assessment status is forward-only, so a published
--         assessment cannot be put back to draft to unlock its marks.
--   OD-3  One current CBE result per (assessment, learner, strand, outcome). Updates carry a
--         reason and leave a cbe_result_revisions row.
--   OD-5  One current HE grade per enrolment. A first grade needs an 'enrolled' enrolment;
--         a correction of an existing grade (also on a withdrawn enrolment) needs a
--         he_grade_revisions row. No path re-opens a withdrawn enrolment.
--   OD-4  attendance_counted_page: the counting twin with a term, optional class, keyset cursor
--         and limit, and a session column so the key (taken_on, learner_id, session) is unique.
--
-- Stale corrections/revisions raise SQLSTATE FB409 (custom), which the API maps to 409. The
-- standard 40001 is deliberately not used: the API treats it as a transient 503.
--
-- The unique indexes below fail loudly if duplicate rows already exist. Nothing is deleted or
-- merged silently: duplicates (only possible on a local database that ran 031/032 without this
-- migration) must be resolved by a person first.

-- ================================================================ OD-1 marks
CREATE TABLE mark_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  assessment_id uuid NOT NULL,
  learner_id uuid NOT NULL,
  previous_score numeric,
  previous_grade text,
  new_score numeric NOT NULL,
  new_grade text,
  resulting_row_version integer NOT NULL,
  reason text NOT NULL,
  corrected_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  corrected_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mark_corrections_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT mark_corrections_step_uidx UNIQUE (tenant_id, assessment_id, learner_id, resulting_row_version),
  CONSTRAINT mark_corrections_assessment_fk FOREIGN KEY (assessment_id, tenant_id)
    REFERENCES assessments (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT mark_corrections_learner_fk FOREIGN KEY (learner_id, tenant_id)
    REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT mark_corrections_version_chk CHECK (resulting_row_version >= 1),
  CONSTRAINT mark_corrections_score_chk CHECK (new_score >= 0 AND new_score <= 10000),
  CONSTRAINT mark_corrections_reason_len CHECK (char_length(btrim(reason)) BETWEEN 5 AND 500),
  CONSTRAINT mark_corrections_grade_len CHECK (new_grade IS NULL OR char_length(btrim(new_grade)) BETWEEN 1 AND 16)
);

CREATE INDEX mark_corrections_assessment_idx ON mark_corrections (tenant_id, assessment_id, corrected_at, id);

-- A correction row must describe the mark exactly as it stands and the next version.
CREATE FUNCTION public.mark_corrections_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_status text;
  v_score numeric;
  v_grade text;
  v_version integer;
BEGIN
  SELECT a.status INTO v_status
    FROM public.assessments a
   WHERE a.id = NEW.assessment_id AND a.tenant_id = NEW.tenant_id
   FOR SHARE;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'unknown assessment' USING ERRCODE = '23503';
  END IF;
  IF v_status = 'draft' THEN
    RAISE EXCEPTION 'A draft assessment is edited directly, not corrected' USING ERRCODE = '23514';
  END IF;
  SELECT m.score, m.grade, m.row_version INTO v_score, v_grade, v_version
    FROM public.mark_entries m
   WHERE m.tenant_id = NEW.tenant_id AND m.assessment_id = NEW.assessment_id AND m.learner_id = NEW.learner_id;
  IF NOT FOUND THEN
    IF NEW.previous_score IS NOT NULL OR NEW.previous_grade IS NOT NULL OR NEW.resulting_row_version <> 1 THEN
      RAISE EXCEPTION 'The correction does not match the current mark' USING ERRCODE = 'FB409';
    END IF;
  ELSIF NEW.previous_score IS DISTINCT FROM v_score
     OR NEW.previous_grade IS DISTINCT FROM v_grade
     OR NEW.resulting_row_version <> v_version + 1 THEN
    RAISE EXCEPTION 'The correction does not match the current mark' USING ERRCODE = 'FB409';
  END IF;
  NEW.corrected_at := now();
  RETURN NEW;
END;
$$;

-- A mark on a non-draft assessment changes only with its correction row.
CREATE FUNCTION public.mark_entries_publication_lock() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT a.status INTO v_status
    FROM public.assessments a
   WHERE a.id = NEW.assessment_id AND a.tenant_id = NEW.tenant_id;
  IF v_status IS DISTINCT FROM 'draft' AND NOT EXISTS (
    SELECT 1 FROM public.mark_corrections c
     WHERE c.tenant_id = NEW.tenant_id
       AND c.assessment_id = NEW.assessment_id
       AND c.learner_id = NEW.learner_id
       AND c.resulting_row_version = NEW.row_version
       AND c.new_score = NEW.score
       AND c.new_grade IS NOT DISTINCT FROM NEW.grade
  ) THEN
    RAISE EXCEPTION 'Marks of a published assessment are locked; record a correction' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.assessment_id, NEW.learner_id, NEW.tenant_id) IS DISTINCT FROM (OLD.assessment_id, OLD.learner_id, OLD.tenant_id) THEN
    RAISE EXCEPTION 'A mark cannot move' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.assessments_status_forward_only() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.status <> 'draft' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'A published assessment cannot return to draft' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'closed' AND NEW.status <> 'closed' THEN
    RAISE EXCEPTION 'A closed assessment stays closed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mark_corrections_before_insert
  BEFORE INSERT ON mark_corrections FOR EACH ROW
  EXECUTE FUNCTION public.mark_corrections_before_insert();

CREATE TRIGGER mark_entries_publication_lock
  BEFORE INSERT OR UPDATE ON mark_entries FOR EACH ROW
  EXECUTE FUNCTION public.mark_entries_publication_lock();

CREATE TRIGGER assessments_status_forward_only
  BEFORE UPDATE ON assessments FOR EACH ROW
  EXECUTE FUNCTION public.assessments_status_forward_only();

-- ================================================================ OD-3 CBE results
ALTER TABLE cbe_results ADD COLUMN row_version integer NOT NULL DEFAULT 1;
ALTER TABLE cbe_results ADD CONSTRAINT cbe_results_version_chk CHECK (row_version >= 1);

CREATE UNIQUE INDEX cbe_results_current_uidx ON cbe_results (
  tenant_id, cbe_assessment_id, learner_id,
  COALESCE(strand_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(learning_outcome_id, '00000000-0000-0000-0000-000000000000'::uuid)
);

CREATE TABLE cbe_result_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  result_id uuid NOT NULL,
  previous_level_code text NOT NULL,
  previous_points numeric NOT NULL,
  new_level_code text NOT NULL,
  new_points numeric NOT NULL,
  -- Filled by the trigger from the row being replaced (lets a replay rebuild any past version).
  previous_marked_at timestamptz,
  previous_marked_by uuid,
  resulting_row_version integer NOT NULL,
  reason text NOT NULL,
  revised_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  revised_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cbe_result_revisions_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT cbe_result_revisions_step_uidx UNIQUE (tenant_id, result_id, resulting_row_version),
  CONSTRAINT cbe_result_revisions_result_fk FOREIGN KEY (result_id, tenant_id)
    REFERENCES cbe_results (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT cbe_result_revisions_version_chk CHECK (resulting_row_version >= 2),
  CONSTRAINT cbe_result_revisions_points_chk CHECK (new_points >= 0 AND new_points <= 1000),
  CONSTRAINT cbe_result_revisions_level_len CHECK (char_length(btrim(new_level_code)) BETWEEN 1 AND 16),
  CONSTRAINT cbe_result_revisions_reason_len CHECK (char_length(btrim(reason)) BETWEEN 5 AND 500)
);

CREATE FUNCTION public.cbe_result_revisions_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_level text;
  v_points numeric;
  v_version integer;
  v_at timestamptz;
  v_by uuid;
BEGIN
  SELECT r.level_code, r.points, r.row_version, r.marked_at, r.marked_by
    INTO v_level, v_points, v_version, v_at, v_by
    FROM public.cbe_results r WHERE r.id = NEW.result_id AND r.tenant_id = NEW.tenant_id;
  IF NOT FOUND
     OR NEW.previous_level_code IS DISTINCT FROM v_level
     OR NEW.previous_points IS DISTINCT FROM v_points
     OR NEW.resulting_row_version <> v_version + 1 THEN
    RAISE EXCEPTION 'The revision does not match the current result' USING ERRCODE = 'FB409';
  END IF;
  NEW.previous_marked_at := v_at;
  NEW.previous_marked_by := v_by;
  NEW.revised_at := now();
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.cbe_results_revision_required() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.row_version IS DISTINCT FROM OLD.row_version + 1 OR NOT EXISTS (
    SELECT 1 FROM public.cbe_result_revisions v
     WHERE v.tenant_id = NEW.tenant_id AND v.result_id = NEW.id
       AND v.resulting_row_version = NEW.row_version
       AND v.new_level_code = NEW.level_code AND v.new_points = NEW.points
  ) THEN
    RAISE EXCEPTION 'A CBE result changes only with a revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cbe_result_revisions_before_insert
  BEFORE INSERT ON cbe_result_revisions FOR EACH ROW
  EXECUTE FUNCTION public.cbe_result_revisions_before_insert();

CREATE TRIGGER cbe_results_revision_required
  BEFORE UPDATE ON cbe_results FOR EACH ROW
  EXECUTE FUNCTION public.cbe_results_revision_required();

-- A new result starts at version 1.
CREATE FUNCTION public.cbe_results_first_version() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW.row_version := 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER cbe_results_first_version
  BEFORE INSERT ON cbe_results FOR EACH ROW
  EXECUTE FUNCTION public.cbe_results_first_version();

-- ================================================================ OD-5 HE grades
ALTER TABLE he_grades ADD COLUMN row_version integer NOT NULL DEFAULT 1;
ALTER TABLE he_grades ADD CONSTRAINT he_grades_version_chk CHECK (row_version >= 1);
CREATE UNIQUE INDEX he_grades_current_uidx ON he_grades (tenant_id, enrolment_id);

CREATE TABLE he_grade_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  grade_id uuid NOT NULL,
  previous_score numeric NOT NULL,
  previous_grade text,
  new_score numeric NOT NULL,
  new_grade text,
  previous_graded_at timestamptz,
  previous_graded_by uuid,
  resulting_row_version integer NOT NULL,
  reason text NOT NULL,
  revised_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  revised_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT he_grade_revisions_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT he_grade_revisions_step_uidx UNIQUE (tenant_id, grade_id, resulting_row_version),
  CONSTRAINT he_grade_revisions_grade_fk FOREIGN KEY (grade_id, tenant_id)
    REFERENCES he_grades (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT he_grade_revisions_version_chk CHECK (resulting_row_version >= 2),
  CONSTRAINT he_grade_revisions_score_chk CHECK (new_score >= 0 AND new_score <= 10000),
  CONSTRAINT he_grade_revisions_grade_len CHECK (new_grade IS NULL OR char_length(btrim(new_grade)) BETWEEN 1 AND 16),
  CONSTRAINT he_grade_revisions_reason_len CHECK (char_length(btrim(reason)) BETWEEN 5 AND 500)
);

CREATE FUNCTION public.he_grade_revisions_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_score numeric;
  v_grade text;
  v_version integer;
  v_at timestamptz;
  v_by uuid;
BEGIN
  SELECT g.score, g.grade, g.row_version, g.graded_at, g.graded_by
    INTO v_score, v_grade, v_version, v_at, v_by
    FROM public.he_grades g WHERE g.id = NEW.grade_id AND g.tenant_id = NEW.tenant_id;
  IF NOT FOUND
     OR NEW.previous_score IS DISTINCT FROM v_score
     OR NEW.previous_grade IS DISTINCT FROM v_grade
     OR NEW.resulting_row_version <> v_version + 1 THEN
    RAISE EXCEPTION 'The revision does not match the current grade' USING ERRCODE = 'FB409';
  END IF;
  NEW.previous_graded_at := v_at;
  NEW.previous_graded_by := v_by;
  NEW.revised_at := now();
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.he_grades_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.he_enrolments e
       WHERE e.id = NEW.enrolment_id AND e.tenant_id = NEW.tenant_id AND e.status = 'enrolled'
    ) THEN
      RAISE EXCEPTION 'A grade can only be first recorded for an enrolled learner' USING ERRCODE = '23514';
    END IF;
    NEW.row_version := 1;
    RETURN NEW;
  END IF;
  IF NEW.row_version IS DISTINCT FROM OLD.row_version + 1 OR NOT EXISTS (
    SELECT 1 FROM public.he_grade_revisions v
     WHERE v.tenant_id = NEW.tenant_id AND v.grade_id = NEW.id
       AND v.resulting_row_version = NEW.row_version
       AND v.new_score = NEW.score AND v.new_grade IS NOT DISTINCT FROM NEW.grade
  ) THEN
    RAISE EXCEPTION 'An HE grade changes only with a revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER he_grade_revisions_before_insert
  BEFORE INSERT ON he_grade_revisions FOR EACH ROW
  EXECUTE FUNCTION public.he_grade_revisions_before_insert();

CREATE TRIGGER he_grades_guard
  BEFORE INSERT OR UPDATE ON he_grades FOR EACH ROW
  EXECUTE FUNCTION public.he_grades_guard();

-- ================================================================ RLS, grants for the new tables
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mark_corrections', 'cbe_result_revisions', 'he_grade_revisions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO figbloom_app USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())',
      t || '_tenant', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I FOR ALL TO PUBLIC
      USING (current_user = (
        SELECT pg_get_userbyid(c.relowner) FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = %L
      ))
      WITH CHECK (current_user = (
        SELECT pg_get_userbyid(c.relowner) FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = %L
      ))
    $f$, t || '_owner', t, t, t);
    EXECUTE format('GRANT SELECT, INSERT ON %I TO figbloom_app', t);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM figbloom_app', t);
  END LOOP;
END $$;

GRANT UPDATE (level_code, points, marked_at, marked_by, row_version) ON cbe_results TO figbloom_app;
GRANT UPDATE (score, grade, graded_at, graded_by, row_version) ON he_grades TO figbloom_app;

-- ================================================================ OD-4 paged attendance counting
-- Same rules as attendance_counted (033). Keyset (taken_on, learner_id, session) ascending;
-- session is 'morning' | 'afternoon' in session mode and 'day' in day mode. Invoker: RLS applies.
CREATE FUNCTION public.attendance_counted_page(
  p_tenant uuid,
  p_term uuid,
  p_class uuid,
  p_after_taken_on date,
  p_after_learner uuid,
  p_after_session text,
  p_limit integer
)
RETURNS TABLE (class_id uuid, learner_id uuid, taken_on date, session text, here boolean)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH mode AS (
    SELECT COALESCE(
      (SELECT s.percentage_mode FROM public.attendance_settings s WHERE s.tenant_id = p_tenant),
      'session'
    ) AS m
  ),
  entries AS (
    SELECT a.class_id, a.learner_id, a.taken_on, 1 AS sess, a.mark
      FROM public.attendance a
     WHERE a.tenant_id = p_tenant AND a.term_id = p_term
       AND (p_after_taken_on IS NULL OR (a.taken_on, a.learner_id) >= (p_after_taken_on, p_after_learner))
    UNION ALL
    SELECT pm.class_id, pm.learner_id, pm.taken_on, 2, pm.mark
      FROM public.attendance_afternoon pm
     WHERE pm.tenant_id = p_tenant AND pm.term_id = p_term
       AND (p_after_taken_on IS NULL OR (pm.taken_on, pm.learner_id) >= (p_after_taken_on, p_after_learner))
       AND NOT (
         pm.mark IN ('absent', 'excused')
         AND EXISTS (
           SELECT 1 FROM public.early_sign_outs e
            WHERE e.learner_id = pm.learner_id AND e.taken_on = pm.taken_on AND e.voided_at IS NULL
         )
       )
  ),
  units AS (
    SELECT e.class_id, e.learner_id, e.taken_on,
           CASE e.sess WHEN 1 THEN 'morning' ELSE 'afternoon' END AS session,
           e.mark IN ('present', 'late') AS here
      FROM entries e, mode
     WHERE mode.m = 'session'
    UNION ALL
    SELECT (array_agg(e.class_id ORDER BY e.sess))[1], e.learner_id, e.taken_on, 'day',
           bool_or(e.mark IN ('present', 'late'))
      FROM entries e, mode
     WHERE mode.m = 'day'
     GROUP BY e.learner_id, e.taken_on
  )
  SELECT u.class_id, u.learner_id, u.taken_on, u.session, u.here
    FROM units u
   WHERE (p_class IS NULL OR u.class_id = p_class)
     AND (p_after_taken_on IS NULL
          OR (u.taken_on, u.learner_id, u.session) > (p_after_taken_on, p_after_learner, p_after_session))
   ORDER BY u.taken_on, u.learner_id, u.session
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 1001)
$$;

REVOKE ALL ON FUNCTION public.attendance_counted_page(uuid, uuid, uuid, date, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.attendance_counted_page(uuid, uuid, uuid, date, uuid, text, integer) TO figbloom_app;

-- ================================================================ function hygiene
DO $$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'mark_corrections_before_insert()', 'mark_entries_publication_lock()', 'assessments_status_forward_only()',
    'cbe_result_revisions_before_insert()', 'cbe_results_revision_required()', 'cbe_results_first_version()',
    'he_grade_revisions_before_insert()', 'he_grades_guard()'
  ]
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM figbloom_app', f);
  END LOOP;
END $$;
