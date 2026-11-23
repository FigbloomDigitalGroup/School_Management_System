-- Stage 8 — School Directory completion: lifecycle, least privilege and integrity (FIG-1575)
--
-- Forward-only. Migrations 001-026 are not edited. Four independent concerns, each from the
-- Phase 3 final audit register (apps/api/docs/PHASE3-FINAL-AUDIT-REPORT.md §4):
--
--   A. Guardian restore (P3-AUDIT-017 lifecycle gap). Archiving a guardian cascades over its
--      links; nothing could reverse it, so an operator mistake was permanent. A reason column
--      records WHY a link was archived, so restore reverses exactly the cascade and leaves a
--      deliberate unlink alone, and the migration-008 active-learner guard is extended to
--      un-archiving so a link can never come back onto an archived learner
--      (that half is also P3-AUDIT-009's "guardian_links one-way guard").
--
--   B. Column-level UPDATE grants (P3-AUDIT-009). Table-wide UPDATE let the runtime role rewrite
--      id, tenant_id, created_at and created_by on every directory table. No application path
--      does, but the privilege existed. Each table now grants UPDATE only on the columns its
--      module actually writes.
--
--   C. Document archive immutability + constraint validation (P3-AUDIT-014).
--
--   D. Indexes for the query shapes the list endpoints actually issue (P3-AUDIT-015).
--
-- No SECURITY DEFINER function is added. The one existing definer function this touches
-- (guardian_links_active_learner_guard, migration 008) keeps its definition's privilege model and
-- gains only the un-archive case.

-- =====================================================================================
-- A. Guardian link archive provenance and the extended active-learner guard
-- =====================================================================================

-- 'unlinked'          : someone removed this relationship on purpose (the default, and what every
--                       row written before this migration means — archiveGuardian's cascade had no
--                       way to mark itself, so pre-existing archived links are treated as
--                       deliberate unlinks and are NOT restored. That is the safe direction: it
--                       never resurrects a relationship nobody asked for).
-- 'guardian_archived' : archived only because the guardian was archived; restoring the guardian
--                       restores it.
-- The column is only meaningful while archived_at IS NOT NULL; restoring a link resets it.
ALTER TABLE guardian_links
  ADD COLUMN IF NOT EXISTS archived_reason text NOT NULL DEFAULT 'unlinked';

ALTER TABLE guardian_links
  DROP CONSTRAINT IF EXISTS guardian_links_archived_reason_chk;

ALTER TABLE guardian_links
  ADD CONSTRAINT guardian_links_archived_reason_chk
    CHECK (archived_reason IN ('unlinked', 'guardian_archived'));

-- Restore only ever looks at cascaded, still-archived links of one guardian.
CREATE INDEX IF NOT EXISTS guardian_links_guardian_cascade_idx
  ON guardian_links (tenant_id, guardian_id)
  WHERE archived_at IS NOT NULL AND archived_reason = 'guardian_archived';

-- The migration-008 guard refuses a link to an inactive learner on INSERT, and on an UPDATE that
-- changes learner_id or tenant_id. Un-archiving changes neither, so before this migration a
-- restored link could point at an archived learner — the invariant 008 exists to hold.
-- Now the guard also fires when archived_at goes from NOT NULL to NULL.
-- Keeps migration 010's hardening exactly: schema-qualified name and table reference, fixed
-- `pg_catalog, pg_temp` search path, no EXECUTE for PUBLIC or figbloom_app. Only the decision of
-- WHEN to look the learner up is new.
CREATE OR REPLACE FUNCTION public.guardian_links_active_learner_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_active boolean;
  v_check  boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_check := true;
  ELSE
    v_check :=
      NEW.learner_id IS DISTINCT FROM OLD.learner_id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      -- un-archive: the relationship becomes live again, so the live-relationship rule applies
      OR (OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL);
  END IF;

  IF NOT v_check THEN
    RETURN NEW;
  END IF;

  SELECT l.active INTO v_active
  FROM public.learners l
  WHERE l.id = NEW.learner_id AND l.tenant_id = NEW.tenant_id
  FOR SHARE;

  IF NOT FOUND OR v_active IS NOT TRUE THEN
    -- SQLSTATE P0002: mapped to HTTP 404 by the API layer (see migration 008).
    RAISE EXCEPTION 'learner is not an active learner of this school'
      USING ERRCODE = 'P0002';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guardian_links_active_learner_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guardian_links_active_learner_guard() FROM figbloom_app;

-- The trigger must now see every UPDATE, not only the two columns, so the un-archive case reaches
-- the function at all. The function itself decides when to do the lookup, so an ordinary archive
-- still costs nothing.
DROP TRIGGER IF EXISTS guardian_links_active_learner ON guardian_links;
CREATE TRIGGER guardian_links_active_learner
  BEFORE INSERT OR UPDATE ON guardian_links
  FOR EACH ROW
  EXECUTE FUNCTION guardian_links_active_learner_guard();

-- =====================================================================================
-- B. Column-level UPDATE grants (P3-AUDIT-009)
-- =====================================================================================
--
-- Each list below is exactly the set of columns the matching module writes. Identity columns
-- (id, tenant_id), provenance columns (created_at, created_by, uploaded_by) and the storage
-- contract columns (storage_key, storage_status, logo_object_key) are deliberately absent: no
-- application path writes them on UPDATE, and tenant_id in particular is already refused by the
-- RLS WITH CHECK clause, so this is a second, independent layer rather than the only one.
--
-- SELECT ... FOR UPDATE still works: PostgreSQL accepts a column-level UPDATE privilege on any
-- column of the relation for row locking, which is what the read-modify-write paths rely on
-- (P3-AUDIT-012).

REVOKE UPDATE ON learners FROM figbloom_app;
GRANT UPDATE (admission_no, full_name, gender, boarding, date_of_birth, active, archived_at, updated_at)
  ON learners TO figbloom_app;

REVOKE UPDATE ON guardians FROM figbloom_app;
GRANT UPDATE (full_name, phone, alt_phone, email, active, archived_at, updated_at)
  ON guardians TO figbloom_app;

REVOKE UPDATE ON guardian_links FROM figbloom_app;
GRANT UPDATE (archived_at, archived_reason) ON guardian_links TO figbloom_app;

REVOKE UPDATE ON staff_members FROM figbloom_app;
GRANT UPDATE (full_name, staff_title, classification, phone, email, user_id, active, archived_at, updated_at)
  ON staff_members TO figbloom_app;

-- logo_object_key is NOT granted: the API neither accepts nor returns it, and the storage
-- integration will assign it server-side (P3-AUDIT-005).
REVOKE UPDATE ON school_profiles FROM figbloom_app;
GRANT UPDATE (county, country, level, institution_type, contact_email, contact_phone,
              moe_registration, accent, updated_at)
  ON school_profiles TO figbloom_app;

-- Archiving is the only permitted change to a document (migration 021 trigger); the grant now
-- says the same thing in privileges.
REVOKE UPDATE ON directory_documents FROM figbloom_app;
GRANT UPDATE (archived_at, updated_at) ON directory_documents TO figbloom_app;

-- =====================================================================================
-- C. Document archive immutability and constraint validation (P3-AUDIT-014)
-- =====================================================================================

-- 021 added this NOT VALID so it would not scan rows written before the storage contract. Those
-- rows have since been rewritten by 021 itself, so the constraint can be validated and the
-- planner and future readers can rely on it.
ALTER TABLE directory_documents VALIDATE CONSTRAINT directory_documents_file_name_safe;

-- 021 refused a CHANGE to archived_at on an archived row, but allowed an UPDATE that touched only
-- updated_at — so an archived document's updated_at could still be bumped, and the row was not
-- actually frozen. Documents have no restore by design (021), so an archived row now accepts no
-- UPDATE at all.
CREATE OR REPLACE FUNCTION public.directory_documents_before_update() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF OLD.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'an archived directory document cannot be changed' USING ERRCODE = '23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.subject_type IS DISTINCT FROM OLD.subject_type
     OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.doc_type IS DISTINCT FROM OLD.doc_type
     OR NEW.file_name IS DISTINCT FROM OLD.file_name
     OR NEW.content_type IS DISTINCT FROM OLD.content_type
     OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
     OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
     OR NEW.storage_status IS DISTINCT FROM OLD.storage_status
     OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'directory document identity and storage fields are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.directory_documents_before_update() FROM PUBLIC;

-- 021's comment claimed "256 bits of randomness". Two gen_random_uuid() values are v4 UUIDs, which
-- carry 122 random bits each: the key holds ~244 bits, not 256. Still far beyond guessable; the
-- claim is corrected here rather than in 021, which is applied and not edited.
COMMENT ON COLUMN directory_documents.storage_key IS
  'Server-generated opaque object key: obj/<tenant uuid>/<64 hex>. The hex is two v4 UUIDs with '
  'the dashes removed, i.e. about 244 bits of randomness (not 256, as migration 021 stated). '
  'Never accepted from or returned to a client.';

COMMENT ON COLUMN guardian_links.archived_reason IS
  'Why this link is archived; meaningful only while archived_at IS NOT NULL. '
  '''unlinked'' = removed deliberately (the default, and the meaning of every row archived before '
  'migration 027). ''guardian_archived'' = archived by the guardian archive cascade, and therefore '
  'restored by restoreGuardian.';

-- =====================================================================================
-- D. Indexes for the list endpoints' actual query shapes (P3-AUDIT-015)
-- =====================================================================================
--
-- The existing name indexes lead with `active`, so they do not serve the default listing, which
-- does not filter on it (`?active=` omitted). The keyset also orders by id after the name, and by
-- (created_at, id) for `sort=created`.

CREATE INDEX IF NOT EXISTS learners_tenant_name_id_idx
  ON learners (tenant_id, lower(full_name), id);

CREATE INDEX IF NOT EXISTS learners_tenant_created_id_idx
  ON learners (tenant_id, created_at, id);

CREATE INDEX IF NOT EXISTS guardians_tenant_name_id_idx
  ON guardians (tenant_id, lower(full_name), id);

CREATE INDEX IF NOT EXISTS staff_members_tenant_name_id_idx
  ON staff_members (tenant_id, lower(full_name), id);

-- staff_members.user_id had a partial UNIQUE index over (tenant_id, user_id) only, so "which staff
-- row belongs to this user account" (restore, and the ON DELETE SET NULL from users) had no index.
CREATE INDEX IF NOT EXISTS staff_members_user_id_idx
  ON staff_members (user_id)
  WHERE user_id IS NOT NULL;

-- directory_documents.uploaded_by is ON DELETE SET NULL from users: unindexed, every user deletion
-- scans the table.
CREATE INDEX IF NOT EXISTS directory_documents_uploaded_by_idx
  ON directory_documents (uploaded_by)
  WHERE uploaded_by IS NOT NULL;
