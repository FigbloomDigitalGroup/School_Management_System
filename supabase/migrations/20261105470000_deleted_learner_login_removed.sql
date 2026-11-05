-- FIG-1419: deleting a learner removes their login.
--
-- A learner with no records can be deleted (a learner added by mistake). If that learner had a login ("Create logins", the
-- provision-student function), the profile (role student, a login id such as ST-0003) and the Supabase Auth user were not touched: a
-- working login stayed behind that nobody could see or remove, because delete-account only removes staff.
--
-- An AFTER DELETE trigger on students now deletes the learner's Auth user when their profile is a student's (profiles.id references
-- auth.users on delete cascade, so the profile goes with it). It covers every way a learner is deleted: the People screen, the import
-- undo, a direct call. The guard for learners with records (guard_student_delete) still runs first, so a learner who has anything on
-- file is archived, not deleted, and keeps their login. When the delete is itself part of removing a whole school (trigger depth above
-- 1) nothing is done here, as before.
--
-- e2e/learners.spec.ts checks it (QA11-LOGIN).

create or replace function remove_deleted_learner_login() returns trigger
language plpgsql security definer set search_path = public, auth as $$
begin
  if pg_trigger_depth() > 1 then return old; end if;
  if old.profile_id is not null
     and exists (select 1 from profiles p where p.id = old.profile_id and p.role = 'student') then
    delete from auth.users where id = old.profile_id;
  end if;
  return old;
end $$;

create trigger students_remove_login after delete on students
  for each row execute function remove_deleted_learner_login();
