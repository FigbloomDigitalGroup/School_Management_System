-- Learning materials: draft/publish, edit, external link and non-destructive archive (W1.2, docs/MATERIALS.md).
-- Migration 030's table, RLS, and storage metadata contract remain intact. File bytes are still not stored here.

ALTER TABLE learning_materials
  ADD COLUMN url text,
  ADD COLUMN published_at timestamptz,
  ADD COLUMN archived_at timestamptz;

-- Existing metadata was visible immediately. Preserve that behavior for rows that already exist; new rows default to draft.
UPDATE learning_materials SET published_at = created_at;

ALTER TABLE learning_materials
  ADD CONSTRAINT learning_materials_url_valid CHECK (
    url IS NULL OR (char_length(url) BETWEEN 1 AND 2000 AND url ~* '^https://[^\s/]+')
  );

-- The app may edit only the fields shown on the material form and the two lifecycle timestamps.
GRANT UPDATE (title, description, class_id, subject_id, url, published_at, archived_at)
  ON learning_materials TO figbloom_app;
