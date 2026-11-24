-- Storage owner types for the web's upload uses (S6 part 1). Forward-only.
--
-- storage_objects.owner_resource_type grows from 4 to 10 values: payment proofs, homework attachments,
-- learning-material files, exam-paper files, avatars and school logos. Who may upload, finish, read and
-- delete each type is decided in the API (modules/storage/ownerTypes.ts, docs/STORAGE-OWNER-TYPES.md);
-- the table keeps its forced RLS, its tenant policies and its grants unchanged (migration 090).
--
-- Two of the new types are authorized by their owner, so the owner must be named: a payment proof names
-- the invoice it proves (a family may only touch proofs of its own children's invoices) and an avatar names
-- the person it shows (a member may manage their own photo). owner_resource_id is already immutable
-- (storage_objects_before_update), so that binding cannot change after the row is created.

ALTER TABLE storage_objects
  DROP CONSTRAINT storage_objects_owner_type_chk,
  ADD CONSTRAINT storage_objects_owner_type_chk CHECK (
    owner_resource_type IN (
      'directory_document',
      'export_artifact',
      'medication_authorization',
      'general',
      'payment_proof',
      'homework_attachment',
      'learning_material',
      'exam_paper',
      'avatar',
      'school_logo'
    )
  ),
  ADD CONSTRAINT storage_objects_owner_id_required_chk CHECK (
    owner_resource_type NOT IN ('payment_proof', 'avatar') OR owner_resource_id IS NOT NULL
  );
