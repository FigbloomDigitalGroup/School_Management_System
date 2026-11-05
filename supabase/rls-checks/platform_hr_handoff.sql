-- Schools -> HR one-click sign-in checks for 20261105700000_platform_hr_handoff.
--
-- Runs against a local database that has the migrations applied, inside one transaction that is rolled back.
-- It makes its own schools, organisation and people, so it needs no seed. Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/platform_hr_handoff.sql
--
-- What it shows: the HR & Payroll item (hr_handoff_status) is refused (42501) to anyone who may not have it at the
-- school, so it says nothing about another school; it is off for everyone until PLATFORM_HANDOFF_ENABLED is on; then
-- it is there for the school's admin, an org admin of the school's organisation, and a teacher or other staff
-- member holding the fees area (directly or through a school role), and for nobody else (a teacher without it, a parent,
-- another school's admin, another organisation's admin, an org admin of a suspended organisation, Figbloom staff);
-- a school the platform doesn't know is 'not_linked'; a "no" from the platform hides it for an hour, a "yes" or an
-- older "no" doesn't; and only the service role can read the setting or record the platform's answer.

\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------- fixtures (as postgres)
create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when coalesce(ok, false) then 'PASS' else 'FAIL' end, label; end $$;
-- hr_handoff_status as this signed-in person, with the authenticated role (as the web app calls it);
-- 'forbidden' when it refuses them (42501), the error code when it fails otherwise
create function pg_temp.status_as(uid uuid, p_tenant uuid) returns text language plpgsql as $$
declare s text;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    s := hr_handoff_status(p_tenant);
  exception when others then
    s := case when sqlstate = '42501' then 'forbidden' else 'error ' || sqlstate end;
  end;
  reset role;
  return s;
end $$;
-- back to no one signed in (status_as leaves its claims set for the rest of the transaction)
create function pg_temp.signed_out() returns void language sql as $$ select set_config('request.jwt.claims', '', true) $$;
create function pg_temp.person(p_id uuid, p_tenant uuid, p_role app_role, p_name text) returns void
language sql as $$
  insert into auth.users (id, email) values (p_id, p_id::text || '@login.hrcheck.figbloom.internal');
  insert into profiles (id, tenant_id, role, full_name) values (p_id, p_tenant, p_role, p_name);
$$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

insert into organizations (id, name, slug, kind, status) values
  ('00000000-0000-4000-8000-00000000a7f1', 'HR Check Group', 'hrcheck-group-' || substr(md5(random()::text), 1, 8), 'group_owner', 'active'),
  ('00000000-0000-4000-8000-00000000a7f2', 'HR Check Other Group', 'hrcheck-other-' || substr(md5(random()::text), 1, 8), 'group_owner', 'active');
insert into tenants (id, name, slug, county, organization_id) values
  ('00000000-0000-4000-8000-00000000a701', 'HR Check School', 'hrcheck-a-' || substr(md5(random()::text), 1, 8), 'Nairobi', '00000000-0000-4000-8000-00000000a7f1'),
  ('00000000-0000-4000-8000-00000000a702', 'HR Check Other School', 'hrcheck-b-' || substr(md5(random()::text), 1, 8), 'Nairobi', '00000000-0000-4000-8000-00000000a7f2');

select pg_temp.person('00000000-0000-4000-8000-00000000a7a1', '00000000-0000-4000-8000-00000000a701', 'school_admin', 'HR Check Principal');
select pg_temp.person('00000000-0000-4000-8000-00000000a7a2', '00000000-0000-4000-8000-00000000a701', 'staff', 'HR Check Bursar');
select pg_temp.person('00000000-0000-4000-8000-00000000a7a3', '00000000-0000-4000-8000-00000000a701', 'teacher', 'HR Check Teacher');
select pg_temp.person('00000000-0000-4000-8000-00000000a7a4', '00000000-0000-4000-8000-00000000a701', 'teacher', 'HR Check Role Bursar');
select pg_temp.person('00000000-0000-4000-8000-00000000a7a5', '00000000-0000-4000-8000-00000000a701', 'parent', 'HR Check Parent');
select pg_temp.person('00000000-0000-4000-8000-00000000a7a6', '00000000-0000-4000-8000-00000000a702', 'school_admin', 'HR Check Other Principal');
select pg_temp.person('00000000-0000-4000-8000-00000000a7a7', null, 'org_admin', 'HR Check Org Admin');
select pg_temp.person('00000000-0000-4000-8000-00000000a7a8', null, 'org_admin', 'HR Check Other Org Admin');
select pg_temp.person('00000000-0000-4000-8000-00000000a7a9', null, 'super_admin', 'HR Check Figbloom');
insert into organization_admins (profile_id, organization_id) values
  ('00000000-0000-4000-8000-00000000a7a7', '00000000-0000-4000-8000-00000000a7f1'),
  ('00000000-0000-4000-8000-00000000a7a8', '00000000-0000-4000-8000-00000000a7f2');
