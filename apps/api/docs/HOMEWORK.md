# Homework edit and archive (W1.1)

This note records the API design for W1.1, which extends the existing `homework_items` table and its routes. It does not create a second homework feature.

## Access and lifecycle

- Creating, editing, and archiving homework require `resource.academics.write`, the same permission as creating an item today.
- Reads retain the existing tenant and class scopes. `PATCH` and archive first lock the tenant-scoped row; an unknown or cross-tenant id is a 404.
- The item can change class, subject, title, due date, instructions, hand-in method, and parent guide. Its term, tenant, creator, and creation time cannot change.
- `PATCH` omits unchanged fields; `parent_guide: null` clears the guide. Empty instructions are allowed, matching the live application.
- “Delete” is an archive. It sets `archived_at` and `archived_by`, never deletes data, and removes the item from teacher, parent, and learner lists. There is no restore. Repeated archive requests are refused; an archived item cannot be edited.
- Archive is idempotent by `Idempotency-Key`; replay returns the archived item and its timestamp. Audit records contain ids and changed field names, never titles, instructions, or guide text.

## Fields and family reads

`hand_in` is `paper`, `in_person`, or `upload`, defaulting to `paper`. `parent_guide` follows the live `assignments.parent_guide` shape: optional `about`, `needs`, `help`, `avoid`, and `minutes` fields, with the same limits and normalization as `packages/shared/src/homework.ts`.

The parent read returns the whole guide. A learner's own read returns only `needs` and `minutes`; guidance written for the parent (`about`, `help`, and `avoid`) is not exposed to the learner. Both reads include the teacher's name only, with no account id or contact details. Archived items are absent from both reads.

## Database change

Migration `125_homework_edit_archive.sql` adds the hand-in and parent-guide fields, archive metadata, and `updated_at`; relaxes the instructions constraint to allow a blank body; and grants column-level updates only for the editable fields. It preserves forced RLS, tenant policies, and the existing table-level insert grant. Hard delete remains unavailable to the runtime role.

The web screen moves in the W1.1 web slice after this API slice lands. Files remain out of scope; attachments are tracked separately under F3.
