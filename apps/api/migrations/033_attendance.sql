-- Stage 10 — Morning and afternoon attendance, settings, counting, early sign-out.
-- Forward-only. Migrations 001–032 are not edited.
--
-- Compatibility with the legacy morning-only offline queue (FIG-1514):
--   * `attendance` IS the morning register. One row per learner per day,
--     unique (learner_id, taken_on). An upsert that omits session, sends null,
--     or sends morning writes ONLY this table and must not touch
--     attendance_afternoon.
--   * attendance_afternoon is a separate table with the same shape. A write to
--     one never updates the other.
--   * While afternoon_enabled is false (the default when a school has no
--     settings row), INSERT into attendance_afternoon — including
--     INSERT ... ON CONFLICT — is refused with SQLSTATE 23514. A plain UPDATE
--     of a row already stored is still allowed. Past afternoon rows are kept.
--   * Newest marked_at wins. A future stamp is clamped to now(). An identical
--     replay (same stamp, same other fields) is a no-op and keeps its stamp.
--   * taken_on cannot be after the school's today (tenants.timezone) and must
--     fall inside the named academic term.
--
-- Counting (attendance_counted) is the twin of the legacy rules:
--   session — one unit per register entry
--   day     — one unit per learner and date, here if present or late in any session
--   An afternoon absent or excused mark is left out when the learner has a
--   live (not voided) early sign-out that day. Leaving early is not an absence.
--   The class of a day-mode unit is the morning class when both sessions exist.
--
-- Early sign-out public fields live on early_sign_outs. Collector PII
-- (id_number, phone, authorised_by, note, void_reason) lives only on
-- early_sign_out_collectors. The API returns those columns only to callers
-- with resource.early_sign_out.collector.read.

INSERT INTO permissions (code, description) VALUES
  ('resource.attendance.read', 'Read attendance registers, settings and counted figures in tenant'),
  ('resource.attendance.write', 'Take attendance registers and change attendance settings in tenant'),
  ('resource.early_sign_out.read', 'Read early sign-out records without collector PII'),
  ('resource.early_sign_out.collector.read', 'Read early sign-out collector identity fields')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'resource.attendance.read'),
  ('school_admin', 'resource.attendance.write'),
  ('school_admin', 'resource.early_sign_out.read'),
  ('school_admin', 'resource.early_sign_out.collector.read')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------- settings
CREATE TABLE attendance_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE RESTRICT,
  afternoon_enabled boolean NOT NULL DEFAULT false,
  percentage_mode text NOT NULL DEFAULT 'session',
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_settings_mode_chk CHECK (percentage_mode IN ('session', 'day'))
);

-- ---------------------------------------------------------------- morning register (legacy table name: attendance)
CREATE TABLE attendance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  learner_id uuid NOT NULL,
  class_id uuid NOT NULL,
  term_id uuid NOT NULL,
  taken_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  taken_on date NOT NULL,
  mark text NOT NULL DEFAULT 'present',
  note text,
  marked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT attendance_learner_day_uidx UNIQUE (learner_id, taken_on),
  CONSTRAINT attendance_learner_fk FOREIGN KEY (learner_id, tenant_id)
    REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT attendance_class_fk FOREIGN KEY (class_id, tenant_id)
    REFERENCES classes (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT attendance_term_fk FOREIGN KEY (term_id, tenant_id)
    REFERENCES academic_terms (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT attendance_mark_chk CHECK (mark IN ('present', 'absent', 'late', 'excused')),
  CONSTRAINT attendance_note_len CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500)
);

CREATE INDEX attendance_class_day_idx ON attendance (tenant_id, class_id, taken_on);
CREATE INDEX attendance_term_day_idx ON attendance (tenant_id, term_id, taken_on DESC);

COMMENT ON TABLE attendance IS
  'Morning register. Legacy morning-only clients upsert this table and never name attendance_afternoon.';

