-- 118: the behaviour and discipline log (docs/BEHAVIOUR.md). A port of the live Supabase migration
-- 20261124400000_behaviour_log.sql (and the same-school and audit guards of 20261125000000). Forward-only; 001-117 untouched.
--
--   behaviour_settings     one row per school (none = the defaults): points on or off, the mode (merits_only, demerits_only,
--                          both), the starting balance of demerits_only, when points start again (term, year, never), the
--                          most points one entry may carry, thresholds shown as badges, and what families see.
--   behaviour_categories   the school's own list. Never deleted: archived, so an entry keeps its category.
--   behaviour_entries      one merit, demerit or incident for one learner. points are signed. Never rewritten or deleted: a
--                          mistake is voided with a reason. A serious entry is an incident to follow up (the incident columns,
--                          written by the office from S2b).
--   behaviour_staff_notes  the staff-only note of an entry, in a table of its own that no family or learner read selects.
--
-- Who may read or write what is application code (RLS here is the tenant boundary, TENANT-ISOLATION.md). The database
-- guards what it can: the sign and size of the points, the category's kind, the date, the recorder, the class, and that an
-- entry is only ever voided or followed up, never rewritten (behaviour_entries_guard).

-- ================================================================ the Discipline area and the permissions

ALTER TABLE staff_area_grants DROP CONSTRAINT IF EXISTS staff_area_grants_area_check;
ALTER TABLE staff_area_grants ADD CONSTRAINT staff_area_grants_area_check CHECK (area IN (
  'people', 'fees', 'academics', 'attendance', 'transport', 'communication',
  'inventory', 'activities', 'visitors', 'medical', 'leave', 'audit', 'discipline'
));
ALTER TABLE school_roles DROP CONSTRAINT IF EXISTS school_roles_areas_known;
ALTER TABLE school_roles ADD CONSTRAINT school_roles_areas_known CHECK (
  areas <@ ARRAY[
    'people', 'fees', 'academics', 'attendance', 'transport', 'communication',
    'inventory', 'activities', 'visitors', 'medical', 'leave', 'audit', 'discipline'
  ]::text[]
);

INSERT INTO permissions (code, description) VALUES
  ('area.discipline', 'Admin area: behaviour and discipline log'),
  ('resource.discipline.read', 'Read the whole behaviour log, every learner''s points and the staff-only notes'),
  ('resource.discipline.write', 'Set up the behaviour log (settings, categories), record for any learner, void and follow up entries'),
  ('resource.behaviour.record', 'Record behaviour for the learners one teaches, and read and void what one recorded')
ON CONFLICT (code) DO NOTHING;
INSERT INTO role_permissions (role, permission_code) VALUES
  ('school_admin', 'resource.discipline.read'),
  ('school_admin', 'resource.discipline.write'),
  -- platform super administrators hold every catalogued permission
  ('super_admin', 'resource.discipline.read'),
  ('super_admin', 'resource.discipline.write'),
  ('teacher', 'resource.behaviour.record')
ON CONFLICT DO NOTHING;

-- ================================================================ settings

-- At most 10 thresholds, each a non-zero whole number of points (negative for demerits) with a label of 1 to 60 characters.
CREATE FUNCTION public.behaviour_thresholds_valid(p jsonb) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT jsonb_typeof(p) = 'array'
     AND jsonb_array_length(p) <= 10
     AND coalesce((SELECT bool_and(
           jsonb_typeof(e) = 'object'
           AND jsonb_typeof(e -> 'points') = 'number'
           AND (e ->> 'points')::numeric = trunc((e ->> 'points')::numeric)
           AND (e ->> 'points')::numeric <> 0
           AND abs((e ->> 'points')::numeric) <= 10000
           AND jsonb_typeof(e -> 'label') = 'string'
           AND char_length(btrim(e ->> 'label')) BETWEEN 1 AND 60)
         FROM jsonb_array_elements(p) e), true)
