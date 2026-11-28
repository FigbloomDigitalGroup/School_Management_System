# Learning materials API: drafts and archive (W1.2)

W1.2 extends the existing `learning_materials` metadata table and its current routes. Uploaded file bytes remain out of scope; an optional HTTPS link is stored directly on the material.

- Migration 127 adds `url`, `published_at`, and `archived_at`. Existing rows are backfilled as published at their creation time to preserve their current family visibility.
- New materials start as drafts. `PATCH` edits title, description, class, subject, or link. Publish and unpublish are separate explicit actions.
- Archive is a one-way, idempotent action. It hides a row from school, teacher, and family lists without deleting the record. There is no restore route.
- Family reads return only published, non-archived rows and may include an HTTPS external link. Teacher and school reads can see drafts.
- `created_at`, `created_by`, and `tenant_id` remain immutable; DELETE stays revoked on the table. Updates use column-level grants and every write emits an audit event with the material id.
