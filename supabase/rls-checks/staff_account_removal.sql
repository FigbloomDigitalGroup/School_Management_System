-- Removing a staff account (20261112100000_staff_accounts_removed_through_the_function).
--
-- A staff or organization-admin profile can be deleted only by the edge functions (the service role, no signed-in user):
-- a school admin, an organization admin or a people-area holder who sends the DELETE to the API themselves is refused,
-- even where the profile_admin_manage policy would otherwise let them. A learner's or a parent's profile, a delete made by
-- a cascade, and the database owner are not affected.
--
-- Runs against a local database that has the migrations applied, inside one transaction that is rolled back. It builds
-- its own school and people, so it needs no seed data. Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/staff_account_removal.sql

\set ON_ERROR_STOP 1
begin;

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when ok then 'PASS' else 'FAIL' end, label; end $$;
-- A statement that must be refused with this SQLSTATE.
create function pg_temp.expect_error(label text, stmt text, errcode text) returns void language plpgsql as $$
begin
  begin execute stmt; raise notice 'FAIL %: allowed', label;
  exception when others then
    if sqlstate = errcode then raise notice 'PASS % (%)', label, sqlerrm;
    else raise notice 'FAIL %: % %', label, sqlstate, sqlerrm; end if;
  end;
end $$;
create function pg_temp.expect_rows(label text, stmt text, expected bigint) returns void language plpgsql as $$
declare n bigint;
begin
  execute stmt;
  get diagnostics n = row_count;
  if n = expected then raise notice 'PASS %', label;
  else raise notice 'FAIL %: % rows, expected %', label, n, expected; end if;
end $$;
create function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.person(p_id uuid, p_tenant uuid, p_role app_role, p_name text) returns void language sql as $$
  insert into auth.users (id, email) values (p_id, p_id::text || '@login.removalcheck.figbloom.internal');
  insert into profiles (id, tenant_id, role, full_name) values (p_id, p_tenant, p_role, p_name);
$$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

-- ---------------------------------------------------------------- fixtures (as postgres)
insert into tenants (id, name, slug, county) values
  ('00000000-0000-4000-8000-0000000fa001', 'Removal Check School', 'removalcheck-' || substr(md5(random()::text), 1, 8), 'Nairobi');

select pg_temp.person('00000000-0000-4000-8000-0000000fb001', '00000000-0000-4000-8000-0000000fa001', 'school_admin', 'Removal Admin');
select pg_temp.person('00000000-0000-4000-8000-0000000fb002', '00000000-0000-4000-8000-0000000fa001', 'school_admin', 'Removal Second Admin');
select pg_temp.person('00000000-0000-4000-8000-0000000fb003', '00000000-0000-4000-8000-0000000fa001', 'teacher', 'Removal Teacher');
select pg_temp.person('00000000-0000-4000-8000-0000000fb004', '00000000-0000-4000-8000-0000000fa001', 'teacher', 'Removal Bursar Teacher');
select pg_temp.person('00000000-0000-4000-8000-0000000fb005', '00000000-0000-4000-8000-0000000fa001', 'driver', 'Removal Driver');
select pg_temp.person('00000000-0000-4000-8000-0000000fb006', '00000000-0000-4000-8000-0000000fa001', 'staff', 'Removal Librarian');
select pg_temp.person('00000000-0000-4000-8000-0000000fb007', '00000000-0000-4000-8000-0000000fa001', 'staff', 'Removal People Holder');
select pg_temp.person('00000000-0000-4000-8000-0000000fb008', '00000000-0000-4000-8000-0000000fa001', 'parent', 'Removal Parent');
select pg_temp.person('00000000-0000-4000-8000-0000000fb009', '00000000-0000-4000-8000-0000000fa001', 'teacher', 'Removal Cascaded Teacher');
select pg_temp.person('00000000-0000-4000-8000-0000000fb00a', null, 'super_admin', 'Removal Platform Staff');
select pg_temp.person('00000000-0000-4000-8000-0000000fb00b', null, 'org_admin', 'Removal Org Admin');

insert into staff_permissions (tenant_id, profile_id, area) values
  ('00000000-0000-4000-8000-0000000fa001', '00000000-0000-4000-8000-0000000fb007', 'people'),
  ('00000000-0000-4000-8000-0000000fa001', '00000000-0000-4000-8000-0000000fb004', 'fees');

-- ---------------------------------------------------------------- the school's own admin, sending the DELETE themselves
select pg_temp.act_as('00000000-0000-4000-8000-0000000fb001');
set local role authenticated;

select pg_temp.check('the fixture: the school admin does see the school''s people (so the policy would let the delete through)',
  (select count(*) from profiles where tenant_id = '00000000-0000-4000-8000-0000000fa001') = 9);
select pg_temp.expect_error('a school admin cannot delete a teacher directly',
  $q$delete from profiles where id = '00000000-0000-4000-8000-0000000fb003'$q$, '42501');
select pg_temp.expect_error('nor another administrator',
  $q$delete from profiles where id = '00000000-0000-4000-8000-0000000fb002'$q$, '42501');
select pg_temp.expect_error('nor a driver',
  $q$delete from profiles where id = '00000000-0000-4000-8000-0000000fb005'$q$, '42501');
