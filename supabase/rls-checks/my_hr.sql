-- "My HR" checks for 20261105710000_my_hr.
--
-- Runs against a local database that has the migrations applied, inside one transaction that is rolled back.
-- It makes its own schools, organisation and people, so it needs no seed. Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/my_hr.sql
--
-- What it shows: my_hr_status() answers only about the caller's own school and profile (it takes no arguments);
-- it is 'not_staff' for anyone who isn't an active, non-archived staff profile of a school that isn't suspended
-- (a parent, a student, an org admin, Figbloom staff, an archived teacher, a teacher of a suspended school); it is
-- 'off' for every staff member until MY_HR_ENABLED is on; then 'available' for teachers, drivers, other staff and
-- the school's admins, with or without any admin area; 'not_linked' at a school the platform doesn't know; a
-- target_not_enabled / target_not_linked "no" from the platform in the last hour hides it, but
-- target_no_handoff_url, an older "no" or a "yes" don't; only the service role reads the switch.

\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------- fixtures (as postgres)
create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when coalesce(ok, false) then 'PASS' else 'FAIL' end, label; end $$;
-- my_hr_status as this signed-in person, with the authenticated role (as the web app calls it)
create function pg_temp.status_as(uid uuid) returns text language plpgsql as $$
declare s text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    s := my_hr_status();
  exception when others then
    s := 'error ' || sqlstate;
  end;
  reset role;
  return s;
end $$;
create function pg_temp.signed_out() returns void language sql as $$ select set_config('request.jwt.claims', '', true) $$;
create function pg_temp.person(p_id uuid, p_tenant uuid, p_role app_role, p_name text) returns void
language sql as $$
  insert into auth.users (id, email) values (p_id, p_id::text || '@login.myhrcheck.figbloom.internal');
  insert into profiles (id, tenant_id, role, full_name) values (p_id, p_tenant, p_role, p_name);
$$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

insert into organizations (id, name, slug, kind, status) values
  ('00000000-0000-4000-8000-00000000b8f1', 'My HR Check Group', 'myhrcheck-group-' || substr(md5(random()::text), 1, 8), 'group_owner', 'active');
insert into tenants (id, name, slug, county, organization_id) values
  ('00000000-0000-4000-8000-00000000b801', 'My HR Check School', 'myhrcheck-a-' || substr(md5(random()::text), 1, 8), 'Nairobi', '00000000-0000-4000-8000-00000000b8f1'),
  ('00000000-0000-4000-8000-00000000b802', 'My HR Check Unlinked School', 'myhrcheck-b-' || substr(md5(random()::text), 1, 8), 'Nairobi', '00000000-0000-4000-8000-00000000b8f1'),
  ('00000000-0000-4000-8000-00000000b803', 'My HR Check Suspended School', 'myhrcheck-c-' || substr(md5(random()::text), 1, 8), 'Nairobi', '00000000-0000-4000-8000-00000000b8f1');

select pg_temp.person('00000000-0000-4000-8000-00000000b8a1', '00000000-0000-4000-8000-00000000b801', 'school_admin', 'My HR Check Principal');
select pg_temp.person('00000000-0000-4000-8000-00000000b8a2', '00000000-0000-4000-8000-00000000b801', 'teacher', 'My HR Check Teacher');
select pg_temp.person('00000000-0000-4000-8000-00000000b8a3', '00000000-0000-4000-8000-00000000b801', 'staff', 'My HR Check Cook');
select pg_temp.person('00000000-0000-4000-8000-00000000b8a4', '00000000-0000-4000-8000-00000000b801', 'driver', 'My HR Check Driver');
select pg_temp.person('00000000-0000-4000-8000-00000000b8a5', '00000000-0000-4000-8000-00000000b801', 'parent', 'My HR Check Parent');
select pg_temp.person('00000000-0000-4000-8000-00000000b8a6', '00000000-0000-4000-8000-00000000b801', 'student', 'My HR Check Student');
select pg_temp.person('00000000-0000-4000-8000-00000000b8a7', null, 'org_admin', 'My HR Check Org Admin');
select pg_temp.person('00000000-0000-4000-8000-00000000b8a8', null, 'super_admin', 'My HR Check Figbloom');
select pg_temp.person('00000000-0000-4000-8000-00000000b8a9', '00000000-0000-4000-8000-00000000b801', 'teacher', 'My HR Check Archived Teacher');
select pg_temp.person('00000000-0000-4000-8000-00000000b8aa', '00000000-0000-4000-8000-00000000b802', 'teacher', 'My HR Check Unlinked Teacher');
select pg_temp.person('00000000-0000-4000-8000-00000000b8ab', '00000000-0000-4000-8000-00000000b803', 'teacher', 'My HR Check Suspended Teacher');
insert into organization_admins (profile_id, organization_id) values
  ('00000000-0000-4000-8000-00000000b8a7', '00000000-0000-4000-8000-00000000b8f1');
update profiles set archived_at = now() where id = '00000000-0000-4000-8000-00000000b8a9';
update tenants set status = 'suspended' where id = '00000000-0000-4000-8000-00000000b803';
insert into platform_links (kind, local_id, platform_id) values
  ('tenant', '00000000-0000-4000-8000-00000000b801', 'pt-myhrcheck-a'),
  ('tenant', '00000000-0000-4000-8000-00000000b803', 'pt-myhrcheck-c')
  on conflict (kind, local_id) do nothing;