-- ---------------------------------------------------------------- afternoon register
CREATE TABLE attendance_afternoon (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  learner_id uuid NOT NULL,
  class_id uuid NOT NULL,
  term_id uuid NOT NULL,
  taken_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  taken_on date NOT NULL,
  mark text NOT NULL DEFAULT 'present',
  note text,
  marked_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_afternoon_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT attendance_afternoon_learner_day_uidx UNIQUE (learner_id, taken_on),
  CONSTRAINT attendance_afternoon_learner_fk FOREIGN KEY (learner_id, tenant_id)
    REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT attendance_afternoon_class_fk FOREIGN KEY (class_id, tenant_id)
    REFERENCES classes (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT attendance_afternoon_term_fk FOREIGN KEY (term_id, tenant_id)
    REFERENCES academic_terms (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT attendance_afternoon_mark_chk CHECK (mark IN ('present', 'absent', 'late', 'excused')),
  CONSTRAINT attendance_afternoon_note_len CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500)
);

CREATE INDEX attendance_afternoon_class_day_idx ON attendance_afternoon (tenant_id, class_id, taken_on);
CREATE INDEX attendance_afternoon_term_day_idx ON attendance_afternoon (tenant_id, term_id, taken_on DESC);

-- Refuses a new afternoon row while the school does not take an afternoon register.
-- BEFORE INSERT also runs for INSERT ... ON CONFLICT, so an upsert is refused too.
CREATE FUNCTION public.attendance_afternoon_allowed() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NOT COALESCE((
    SELECT s.afternoon_enabled FROM public.attendance_settings s WHERE s.tenant_id = NEW.tenant_id
  ), false) THEN
    RAISE EXCEPTION 'This school does not take an afternoon register. It can be turned on in the attendance settings.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.attendance_afternoon_allowed() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.attendance_afternoon_allowed() FROM figbloom_app;

CREATE TRIGGER attendance_afternoon_allowed
  BEFORE INSERT ON attendance_afternoon
  FOR EACH ROW
  EXECUTE FUNCTION public.attendance_afternoon_allowed();

-- Date window and newest-wins, shared by both registers.
CREATE FUNCTION public.attendance_register_guard() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_today date;
  v_start date;
  v_end date;
BEGIN
  SELECT (now() AT TIME ZONE COALESCE(t.timezone, 'Africa/Nairobi'))::date
    INTO v_today
  FROM public.tenants t
  WHERE t.id = NEW.tenant_id;

  IF v_today IS NULL THEN
    RAISE EXCEPTION 'unknown school' USING ERRCODE = '23503';
  END IF;

  IF TG_OP = 'INSERT' AND NEW.taken_on IS NULL THEN
    NEW.taken_on := v_today;
  END IF;

  IF TG_OP = 'INSERT'
     OR NEW.taken_on IS DISTINCT FROM OLD.taken_on
     OR NEW.term_id IS DISTINCT FROM OLD.term_id THEN
    IF NEW.taken_on > v_today THEN
      RAISE EXCEPTION 'This register is dated %, which is after today in the school time zone',
        to_char(NEW.taken_on, 'YYYY-MM-DD')
        USING ERRCODE = '23514';
    END IF;
    SELECT starts_on, ends_on INTO v_start, v_end
    FROM public.academic_terms
    WHERE id = NEW.term_id AND tenant_id = NEW.tenant_id;
    IF NOT FOUND OR NEW.taken_on < v_start OR NEW.taken_on > v_end THEN
      RAISE EXCEPTION 'This register is dated %, which is outside the term',
        to_char(NEW.taken_on, 'YYYY-MM-DD')
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.marked_at := LEAST(COALESCE(NEW.marked_at, now()), now());
  ELSIF NEW.marked_at IS NOT DISTINCT FROM OLD.marked_at THEN
    IF to_jsonb(NEW) - 'marked_at' IS DISTINCT FROM to_jsonb(OLD) - 'marked_at' THEN
      NEW.marked_at := now();
    END IF;
  ELSIF NEW.marked_at < OLD.marked_at THEN
    RETURN OLD;
  ELSE
    NEW.marked_at := LEAST(NEW.marked_at, now());
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.attendance_register_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.attendance_register_guard() FROM figbloom_app;

CREATE TRIGGER attendance_register_guard
  BEFORE INSERT OR UPDATE ON attendance
  FOR EACH ROW
  EXECUTE FUNCTION public.attendance_register_guard();

CREATE TRIGGER attendance_afternoon_register_guard
  BEFORE INSERT OR UPDATE ON attendance_afternoon
  FOR EACH ROW
  EXECUTE FUNCTION public.attendance_register_guard();

-- ---------------------------------------------------------------- early sign-out
CREATE TABLE early_sign_outs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  learner_id uuid NOT NULL,
  class_id uuid,
  learner_name text NOT NULL,
  class_name text,
  taken_on date NOT NULL,
  signed_out_at timestamptz NOT NULL,
  signed_out_local time(0) NOT NULL,
  reason text NOT NULL,
  collected_by_name text NOT NULL,
  collected_by_relationship text NOT NULL,
  recorded_by uuid REFERENCES users (id) ON DELETE SET NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by uuid REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT early_sign_outs_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT early_sign_outs_learner_fk FOREIGN KEY (learner_id, tenant_id)
    REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT early_sign_outs_class_fk FOREIGN KEY (class_id, tenant_id)
    REFERENCES classes (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT early_sign_outs_reason_len CHECK (char_length(btrim(reason)) BETWEEN 1 AND 200),
  CONSTRAINT early_sign_outs_name_len CHECK (char_length(btrim(collected_by_name)) BETWEEN 1 AND 120),
  CONSTRAINT early_sign_outs_relationship_len CHECK (char_length(btrim(collected_by_relationship)) BETWEEN 1 AND 60)
);

CREATE INDEX early_sign_outs_day_idx ON early_sign_outs (tenant_id, taken_on);
CREATE INDEX early_sign_outs_learner_idx ON early_sign_outs (tenant_id, learner_id, taken_on DESC);

-- Twin of the legacy attendance_counted rules. Invoker rights: RLS still applies.
-- Created after early_sign_outs so the SQL body can see that table.
CREATE FUNCTION public.attendance_counted(p_tenant uuid, p_term uuid DEFAULT NULL)
RETURNS TABLE (class_id uuid, learner_id uuid, taken_on date, here boolean)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $$
  WITH entries AS (
    SELECT a.class_id, a.learner_id, a.taken_on, 1 AS session, a.mark
      FROM public.attendance a
     WHERE a.tenant_id = p_tenant AND (p_term IS NULL OR a.term_id = p_term)
    UNION ALL
    SELECT pm.class_id, pm.learner_id, pm.taken_on, 2, pm.mark
      FROM public.attendance_afternoon pm
     WHERE pm.tenant_id = p_tenant AND (p_term IS NULL OR pm.term_id = p_term)
       AND NOT (
         pm.mark IN ('absent', 'excused')
         AND EXISTS (
           SELECT 1 FROM public.early_sign_outs e
            WHERE e.learner_id = pm.learner_id
              AND e.taken_on = pm.taken_on
              AND e.voided_at IS NULL
         )
       )
  ),
  mode AS (
    SELECT COALESCE(
      (SELECT s.percentage_mode FROM public.attendance_settings s WHERE s.tenant_id = p_tenant),
      'session'
    ) AS m
  )
  SELECT e.class_id, e.learner_id, e.taken_on, e.mark IN ('present', 'late')
    FROM entries e, mode
   WHERE mode.m = 'session'
  UNION ALL
  SELECT (array_agg(e.class_id ORDER BY e.session))[1], e.learner_id, e.taken_on,
         bool_or(e.mark IN ('present', 'late'))
    FROM entries e, mode
   WHERE mode.m = 'day'
   GROUP BY e.learner_id, e.taken_on
$$;

REVOKE ALL ON FUNCTION public.attendance_counted(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.attendance_counted(uuid, uuid) TO figbloom_app;

CREATE TABLE early_sign_out_collectors (
  sign_out_id uuid PRIMARY KEY REFERENCES early_sign_outs (id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE RESTRICT,
  id_number text NOT NULL,
  phone text NOT NULL,
  authorised_by text NOT NULL,
  note text,
  void_reason text,
  CONSTRAINT early_sign_out_collectors_id_number_len CHECK (char_length(btrim(id_number)) BETWEEN 3 AND 30),
  CONSTRAINT early_sign_out_collectors_phone_chk CHECK (phone ~ '^\+?[0-9][0-9 ()-]{5,19}$'),
  CONSTRAINT early_sign_out_collectors_authorised_len CHECK (char_length(btrim(authorised_by)) BETWEEN 1 AND 120),
  CONSTRAINT early_sign_out_collectors_note_len CHECK (note IS NULL OR char_length(btrim(note)) BETWEEN 1 AND 500),
  CONSTRAINT early_sign_out_collectors_void_len CHECK (
    void_reason IS NULL OR char_length(btrim(void_reason)) BETWEEN 1 AND 200
  )
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'attendance_settings', 'attendance', 'attendance_afternoon',
    'early_sign_outs', 'early_sign_out_collectors'
  ]
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
    EXECUTE format('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON %I FROM figbloom_app', t);
  END LOOP;
END $$;

GRANT UPDATE (afternoon_enabled, percentage_mode, updated_at) ON attendance_settings TO figbloom_app;
GRANT UPDATE (class_id, term_id, taken_by, taken_on, mark, note, marked_at) ON attendance TO figbloom_app;
GRANT UPDATE (class_id, term_id, taken_by, taken_on, mark, note, marked_at) ON attendance_afternoon TO figbloom_app;
GRANT UPDATE (voided_at, voided_by) ON early_sign_outs TO figbloom_app;
GRANT UPDATE (void_reason) ON early_sign_out_collectors TO figbloom_app;
