-- FIG-1305: archiving a learner ends their sign-in.
--
-- archive_learners() set students.active = false and wrote an audit event, and never touched the learner's login: auth.users.banned_until
-- stayed null, so a learner who had left the school kept a working login and could still read their own record and invoices. Now archiving
-- bans the learner's login the way suspending a school bans its users (20261026080000): banned_until 100 years out, and a flag in the
-- user's app_metadata ("archived_learner") so that restoring the learner lifts exactly that ban. Their sessions are ended too, so the next
-- refresh fails; the access token already in their hands keeps working until it expires (an hour at most).
--
-- Interplay with suspending a school: reactivating a school lifts the ban of the users it banned, and must not lift the ban of a learner
-- who has been archived in the meantime (sync_tenant_suspension keeps their ban); restoring a learner of a school that is still suspended
-- keeps the school's ban (the user still carries its flag).
--
-- Not done here (the issue lists it): a "left the school" step that ends the parents' access once the balance is settled. A parent still
-- sees an archived child and their invoices, which is right while fees are owed.
--
-- Learners archived before this migration are banned by it. supabase/rls-checks/roles_in_school.sql checks it.

create or replace function set_learner_login_ban(p_student_ids uuid[], p_ban boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_student_ids is null or cardinality(p_student_ids) = 0 then return; end if;
  if p_ban then
    update auth.users u
       set banned_until = now() + interval '100 years',
           raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb) || '{"archived_learner": true}'::jsonb
     where u.id in (select s.profile_id from students s where s.id = any (p_student_ids) and s.profile_id is not null);
    delete from auth.sessions
     where user_id in (select s.profile_id from students s where s.id = any (p_student_ids) and s.profile_id is not null);
  else
    update auth.users u
       set raw_app_meta_data = u.raw_app_meta_data - 'archived_learner',
           banned_until = case when u.raw_app_meta_data ->> 'suspended_with_school' = 'true' then u.banned_until else null end
     where u.id in (select s.profile_id from students s where s.id = any (p_student_ids) and s.profile_id is not null)
       and u.raw_app_meta_data ->> 'archived_learner' = 'true';
  end if;
end $$;
-- only the archive and restore functions below call it
revoke execute on function set_learner_login_ban(uuid[], boolean) from public, anon, authenticated;

create or replace function archive_learners(p_ids uuid[]) returns integer
language plpgsql security definer set search_path = public as $$
declare
  n int;
  v_ids uuid[];
begin
  perform set_config('figbloom.self_audited', 'true', true);  -- its own audit event (FIG-1326)
  if p_ids is null or cardinality(p_ids) = 0 then return 0; end if;
  if exists (select 1 from students where id = any (p_ids) and not has_perm(tenant_id, 'people')) then
    raise exception 'You can only archive learners at a school you administer.' using errcode = '42501';
  end if;

  with changed as (
    update students
       set active = false, archived_at = now(), archived_by = auth.uid()
     where id = any (p_ids) and active and has_perm(tenant_id, 'people')
    returning id, tenant_id, full_name
  ), logged as (
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    select tenant_id, auth.uid(), my_actor_label(),
           format('%s learner%s archived', count(*), case when count(*) = 1 then '' else 's' end), 'provisioning',
           jsonb_build_object('student_ids', jsonb_agg(id), 'names', jsonb_agg(full_name))
      from changed group by tenant_id
    returning 1
  )
  select count(*), array_agg(id) into n, v_ids from changed;
  perform set_learner_login_ban(v_ids, true);
  return n;
end $$;

create or replace function restore_learners(p_ids uuid[]) returns integer
language plpgsql security definer set search_path = public as $$
declare
  n int;
  v_ids uuid[];
begin
  perform set_config('figbloom.self_audited', 'true', true);  -- its own audit event (FIG-1326)
  if p_ids is null or cardinality(p_ids) = 0 then return 0; end if;
  if exists (select 1 from students where id = any (p_ids) and not has_perm(tenant_id, 'people')) then
    raise exception 'You can only restore learners at a school you administer.' using errcode = '42501';
  end if;

  with changed as (
    update students
       set active = true, archived_at = null, archived_by = null
     where id = any (p_ids) and not active and has_perm(tenant_id, 'people')
    returning id, tenant_id, full_name
  ), logged as (
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    select tenant_id, auth.uid(), my_actor_label(),
           format('%s learner%s restored', count(*), case when count(*) = 1 then '' else 's' end), 'provisioning',
           jsonb_build_object('student_ids', jsonb_agg(id), 'names', jsonb_agg(full_name))
      from changed group by tenant_id
    returning 1
  )
  select count(*), array_agg(id) into n, v_ids from changed;
  perform set_learner_login_ban(v_ids, false);
  return n;
end $$;

-- reactivating a school lifts its ban, but not the ban of a learner archived meanwhile
create or replace function sync_tenant_suspension() returns trigger
language plpgsql security definer set search_path = public, auth as $$
begin
  if new.status = 'suspended' then
    update auth.users u
       set banned_until = now() + interval '100 years',
           raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb) || '{"suspended_with_school": true}'::jsonb
     where u.id in (select p.id from profiles p where p.tenant_id = new.id and p.role <> 'super_admin')
       and (u.banned_until is null or u.banned_until < now());
  else
    update auth.users u
       set banned_until = case when u.raw_app_meta_data ->> 'archived_learner' = 'true' then u.banned_until else null end,
           raw_app_meta_data = u.raw_app_meta_data - 'suspended_with_school'
     where u.id in (select p.id from profiles p where p.tenant_id = new.id)
       and u.raw_app_meta_data ->> 'suspended_with_school' = 'true';
  end if;
  return new;
end $$;

-- learners archived before this migration
select set_learner_login_ban(array(select id from students where archived_at is not null and profile_id is not null), true);