$$;
REVOKE ALL ON FUNCTION public.behaviour_thresholds_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.behaviour_thresholds_valid(jsonb) TO figbloom_app;

CREATE TABLE behaviour_settings (
  tenant_id             uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  points_enabled        boolean NOT NULL DEFAULT true,
  mode                  text NOT NULL DEFAULT 'both',
  -- where a learner starts each period in demerits_only mode (the other modes start at 0)
  starting_points       integer NOT NULL DEFAULT 100,
  reset                 text NOT NULL DEFAULT 'term',
  max_points_per_entry  integer NOT NULL DEFAULT 10,
  thresholds            jsonb NOT NULL DEFAULT '[{"points": -15, "label": "Parent meeting"}, {"points": 30, "label": "Certificate"}]'::jsonb,
  parents_see_demerits  boolean NOT NULL DEFAULT false,
  parents_see_incidents boolean NOT NULL DEFAULT false,
  updated_by            uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT behaviour_settings_mode_chk CHECK (mode IN ('merits_only', 'demerits_only', 'both')),
  CONSTRAINT behaviour_settings_reset_chk CHECK (reset IN ('term', 'year', 'never')),
  CONSTRAINT behaviour_settings_start_chk CHECK (starting_points BETWEEN 0 AND 10000),
  CONSTRAINT behaviour_settings_max_chk CHECK (max_points_per_entry BETWEEN 1 AND 100),
  CONSTRAINT behaviour_settings_thresholds_chk CHECK (public.behaviour_thresholds_valid(thresholds))
);

-- ================================================================ categories

CREATE TABLE behaviour_categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  kind        text NOT NULL,
  name        text NOT NULL,
  -- the default size of an entry (always positive here; a demerit's entry is stored negative)
  points      integer NOT NULL,
  severity    text,
  sort_order  integer NOT NULL DEFAULT 0,
  archived_at timestamptz,
  created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT behaviour_categories_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT behaviour_categories_kind_chk CHECK (kind IN ('merit', 'demerit')),
  CONSTRAINT behaviour_categories_name_chk CHECK (char_length(btrim(name)) BETWEEN 2 AND 60),
  CONSTRAINT behaviour_categories_points_chk CHECK (points BETWEEN 0 AND 100),
  CONSTRAINT behaviour_categories_severity_chk CHECK (severity IS NULL OR severity IN ('minor', 'major', 'serious')),
  -- a merit has no severity, a demerit always has one
  CONSTRAINT behaviour_categories_severity_kind CHECK ((kind = 'merit') = (severity IS NULL))
);
CREATE UNIQUE INDEX behaviour_categories_name_unique ON behaviour_categories (tenant_id, kind, lower(btrim(name)));

-- ================================================================ entries

