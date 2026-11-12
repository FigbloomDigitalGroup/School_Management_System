-- Staff and organization-admin accounts are removed through the edge functions, never by a direct DELETE.
--
-- delete-account (teachers, drivers, other staff, school admins) and remove-org-admin hold the rules for taking an
-- account away: who may remove whom, that a people-area holder never removes an administrator or a colleague with admin
-- access of their own, the audit entry that names who did it, and deleting the login as well as the profile.
--
-- None of that stops someone calling the API directly. profile_admin_manage is `for all`, so a school's own admin, an
-- organization's admin and, for teachers, drivers and other staff, a teacher or staff member holding the people area could
-- send `DELETE /rest/v1/profiles?id=eq.<id>` and skip every rule above: the row goes, the login is left behind, and the audit
-- log has only the database's own line. Nothing in the apps does this (the web and both phone apps call the functions), and
-- the functions run as the service role, where there is no signed-in user, so refusing it for signed-in callers takes
-- nothing away.
--
-- Left alone on purpose:
--   * the service role and the database owner (no auth.uid()): the edge functions, seeds and the e2e clean-up;
--   * a delete made by a foreign-key cascade (a school or a login being deleted, a learner's login going with them),
--     where pg_trigger_depth() is above 1: the database tidying up after something that was itself allowed;
--   * learners and parents: their accounts go through their own paths (deleteLearners, students_remove_login).

create or replace function guard_staff_profile_delete() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is null or pg_trigger_depth() > 1 then
    return old;
  end if;
  if old.role in ('school_admin', 'teacher', 'staff', 'driver', 'org_admin') then
    raise exception 'A staff account can''t be deleted directly: remove it from Students & staff (or Admins), which also deletes the login.'
      using errcode = '42501';
  end if;
  return old;
end $$;

create trigger profiles_guard_delete before delete on profiles
  for each row execute function guard_staff_profile_delete();
