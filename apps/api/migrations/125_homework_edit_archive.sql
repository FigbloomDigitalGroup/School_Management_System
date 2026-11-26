-- Homework: edit, archive and the fields the live app already has (slice W1.1, docs/HOMEWORK.md).
-- Forward-only. Migrations 001-124 are not edited. No new table, no new permission, no new function.
--   1. A homework item says how learners hand it in (hand_in) and carries an optional guide written for parents
--      (parent_guide). Same values and same shape as the live `assignments` table (Supabase migration
--      20261025000000_homework_parent_guide.sql).
--   2. Instructions may be blank. The live `assignments.body` is `text not null` with no minimum; this table required 1 to
--      8,000 characters.
--   3. A homework item can be changed (column-level UPDATE) and archived (archived_at, archived_by). On the API "delete"
--      means archive: nothing is removed, an archived item leaves every list, and there is no restore.
-- `created_by` (the account that set the item) has existed since migration 030 and the API has written it since Stage 9: no
-- new column. A read names the teacher from it (staff record first, then the account's own name) and never returns the id.
-- Row-level security is unchanged: forced, with the figbloom_app tenant policy and the owner-only policy from migration 030,
-- which cover the new columns. INSERT stays table-level, DELETE stays revoked, and UPDATE is column-level below.

ALTER TABLE homework_items
  ADD COLUMN hand_in text NOT NULL DEFAULT 'paper',
  ADD COLUMN parent_guide jsonb,
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archived_by uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- The three values the apps offer ("Exercise book", "Show the teacher", "Upload a file or photo").
ALTER TABLE homework_items
  ADD CONSTRAINT homework_items_hand_in_valid CHECK (hand_in IN ('paper', 'in_person', 'upload'));

-- Every key is optional; an item with no guide is NULL. about, help and avoid are text, needs is a list of at most 20,
-- minutes is 1 to 600, and the whole guide is at most 8,000 bytes. Identical to the live check.
ALTER TABLE homework_items
  ADD CONSTRAINT homework_items_parent_guide_shape CHECK (
    parent_guide IS NULL OR (
      jsonb_typeof(parent_guide) = 'object'
      AND (NOT parent_guide ? 'needs' OR jsonb_typeof(parent_guide->'needs') = 'array')
      AND (NOT parent_guide ? 'needs' OR jsonb_array_length(parent_guide->'needs') <= 20)
      AND (NOT parent_guide ? 'about' OR jsonb_typeof(parent_guide->'about') = 'string')
      AND (NOT parent_guide ? 'help' OR jsonb_typeof(parent_guide->'help') = 'string')
      AND (NOT parent_guide ? 'avoid' OR jsonb_typeof(parent_guide->'avoid') = 'string')
      AND (
        NOT parent_guide ? 'minutes'
        OR jsonb_typeof(parent_guide->'minutes') = 'null'
        OR (jsonb_typeof(parent_guide->'minutes') = 'number' AND (parent_guide->>'minutes')::numeric BETWEEN 1 AND 600)
      )
      AND octet_length(parent_guide::text) <= 8000
    )
  );

-- Blank instructions are allowed: the minimum of 1 goes, the maximum of 8,000 stays.
ALTER TABLE homework_items DROP CONSTRAINT homework_items_body_len;
ALTER TABLE homework_items
  ADD CONSTRAINT homework_items_body_len CHECK (char_length(body) <= 8000);

-- An archived item is one with archived_at set, and the two archive columns go together.
ALTER TABLE homework_items
  ADD CONSTRAINT homework_items_archive_consistency CHECK (archived_by IS NULL OR archived_at IS NOT NULL);

-- archived_by is ON DELETE SET NULL from users: without an index each user deletion would scan the table (as in 027).
CREATE INDEX homework_items_archived_by_idx ON homework_items (archived_by) WHERE archived_by IS NOT NULL;

-- UPDATE is column-level only (grants.matrix.test.ts). The item's school, creator and creation time are in no list, so no
-- application path can change them and the privilege is absent as well as the code. term_id is not editable: the screen
-- never changes it.
GRANT UPDATE (class_id, subject_id, title, due_on, body, hand_in, parent_guide, updated_at, archived_at, archived_by)
  ON homework_items TO figbloom_app;
