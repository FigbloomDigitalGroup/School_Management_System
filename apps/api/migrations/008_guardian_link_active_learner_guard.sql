-- VS-2 review finding F-4 — archived learners cannot receive new guardian relationships.
-- Forward-only. Enforced in the database, not only in application prechecks.
--
-- Why a trigger and not an application lock: the application role has SELECT, INSERT on
-- learners and no UPDATE (migration 006). A SELECT ... FOR SHARE needs UPDATE privilege, so
-- the application cannot lock the learner row itself. This function runs as the table owner
-- (SECURITY DEFINER), takes FOR SHARE on the learner row, and so:
--   * an archive (an UPDATE) that commits concurrently makes the link wait, then refuse;
--   * a link that commits first makes the archive wait.
-- It applies whichever role writes the link, including figbloom_app after FIG-1605.

CREATE OR REPLACE FUNCTION guardian_links_active_learner_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_active boolean;
BEGIN
  SELECT active INTO v_active
  FROM learners
  WHERE id = NEW.learner_id AND tenant_id = NEW.tenant_id
  FOR SHARE;

  IF NOT FOUND OR v_active IS NOT TRUE THEN
    -- SQLSTATE P0002 is mapped to the same 404 as an unknown learner by the API.
    RAISE EXCEPTION 'learner is not an active learner of this school'
      USING ERRCODE = 'P0002';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION guardian_links_active_learner_guard() FROM PUBLIC;

DROP TRIGGER IF EXISTS guardian_links_active_learner ON guardian_links;
CREATE TRIGGER guardian_links_active_learner
  BEFORE INSERT OR UPDATE OF learner_id, tenant_id ON guardian_links
  FOR EACH ROW
  EXECUTE FUNCTION guardian_links_active_learner_guard();
