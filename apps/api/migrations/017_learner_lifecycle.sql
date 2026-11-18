-- Phase 3 — Learner lifecycle write grants (FIG-1575)
-- Forward-only. Schema from 006 already has active/archived_at + consistency check.
-- VS-1 was create/read only (SELECT, INSERT). Lifecycle update/archive needs UPDATE.

GRANT UPDATE ON learners TO figbloom_app;
-- Still no DELETE for the runtime role — archive is soft.
REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON learners FROM figbloom_app;
