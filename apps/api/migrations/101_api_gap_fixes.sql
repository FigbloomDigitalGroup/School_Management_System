-- API gap fixes for the web on the new API (findings 6 to 8 in docs/WEB_ON_THE_NEW_API.md).
-- Forward-only. Migrations 001-100 are not edited. No new table.
--   1. Finding 7: a learner may go back into a class they left earlier in the same academic year.
--   2. A class has a room.
--   3. A subject has a level, a year range and a core flag, and can be updated.
-- Ending a learner's class membership on archive (finding 8) and the class, subject and teaching-assignment
-- updates are application code (modules/academics/structure.ts, modules/directory/learners.ts).

-- ---------------------------------------------------------------- 1. class memberships
-- class_memberships_learner_class_year_uidx (029) was UNIQUE over (tenant, learner, class, year) for every row, so an
-- ENDED membership blocked the same learner from that class for the rest of the year (the 409 said "already has an
-- active class membership", which was not what happened). The rule that matters, one ACTIVE membership per learner per
-- academic year, is already class_memberships_learner_year_active_uidx (029, WHERE active = true), and it implies
-- "one active row per learner, class and year", so a partial unique index on the four columns would never fire.
-- The index is kept as a plain index on the same columns, so a learner's whole history (ended rows included) is
-- still found by index.
DROP INDEX class_memberships_learner_class_year_uidx;

CREATE INDEX class_memberships_learner_class_year_idx
  ON class_memberships (tenant_id, learner_id, class_id, academic_year_id);

-- ---------------------------------------------------------------- 2. classes.room
-- Same bounds as timetable_slots.room (029).
ALTER TABLE classes
  ADD COLUMN room text,
  ADD CONSTRAINT classes_room_len CHECK (room IS NULL OR char_length(trim(room)) BETWEEN 1 AND 64);

-- INSERT is table-level since 029; UPDATE stays column-level (grants.matrix.test.ts).
GRANT UPDATE (room) ON classes TO figbloom_app;

-- ---------------------------------------------------------------- 3. subjects: level, year range, core flag
-- Mirrors classes (079): a year is (education_level, form_level). A NULL level means any level; a NULL bound means
-- no bound on that side. is_core defaults to true, as on the Supabase schema.
ALTER TABLE subjects
  ADD COLUMN education_level text,
  ADD COLUMN min_form_level smallint,
  ADD COLUMN max_form_level smallint,
  ADD COLUMN is_core boolean NOT NULL DEFAULT true;

ALTER TABLE subjects
  ADD CONSTRAINT subjects_education_level_chk CHECK (
    education_level IS NULL
    OR education_level IN ('pre_primary', 'primary', 'junior_secondary', 'senior_school', 'secondary')
  ),
  ADD CONSTRAINT subjects_form_level_range_chk CHECK (
    (min_form_level IS NULL OR min_form_level BETWEEN 1 AND 12)
    AND (max_form_level IS NULL OR max_form_level BETWEEN 1 AND 12)
    AND (min_form_level IS NULL OR max_form_level IS NULL OR min_form_level <= max_form_level)
  ),
  ADD CONSTRAINT subjects_level_year_chk CHECK (
    education_level IS NULL
    OR (education_level = 'pre_primary'
      AND (min_form_level IS NULL OR min_form_level BETWEEN 1 AND 2)
      AND (max_form_level IS NULL OR max_form_level BETWEEN 1 AND 2))
    OR (education_level = 'primary'
      AND (min_form_level IS NULL OR min_form_level BETWEEN 1 AND 6)
      AND (max_form_level IS NULL OR max_form_level BETWEEN 1 AND 6))
    OR (education_level = 'junior_secondary'
      AND (min_form_level IS NULL OR min_form_level BETWEEN 7 AND 9)
      AND (max_form_level IS NULL OR max_form_level BETWEEN 7 AND 9))
    OR (education_level = 'senior_school'
      AND (min_form_level IS NULL OR min_form_level BETWEEN 10 AND 12)
      AND (max_form_level IS NULL OR max_form_level BETWEEN 10 AND 12))
    OR (education_level = 'secondary'
      AND (min_form_level IS NULL OR min_form_level BETWEEN 1 AND 4)
      AND (max_form_level IS NULL OR max_form_level BETWEEN 1 AND 4))
  );

-- INSERT is table-level since 029; UPDATE stays column-level (grants.matrix.test.ts).
GRANT UPDATE (education_level, min_form_level, max_form_level, is_core) ON subjects TO figbloom_app;
