-- Stage 8 adversarial audit — database invariants that were enforced only in application code
--
-- Forward-only. Migrations 001-027 are not edited.
--
-- Two gaps found by probing the live catalogue as `figbloom_app`, not by reading the migrations:
--
--   A-03. An ACTIVE guardian_links row could be inserted referencing an ARCHIVED guardian.
--         The application refuses it (addGuardianLink takes `SELECT … WHERE active = true FOR
--         SHARE`, the P3-AUDIT-007 fix), but the database did not. That is asymmetric with the
--         learner half of the same invariant, which migration 008 DOES enforce in the database,
--         and it is the "guardian_links guard" half of P3-AUDIT-009. Proven before this
--         migration: as figbloom_app, with only tenant context set, the insert succeeded against
--         a guardian whose `active` was false.
--
--   A-04. `logo_object_key` was revoked at column level for UPDATE by migration 027, but INSERT
--         privilege is table-wide, so a first write could still store a client-chosen key. For
--         `directory_documents.storage_key` migration 021 closes exactly this by overwriting any
--         client value in a BEFORE INSERT trigger; `school_profiles` never got the equivalent.
--         Proven before this migration: as figbloom_app, an INSERT carrying a well-shaped key for
--         the row's own tenant was accepted.
--
-- Neither gap is reachable through the HTTP API today. Both are defence in depth of an invariant
-- the application already relies on, in the same shape the approved migrations already use.

-- =====================================================================================
-- A-03. A live guardian relationship requires an ACTIVE guardian as well as an ACTIVE learner
-- =====================================================================================
--
-- Keeps migration 010's hardening (schema-qualified, fixed `pg_catalog, pg_temp` search path, no
-- EXECUTE for PUBLIC or figbloom_app) and migration 027's "when to check" logic. Only the second
-- lookup is new.
--
-- Both lookups take FOR SHARE, so a concurrent archive of either side waits for this row to
-- commit and then archives it, instead of committing first and leaving a live link behind.
-- The ARCHIVE direction is deliberately not checked: archiving a link, or a guardian-archive
-- cascade, moves `archived_at` from NULL to NOT NULL and must always be allowed — including for a
-- learner or guardian that is already archived.
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
      OR NEW.guardian_id IS DISTINCT FROM OLD.guardian_id
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

  SELECT g.active INTO v_active
  FROM public.guardians g
  WHERE g.id = NEW.guardian_id AND g.tenant_id = NEW.tenant_id
  FOR SHARE;

  IF NOT FOUND OR v_active IS NOT TRUE THEN
    -- Same SQLSTATE and the same API mapping as the learner half: the response must not
    -- distinguish "no such guardian" from "archived guardian" (F-3).
    RAISE EXCEPTION 'guardian is not an active guardian of this school'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guardian_links_active_learner_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guardian_links_active_learner_guard() FROM figbloom_app;

COMMENT ON FUNCTION public.guardian_links_active_learner_guard() IS
  'A live guardian_links row must reference an active learner AND an active guardian of the same '
  'tenant. Checked on INSERT, on a change of learner/guardian/tenant, and on un-archiving. '
  'Archiving is always permitted. Both lookups take FOR SHARE so a concurrent archive serialises.';

-- =====================================================================================
-- A-04. The school logo key is server-owned, exactly as directory_documents.storage_key is
-- =====================================================================================
--
-- Same approach as migration 021 for documents: a client value is DISCARDED rather than refused,
-- so no caller can distinguish "rejected" from "ignored" and no write fails for sending a field
-- it should not have sent. Column-level UPDATE is already revoked (027), so this closes INSERT.
-- When the storage integration arrives it replaces this function with one that assigns a key, in
-- its own forward migration.
CREATE OR REPLACE FUNCTION public.school_profiles_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  -- No object storage exists, so no logo object can exist for any row.
  NEW.logo_object_key := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS school_profiles_before_insert ON public.school_profiles;
CREATE TRIGGER school_profiles_before_insert
  BEFORE INSERT ON public.school_profiles
  FOR EACH ROW EXECUTE FUNCTION public.school_profiles_before_insert();

REVOKE ALL ON FUNCTION public.school_profiles_before_insert() FROM PUBLIC;

COMMENT ON COLUMN school_profiles.logo_object_key IS
  'Server-owned and currently always NULL: no object storage exists (P3-AUDIT-005). UPDATE is '
  'revoked at column level (migration 027) and any value supplied on INSERT is discarded '
  '(migration 028), mirroring directory_documents.storage_key.';