insert into staff_permissions (tenant_id, profile_id, area) values
  ('00000000-0000-4000-8000-00000000a701', '00000000-0000-4000-8000-00000000a7a2', 'fees'),
  ('00000000-0000-4000-8000-00000000a701', '00000000-0000-4000-8000-00000000a7a3', 'people');
insert into school_roles (id, tenant_id, name, areas) values
  ('00000000-0000-4000-8000-00000000a7b1', '00000000-0000-4000-8000-00000000a701', 'HR Check Bursar role', array['fees']);
insert into staff_role_assignments (tenant_id, profile_id, role_id) values
  ('00000000-0000-4000-8000-00000000a701', '00000000-0000-4000-8000-00000000a7a4', '00000000-0000-4000-8000-00000000a7b1');
insert into platform_links (kind, local_id, platform_id) values ('tenant', '00000000-0000-4000-8000-00000000a701', 'pt-hrcheck')
  on conflict (kind, local_id) do nothing;
delete from platform_module_status where tenant_id = '00000000-0000-4000-8000-00000000a701';

create temp table hr_people (label text, uid uuid, school uuid, expected text);
insert into hr_people values
  ('the school''s admin', '00000000-0000-4000-8000-00000000a7a1', '00000000-0000-4000-8000-00000000a701', 'available'),
  ('a staff member with the fees area', '00000000-0000-4000-8000-00000000a7a2', '00000000-0000-4000-8000-00000000a701', 'available'),
  ('a teacher with the fees area through a school role', '00000000-0000-4000-8000-00000000a7a4', '00000000-0000-4000-8000-00000000a701', 'available'),
  ('an org admin of the school''s organisation', '00000000-0000-4000-8000-00000000a7a7', '00000000-0000-4000-8000-00000000a701', 'available'),
  ('a teacher with another area only', '00000000-0000-4000-8000-00000000a7a3', '00000000-0000-4000-8000-00000000a701', 'forbidden'),
  ('a parent', '00000000-0000-4000-8000-00000000a7a5', '00000000-0000-4000-8000-00000000a701', 'forbidden'),
  ('another school''s admin', '00000000-0000-4000-8000-00000000a7a6', '00000000-0000-4000-8000-00000000a701', 'forbidden'),
  ('another organisation''s admin', '00000000-0000-4000-8000-00000000a7a8', '00000000-0000-4000-8000-00000000a701', 'forbidden'),
  ('Figbloom staff', '00000000-0000-4000-8000-00000000a7a9', '00000000-0000-4000-8000-00000000a701', 'forbidden');
grant select on hr_people to authenticated;

-- ---------------------------------------------------------------- who may run what
select pg_temp.check('signed-in people can ask hr_handoff_status; anon can''t',
  has_function_privilege('authenticated', 'hr_handoff_status(uuid)', 'execute')
  and not has_function_privilege('anon', 'hr_handoff_status(uuid)', 'execute'));
select pg_temp.check('only the service role reads the switch or records the platform''s answer',
  not has_function_privilege('authenticated', 'platform_handoff_enabled()', 'execute')
  and not has_function_privilege('anon', 'platform_handoff_enabled()', 'execute')
  and not has_function_privilege('authenticated', 'platform_record_module_status(uuid, text, boolean, text)', 'execute')
  and not has_function_privilege('anon', 'platform_record_module_status(uuid, text, boolean, text)', 'execute')
  and has_function_privilege('service_role', 'platform_record_module_status(uuid, text, boolean, text)', 'execute')
  and has_function_privilege('service_role', 'platform_handoff_enabled()', 'execute'));
select pg_temp.check('nobody signed in reads or writes platform_module_status directly',
  not has_table_privilege('authenticated', 'platform_module_status', 'select')
  and not has_table_privilege('authenticated', 'platform_module_status', 'insert')
  and not has_table_privilege('anon', 'platform_module_status', 'select'));