select pg_temp.expect_error('nor other staff',
  $q$delete from profiles where id = '00000000-0000-4000-8000-0000000fb006'$q$, '42501');
select pg_temp.expect_error('nor themselves',
  $q$delete from profiles where id = '00000000-0000-4000-8000-0000000fb001'$q$, '42501');
select pg_temp.expect_error('a whole school''s staff in one statement is no way round it',
  $q$delete from profiles where tenant_id = '00000000-0000-4000-8000-0000000fa001' and role in ('teacher', 'driver')$q$, '42501');

-- ---------------------------------------------------------------- a people-area holder, sending the DELETE themselves
reset role;
select pg_temp.act_as('00000000-0000-4000-8000-0000000fb007');
set local role authenticated;

select pg_temp.expect_error('a people-area holder cannot delete a teacher directly',
  $q$delete from profiles where id = '00000000-0000-4000-8000-0000000fb003'$q$, '42501');
select pg_temp.expect_error('nor a colleague who holds an admin area of their own',
  $q$delete from profiles where id = '00000000-0000-4000-8000-0000000fb004'$q$, '42501');
select pg_temp.expect_error('nor a driver',
  $q$delete from profiles where id = '00000000-0000-4000-8000-0000000fb005'$q$, '42501');

-- ---------------------------------------------------------------- an organization's admin
reset role;
insert into organization_admins (profile_id, organization_id)
select '00000000-0000-4000-8000-0000000fb00b', organization_id from tenants where id = '00000000-0000-4000-8000-0000000fa001';
select pg_temp.act_as('00000000-0000-4000-8000-0000000fb00b');
set local role authenticated;

select pg_temp.check('an organization''s admin reads its school''s administrators (the Administrators panel on the school''s page)',
  (select count(*) from profiles where tenant_id = '00000000-0000-4000-8000-0000000fa001' and role = 'school_admin') = 2);
select pg_temp.expect_error('but cannot delete one directly either (remove them from the panel, which goes through delete-account)',
  $q$delete from profiles where id = '00000000-0000-4000-8000-0000000fb002'$q$, '42501');

-- ---------------------------------------------------------------- what is not touched
reset role;
select pg_temp.act_as('00000000-0000-4000-8000-0000000fb001');
set local role authenticated;

select pg_temp.expect_rows('a school admin can still change a teacher''s details (only the delete is closed)',
  $q$update profiles set staff_title = 'Head of Maths' where id = '00000000-0000-4000-8000-0000000fb003'$q$, 1);
select pg_temp.expect_rows('and delete a parent''s profile as before (learners and parents have their own paths)',
  $q$delete from profiles where id = '00000000-0000-4000-8000-0000000fb008'$q$, 1);

-- ---------------------------------------------------------------- the service role: the edge functions
reset role;
select pg_temp.check('the fixture is still all there before the service role acts',
  (select count(*) from profiles where tenant_id = '00000000-0000-4000-8000-0000000fa001') = 8);
-- the service role's token carries a role and no user (PostgREST sets the claims from it)
select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
set local role service_role;
select pg_temp.expect_rows('the service role removes a teacher, as delete-account does',
  $q$delete from profiles where id = '00000000-0000-4000-8000-0000000fb003'$q$, 1);
select pg_temp.expect_rows('and a school administrator',
  $q$delete from profiles where id = '00000000-0000-4000-8000-0000000fb002'$q$, 1);
reset role;

-- ---------------------------------------------------------------- the database owner, and a login going: the cascade
select pg_temp.expect_rows('the database owner can delete a profile (seeds, clean-up)',
  $q$delete from profiles where id = '00000000-0000-4000-8000-0000000fb005'$q$, 1);

-- Deleting the Auth user (what auth.admin.deleteUser does) takes its profile with it, whoever is signed in
-- when it happens: the same cascade removes a school's staff when a school is deleted.
select pg_temp.act_as('00000000-0000-4000-8000-0000000fb001');
set local role authenticated;
select pg_temp.expect_error('a school admin cannot delete a login through the API either (auth.users is not theirs)',
  $q$delete from auth.users where id = '00000000-0000-4000-8000-0000000fb009'$q$, '42501');
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.expect_rows('deleting the login as the service role takes the profile with it',
  $q$delete from auth.users where id = '00000000-0000-4000-8000-0000000fb009'$q$, 1);
select pg_temp.check('and it is gone',
  not exists (select 1 from profiles where id = '00000000-0000-4000-8000-0000000fb009'));

-- A school being deleted takes its staff with it, by a cascade, even when the one deleting it is signed in: that is the
-- pg_trigger_depth() exemption, and the only way a signed-in caller's statement removes a staff profile.
select pg_temp.act_as('00000000-0000-4000-8000-0000000fb00a');
set local role authenticated;
select pg_temp.expect_error('not even Figbloom staff delete an organization admin directly (remove-org-admin does it)',
  $q$delete from profiles where id = '00000000-0000-4000-8000-0000000fb00b'$q$, '42501');
select pg_temp.expect_rows('Figbloom staff deleting a school',
  $q$delete from tenants where id = '00000000-0000-4000-8000-0000000fa001'$q$, 1);
reset role;
select pg_temp.check('takes its remaining staff with it (the cascade is not stopped by the guard)',
  not exists (select 1 from profiles where tenant_id = '00000000-0000-4000-8000-0000000fa001'));

rollback;