CREATE TABLE behaviour_entries (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  learner_id         uuid NOT NULL,
  category_id        uuid,
  kind               text NOT NULL,
  points             integer NOT NULL,
  severity           text,
  note               text,
  -- the school's day it happened; the API fills in the school's today when the client leaves it out
  occurred_on        date NOT NULL,
  class_id           uuid,      -- the learner's class when it was recorded
  subject_id         uuid,
  recorded_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- a correction: the entry stays, uncounted and hidden from families
  voided_at          timestamptz,
  voided_by          uuid REFERENCES users (id) ON DELETE SET NULL,
  void_reason        text,
  -- the incident record (written by the office)
  action_taken       text,
  follow_up_status   text,
  resolved_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  resolved_at        timestamptz,
  parent_notified_at timestamptz,
  CONSTRAINT behaviour_entries_id_tenant_uniq UNIQUE (id, tenant_id),
  CONSTRAINT behaviour_entries_learner_fk FOREIGN KEY (learner_id, tenant_id) REFERENCES learners (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT behaviour_entries_category_fk FOREIGN KEY (category_id, tenant_id) REFERENCES behaviour_categories (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT behaviour_entries_class_fk FOREIGN KEY (class_id, tenant_id) REFERENCES classes (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT behaviour_entries_subject_fk FOREIGN KEY (subject_id, tenant_id) REFERENCES subjects (id, tenant_id) ON DELETE RESTRICT,
  CONSTRAINT behaviour_entries_kind_chk CHECK (kind IN ('merit', 'demerit', 'incident')),
  CONSTRAINT behaviour_entries_severity_chk CHECK (severity IS NULL OR severity IN ('minor', 'major', 'serious')),
  CONSTRAINT behaviour_entries_note_chk CHECK (note IS NULL OR char_length(note) <= 1000),
  CONSTRAINT behaviour_entries_void_reason_chk CHECK (void_reason IS NULL OR char_length(void_reason) BETWEEN 3 AND 300),
  CONSTRAINT behaviour_entries_action_chk CHECK (action_taken IS NULL OR action_taken IN
    ('warning', 'detention', 'parent_called', 'parent_meeting', 'suspension', 'counsellor', 'other')),
  CONSTRAINT behaviour_entries_status_chk CHECK (follow_up_status IS NULL OR follow_up_status IN ('open', 'resolved')),
  -- the sign rules, exactly: a merit is positive, a demerit negative, an incident zero or negative
  CONSTRAINT behaviour_entries_sign CHECK (
    (kind = 'merit' AND points > 0) OR (kind = 'demerit' AND points < 0) OR (kind = 'incident' AND points <= 0)),
  CONSTRAINT behaviour_entries_category CHECK (kind = 'incident' OR category_id IS NOT NULL),
  CONSTRAINT behaviour_entries_merit_severity CHECK (kind <> 'merit' OR severity IS NULL),
  CONSTRAINT behaviour_entries_incident_note CHECK (kind <> 'incident' OR category_id IS NOT NULL OR note IS NOT NULL),
  CONSTRAINT behaviour_entries_void CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
CREATE INDEX behaviour_entries_day_idx ON behaviour_entries (tenant_id, occurred_on DESC);
CREATE INDEX behaviour_entries_learner_idx ON behaviour_entries (learner_id, occurred_on DESC);
CREATE INDEX behaviour_entries_class_idx ON behaviour_entries (tenant_id, class_id, occurred_on DESC);
CREATE INDEX behaviour_entries_recorder_idx ON behaviour_entries (tenant_id, recorded_by);
CREATE INDEX behaviour_entries_open_idx ON behaviour_entries (tenant_id) WHERE follow_up_status = 'open';

CREATE TABLE behaviour_staff_notes (
  entry_id   uuid PRIMARY KEY,
  tenant_id  uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  note       text NOT NULL,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT behaviour_staff_notes_entry_fk FOREIGN KEY (entry_id, tenant_id) REFERENCES behaviour_entries (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT behaviour_staff_notes_note_chk CHECK (char_length(note) BETWEEN 1 AND 1000)
);
CREATE INDEX behaviour_staff_notes_tenant_idx ON behaviour_staff_notes (tenant_id);

-- ================================================================ the guard

-- Checks and completes an entry, and keeps a written entry from ever being rewritten. SECURITY INVOKER: it runs as the
-- caller under row security, so it only sees the school of the request, and no owner rights are lent.
CREATE FUNCTION public.behaviour_entries_guard() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_active  boolean;
  v_archived timestamptz;
  v_cat     public.behaviour_categories%ROWTYPE;
  v_max     integer;
  v_today   date;
  v_user    uuid := public.app_current_user_id();
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT l.active, l.archived_at INTO v_active, v_archived
      FROM public.learners l WHERE l.id = NEW.learner_id AND l.tenant_id = NEW.tenant_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'That learner is not at this school' USING ERRCODE = '42501';
    END IF;
    IF NOT v_active OR v_archived IS NOT NULL THEN
      RAISE EXCEPTION 'That learner has left the school' USING ERRCODE = '23514';
    END IF;

    IF NEW.category_id IS NOT NULL THEN
      SELECT * INTO v_cat FROM public.behaviour_categories WHERE id = NEW.category_id AND tenant_id = NEW.tenant_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'That category is not this school''s' USING ERRCODE = '42501';
      END IF;
      IF v_cat.archived_at IS NOT NULL THEN
        RAISE EXCEPTION '"%" is no longer in use', v_cat.name USING ERRCODE = '23514';
      END IF;
      IF (NEW.kind = 'incident' AND v_cat.kind <> 'demerit') OR (NEW.kind <> 'incident' AND v_cat.kind <> NEW.kind) THEN
        RAISE EXCEPTION '"%" is a % category', v_cat.name, v_cat.kind USING ERRCODE = '22023';
      END IF;
    ELSIF NEW.kind <> 'incident' THEN
      RAISE EXCEPTION 'Choose a category' USING ERRCODE = '22023';
    END IF;

    SELECT max_points_per_entry INTO v_max FROM public.behaviour_settings WHERE tenant_id = NEW.tenant_id;
    v_max := coalesce(v_max, 10);
    IF NEW.points IS NULL THEN
      NEW.points := CASE NEW.kind WHEN 'merit' THEN v_cat.points ELSE -coalesce(v_cat.points, 0) END;
    END IF;
    IF NEW.kind <> 'incident' AND NEW.points = 0 THEN
      RAISE EXCEPTION 'A % needs at least 1 point', NEW.kind USING ERRCODE = '22023';
    END IF;
    IF abs(NEW.points) > v_max THEN
      RAISE EXCEPTION 'This school allows at most % points for one entry', v_max USING ERRCODE = '22023';
    END IF;

    NEW.severity := CASE NEW.kind
                      WHEN 'merit' THEN NULL
                      WHEN 'demerit' THEN v_cat.severity
                      ELSE coalesce(NEW.severity, v_cat.severity, 'serious') END;

    v_today := (now() AT TIME ZONE coalesce((SELECT t.timezone FROM public.tenants t WHERE t.id = NEW.tenant_id), 'Africa/Nairobi'))::date;
    IF NEW.occurred_on IS NULL THEN NEW.occurred_on := v_today; END IF;
    IF NEW.occurred_on > v_today THEN
      RAISE EXCEPTION 'The date can''t be in the future' USING ERRCODE = '22023';
    END IF;
    IF NEW.occurred_on < v_today - 366 THEN
      RAISE EXCEPTION 'That date is more than a year ago' USING ERRCODE = '22023';
    END IF;

    NEW.note := nullif(btrim(coalesce(NEW.note, '')), '');
    -- the learner's class now: an active membership of an active class in the current academic year
    SELECT cm.class_id INTO NEW.class_id
      FROM public.class_memberships cm
      JOIN public.classes c ON c.tenant_id = cm.tenant_id AND c.id = cm.class_id AND c.active = true AND c.archived_at IS NULL
      JOIN public.academic_years y ON y.tenant_id = cm.tenant_id AND y.id = cm.academic_year_id AND y.is_current = true
     WHERE cm.tenant_id = NEW.tenant_id AND cm.learner_id = NEW.learner_id AND cm.active = true AND cm.archived_at IS NULL
     ORDER BY cm.created_at DESC, cm.id
     LIMIT 1;

    NEW.recorded_by := coalesce(v_user, NEW.recorded_by);
    NEW.created_at := now();
    NEW.voided_at := NULL; NEW.voided_by := NULL; NEW.void_reason := NULL;
    NEW.action_taken := NULL; NEW.resolved_by := NULL; NEW.resolved_at := NULL; NEW.parent_notified_at := NULL;
    NEW.follow_up_status := CASE WHEN NEW.severity = 'serious' THEN 'open' END;
    RETURN NEW;
  END IF;

  -- UPDATE: an entry is only ever voided, or followed up. Nothing else about it changes.
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.learner_id IS DISTINCT FROM OLD.learner_id OR NEW.category_id IS DISTINCT FROM OLD.category_id
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.points IS DISTINCT FROM OLD.points
     OR NEW.severity IS DISTINCT FROM OLD.severity OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.occurred_on IS DISTINCT FROM OLD.occurred_on OR NEW.class_id IS DISTINCT FROM OLD.class_id
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A behaviour entry cannot be changed. Void it and record a new one.' USING ERRCODE = '42501';
  END IF;
  IF OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'This entry is already voided' USING ERRCODE = '23514';
  END IF;

  IF NEW.voided_at IS NOT NULL THEN
    -- voiding: the incident record is not touched in the same change
    IF NEW.action_taken IS DISTINCT FROM OLD.action_taken OR NEW.follow_up_status IS DISTINCT FROM OLD.follow_up_status
       OR NEW.resolved_by IS DISTINCT FROM OLD.resolved_by OR NEW.resolved_at IS DISTINCT FROM OLD.resolved_at
       OR NEW.parent_notified_at IS DISTINCT FROM OLD.parent_notified_at THEN
      RAISE EXCEPTION 'Void an entry on its own' USING ERRCODE = '22023';
    END IF;
    NEW.voided_at := now();
    NEW.voided_by := coalesce(v_user, NEW.voided_by);
    RETURN NEW;
  END IF;

  -- following up: who resolved it and when come from the request, and "parent told" keeps its first time
  IF NEW.voided_by IS DISTINCT FROM OLD.voided_by OR NEW.void_reason IS DISTINCT FROM OLD.void_reason THEN
    RAISE EXCEPTION 'Void an entry on its own' USING ERRCODE = '22023';
  END IF;
  IF NEW.follow_up_status = 'resolved' THEN
    NEW.resolved_by := coalesce(OLD.resolved_by, v_user);
    NEW.resolved_at := coalesce(OLD.resolved_at, now());
  ELSE
    NEW.resolved_by := NULL;
    NEW.resolved_at := NULL;
  END IF;
  IF NEW.parent_notified_at IS NOT NULL THEN
    NEW.parent_notified_at := coalesce(OLD.parent_notified_at, now());
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.behaviour_entries_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.behaviour_entries_guard() FROM figbloom_app;

CREATE TRIGGER behaviour_entries_guard BEFORE INSERT OR UPDATE ON behaviour_entries
  FOR EACH ROW EXECUTE FUNCTION public.behaviour_entries_guard();

-- ================================================================ row security and grants

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['behaviour_settings', 'behaviour_categories', 'behaviour_entries', 'behaviour_staff_notes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO figbloom_app USING (tenant_id = app_current_tenant_id()) WITH CHECK (tenant_id = app_current_tenant_id())',
      t || '_tenant', t);
    EXECUTE format($f$
      CREATE POLICY %I ON %I FOR ALL TO PUBLIC
      USING (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))
      WITH CHECK (current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = %L))
    $f$, t || '_owner', t, t, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT ON behaviour_settings TO figbloom_app;
GRANT UPDATE (points_enabled, mode, starting_points, reset, max_points_per_entry, thresholds, parents_see_demerits,
              parents_see_incidents, updated_by, updated_at) ON behaviour_settings TO figbloom_app;
GRANT SELECT, INSERT ON behaviour_categories TO figbloom_app;
GRANT UPDATE (name, points, severity, sort_order, archived_at) ON behaviour_categories TO figbloom_app;
GRANT SELECT, INSERT ON behaviour_entries TO figbloom_app;
-- an entry is only ever voided or followed up (the guard refuses any other change)
GRANT UPDATE (voided_at, voided_by, void_reason, action_taken, follow_up_status, resolved_by, resolved_at, parent_notified_at)
  ON behaviour_entries TO figbloom_app;
GRANT SELECT, INSERT ON behaviour_staff_notes TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON behaviour_settings FROM figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON behaviour_categories FROM figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON behaviour_entries FROM figbloom_app;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON behaviour_staff_notes FROM figbloom_app;