-- ---------------------------------------------------------------- the switch
select pg_temp.check('PLATFORM_HANDOFF_ENABLED is off by default', not platform_handoff_enabled());
select pg_temp.check('switched off: nobody gets the item, not even the school''s admin (and the others are still refused)',
  not exists (select 1 from hr_people where pg_temp.status_as(uid, school) <> case when expected = 'available' then 'off' else 'forbidden' end));

select pg_temp.signed_out();
update platform_settings set value = 'true', updated_at = now() where key = 'PLATFORM_HANDOFF_ENABLED';

-- ---------------------------------------------------------------- who
select pg_temp.check('switched on: ' || label || ' -> ' || expected, pg_temp.status_as(uid, school) = expected)
  from hr_people order by label;
select pg_temp.signed_out();
do $$ begin
  perform hr_handoff_status('00000000-0000-4000-8000-00000000a701');
  raise notice 'FAIL nobody signed in gets an answer';
exception when insufficient_privilege then raise notice 'PASS nobody signed in gets an answer';
end $$;
select pg_temp.check('the org admin gets it for their own school only, not another organisation''s',
  pg_temp.status_as('00000000-0000-4000-8000-00000000a7a7', '00000000-0000-4000-8000-00000000a702') = 'forbidden');
select pg_temp.signed_out();
update organizations set status = 'suspended' where id = '00000000-0000-4000-8000-00000000a7f1';
select pg_temp.check('an org admin of a suspended organisation doesn''t get it',
  pg_temp.status_as('00000000-0000-4000-8000-00000000a7a7', '00000000-0000-4000-8000-00000000a701') = 'forbidden');
select pg_temp.signed_out();
update organizations set status = 'active' where id = '00000000-0000-4000-8000-00000000a7f1';

-- ---------------------------------------------------------------- the platform's answers
select pg_temp.check('a school the platform doesn''t know yet: not_linked, even for its admin',
  pg_temp.status_as('00000000-0000-4000-8000-00000000a7a6', '00000000-0000-4000-8000-00000000a702') = 'not_linked');

select pg_temp.signed_out();
set local role service_role;
select platform_record_module_status('00000000-0000-4000-8000-00000000a701', 'hr', false, 'target_not_enabled');
reset role;
select pg_temp.check('a "no" from the platform is recorded with its reason',
  (select not enabled and reason = 'target_not_enabled' from platform_module_status
    where tenant_id = '00000000-0000-4000-8000-00000000a701' and module = 'hr'));
select pg_temp.check('a "no" hides the item for the hour after it',
  pg_temp.status_as('00000000-0000-4000-8000-00000000a7a1', '00000000-0000-4000-8000-00000000a701') = 'not_enabled');
select pg_temp.check('a "no" doesn''t make the item appear for someone who never had it',
  pg_temp.status_as('00000000-0000-4000-8000-00000000a7a3', '00000000-0000-4000-8000-00000000a701') = 'forbidden');
select pg_temp.signed_out();
update platform_module_status set checked_at = now() - interval '61 minutes'
 where tenant_id = '00000000-0000-4000-8000-00000000a701' and module = 'hr';
select pg_temp.check('after the hour it shows again, so the next click asks again',
  pg_temp.status_as('00000000-0000-4000-8000-00000000a7a1', '00000000-0000-4000-8000-00000000a701') = 'available');

select pg_temp.signed_out();
set local role service_role;
select platform_record_module_status('00000000-0000-4000-8000-00000000a701', 'hr', false, 'target_not_linked');
select platform_record_module_status('00000000-0000-4000-8000-00000000a701', 'hr', true, 'ignored');
reset role;
select pg_temp.check('a "yes" replaces the "no" (one row per school and product, no reason kept)',
  (select count(*) = 1 and bool_and(enabled) and bool_and(reason is null) from platform_module_status
    where tenant_id = '00000000-0000-4000-8000-00000000a701' and module = 'hr'));
select pg_temp.check('a "yes" shows the item',
  pg_temp.status_as('00000000-0000-4000-8000-00000000a7a2', '00000000-0000-4000-8000-00000000a701') = 'available');

-- ---------------------------------------------------------------- the table
select pg_temp.check('a school''s rows go with it',
  (select confdeltype = 'c' from pg_constraint
    where conrelid = 'platform_module_status'::regclass and contype = 'f'));
do $$ begin
  insert into platform_module_status (tenant_id, module, enabled) values ('00000000-0000-4000-8000-00000000a701', 'Not A Module!', true);
  raise notice 'FAIL a module name must be a plain lower-case key';
exception when check_violation then raise notice 'PASS a module name must be a plain lower-case key';
end $$;

rollback;