delete from platform_module_status where tenant_id = '00000000-0000-4000-8000-00000000b801';

create temp table hr_people (label text, uid uuid, expected text);
insert into hr_people values
  ('the school''s admin', '00000000-0000-4000-8000-00000000b8a1', 'available'),
  ('a teacher with no admin area', '00000000-0000-4000-8000-00000000b8a2', 'available'),
  ('other staff', '00000000-0000-4000-8000-00000000b8a3', 'available'),
  ('a driver', '00000000-0000-4000-8000-00000000b8a4', 'available'),
  ('a parent', '00000000-0000-4000-8000-00000000b8a5', 'not_staff'),
  ('a student', '00000000-0000-4000-8000-00000000b8a6', 'not_staff'),
  ('an org admin of the school''s organisation', '00000000-0000-4000-8000-00000000b8a7', 'not_staff'),
  ('Figbloom staff', '00000000-0000-4000-8000-00000000b8a8', 'not_staff'),
  ('an archived teacher', '00000000-0000-4000-8000-00000000b8a9', 'not_staff'),
  ('a teacher of a suspended school', '00000000-0000-4000-8000-00000000b8ab', 'not_staff');
grant select on hr_people to authenticated;

-- ---------------------------------------------------------------- who may run what
select pg_temp.check('signed-in people can ask my_hr_status; anon can''t',
  has_function_privilege('authenticated', 'my_hr_status()', 'execute')
  and not has_function_privilege('anon', 'my_hr_status()', 'execute'));
select pg_temp.check('only the service role reads the switch',
  not has_function_privilege('authenticated', 'my_hr_enabled()', 'execute')
  and not has_function_privilege('anon', 'my_hr_enabled()', 'execute')
  and has_function_privilege('service_role', 'my_hr_enabled()', 'execute'));
select pg_temp.check('nobody signed in reads platform_settings or platform_module_status directly',
  not has_table_privilege('authenticated', 'platform_module_status', 'select')
  and not has_table_privilege('anon', 'platform_module_status', 'select'));

-- ---------------------------------------------------------------- the switch
select pg_temp.check('MY_HR_ENABLED is there and off by default',
  exists (select 1 from platform_settings where key = 'MY_HR_ENABLED') and not my_hr_enabled());
select pg_temp.check('switched off: every staff member gets off, everyone else not_staff',
  not exists (select 1 from hr_people where pg_temp.status_as(uid) <> case when expected = 'available' then 'off' else 'not_staff' end));
select pg_temp.signed_out();
select pg_temp.check('nobody signed in: not_staff', my_hr_status() = 'not_staff');

update platform_settings set value = 'true', updated_at = now() where key = 'MY_HR_ENABLED';

-- ---------------------------------------------------------------- who
select pg_temp.check('switched on: ' || label || ' -> ' || expected, pg_temp.status_as(uid) = expected)
  from hr_people order by label;
select pg_temp.signed_out();
select pg_temp.check('a school the platform doesn''t know yet: not_linked',
  pg_temp.status_as('00000000-0000-4000-8000-00000000b8aa') = 'not_linked');
select pg_temp.signed_out();

-- ---------------------------------------------------------------- the platform's answers (open-hr's record)
set local role service_role;
select platform_record_module_status('00000000-0000-4000-8000-00000000b801', 'hr', false, 'target_not_enabled');
reset role;
select pg_temp.check('a target_not_enabled "no" in the last hour hides it',
  pg_temp.status_as('00000000-0000-4000-8000-00000000b8a2') = 'not_enabled');
select pg_temp.check('a "no" doesn''t make it appear for someone who isn''t staff',
  pg_temp.status_as('00000000-0000-4000-8000-00000000b8a5') = 'not_staff');
select pg_temp.signed_out();
set local role service_role;
select platform_record_module_status('00000000-0000-4000-8000-00000000b801', 'hr', false, 'target_not_linked');
reset role;
select pg_temp.check('a target_not_linked "no" in the last hour hides it',
  pg_temp.status_as('00000000-0000-4000-8000-00000000b8a3') = 'not_enabled');
select pg_temp.signed_out();
update platform_module_status set checked_at = now() - interval '61 minutes'
 where tenant_id = '00000000-0000-4000-8000-00000000b801' and module = 'hr';
select pg_temp.check('an older "no" doesn''t',
  pg_temp.status_as('00000000-0000-4000-8000-00000000b8a2') = 'available');
select pg_temp.signed_out();
set local role service_role;
select platform_record_module_status('00000000-0000-4000-8000-00000000b801', 'hr', false, 'target_no_handoff_url');
reset role;
select pg_temp.check('target_no_handoff_url doesn''t (HR is on and linked; it only can''t take sign-ins yet)',
  pg_temp.status_as('00000000-0000-4000-8000-00000000b8a2') = 'available');
select pg_temp.signed_out();
set local role service_role;
select platform_record_module_status('00000000-0000-4000-8000-00000000b801', 'hr', true, null);
reset role;
select pg_temp.check('a "yes" shows it',
  pg_temp.status_as('00000000-0000-4000-8000-00000000b8a1') = 'available');
select pg_temp.signed_out();

-- ---------------------------------------------------------------- restored
update profiles set archived_at = null where id = '00000000-0000-4000-8000-00000000b8a9';
select pg_temp.check('a restored teacher gets it again',
  pg_temp.status_as('00000000-0000-4000-8000-00000000b8a9') = 'available');
select pg_temp.signed_out();

rollback;
