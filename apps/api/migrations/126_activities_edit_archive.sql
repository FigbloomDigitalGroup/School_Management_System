-- Activities: details, closure, association management and non-destructive archive (W1.4, docs/ACTIVITIES.md).
-- Migration 056 tables and constraints remain unchanged; no delete privilege is added on activities.

ALTER TABLE activities ADD COLUMN archived_at timestamptz;

-- Activities already has column-level update grants for its mutable details and active state.
GRANT UPDATE (archived_at) ON activities TO figbloom_app;
GRANT UPDATE (role) ON activity_members TO figbloom_app;
GRANT DELETE ON activity_patrons, activity_members TO figbloom_app;
