-- Phase 3 — Guardian profile update and link archival (FIG-1575)
-- Forward-only. Preserves VS-2 create/read/link. Does not widen area.people (FIG-1614).

GRANT UPDATE ON guardians TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON guardians FROM figbloom_app;

ALTER TABLE guardians
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

ALTER TABLE guardians
  DROP CONSTRAINT IF EXISTS guardians_archive_consistency;

ALTER TABLE guardians
  ADD CONSTRAINT guardians_archive_consistency CHECK (
    (active = true AND archived_at IS NULL)
    OR (active = false AND archived_at IS NOT NULL)
  );

-- Soft-archive links so historical relationships remain addressable; re-link allowed after archive.
ALTER TABLE guardian_links
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

ALTER TABLE guardian_links
  DROP CONSTRAINT IF EXISTS guardian_links_guardian_learner_uniq;

CREATE UNIQUE INDEX guardian_links_active_guardian_learner_uidx
  ON guardian_links (guardian_id, learner_id)
  WHERE archived_at IS NULL;

CREATE INDEX guardian_links_tenant_learner_active_idx
  ON guardian_links (tenant_id, learner_id)
  WHERE archived_at IS NULL;

GRANT UPDATE ON guardian_links TO figbloom_app;
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON guardian_links FROM figbloom_app;
