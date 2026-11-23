-- Phase 3 remediation (self-identified S-01, not a numbered review finding) — staff identity link.
-- Forward-only. Migration 018 is not edited.
--
-- 018 allowed staff_members.user_id to reference ANY row of users (the foreign key only proves the user
-- exists). A people administrator of school A could therefore link a directory record to a user who
-- belongs only to school B (or to a platform admin), and the difference between an accepted id and a
-- rejected one acted as an existence oracle for user ids.
--
-- A directory record may only be linked to a user who holds an active membership in the SAME school.
-- The trigger runs as the invoker: it reads school_memberships through the tenant policy, so a user
-- of another tenant is invisible exactly like a user that does not exist (one error, no oracle).
-- Provisioning logins for staff stays an Identity-module concern (deferred); this only stops the link
-- from crossing tenants.

CREATE FUNCTION public.staff_members_check_user_link() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id THEN
    RETURN NEW;
  END IF;
  PERFORM 1
    FROM public.school_memberships m
   WHERE m.user_id = NEW.user_id
     AND m.tenant_id = NEW.tenant_id
     AND m.archived_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user is not an active member of this school' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER staff_members_check_user_link
  BEFORE INSERT OR UPDATE OF user_id ON staff_members
  FOR EACH ROW EXECUTE FUNCTION public.staff_members_check_user_link();

REVOKE ALL ON FUNCTION public.staff_members_check_user_link() FROM PUBLIC;
