-- Other staff checks for 20261028100001_other_staff (the visitor log is the
-- visitors admin area since 20261031000000; supabase/rls-checks/permissions.sql
-- checks the areas themselves).
--
-- Runs against a local database that has the migrations applied and
-- `npm run db:seed` data (SF-0001, other staff with the visitors area), inside
-- one transaction that is rolled back. Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/other_staff.sql

\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------- fixtures (as postgres)
select set_config('t.a',       (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.admin',   (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.a')::uuid limit 1), true);
select set_config('t.teacher', (select id::text from profiles where role = 'teacher' and tenant_id = current_setting('t.a')::uuid limit 1), true);
select set_config('t.staff',   (select id::text from profiles where role = 'staff' and tenant_id = current_setting('t.a')::uuid limit 1), true);

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when ok then 'PASS' else 'FAIL' end, label; end $$;
create function pg_temp.expect_eq(label text, actual bigint, expected bigint) returns void language plpgsql as $$
begin
  if actual = expected then raise notice 'PASS %', label;
  else raise notice 'FAIL %: got %, expected %', label, actual, expected; end if;
end $$;
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
grant execute on all functions in schema pg_temp to authenticated;

select pg_temp.check('the fixture has other staff with the visitor log, a teacher and a school admin',
  current_setting('t.staff', true) <> '' and current_setting('t.teacher', true) <> '' and current_setting('t.admin', true) <> ''
  and exists (select 1 from staff_permissions where profile_id = current_setting('t.staff')::uuid and area = 'visitors'));
select pg_temp.expect_eq('no guard or receptionist accounts are left',
  (select count(*) from profiles where role in ('guard', 'receptionist')), 0);

-- a notice to "All staff", as the composer sends it (audience.ts STAFF_ROLES)
insert into announcements (tenant_id, author_id, subject, body, audience, published_at)
values (current_setting('t.a')::uuid, current_setting('t.admin')::uuid, 'other-staff check', 'Staff meeting at 4pm.',
        '{"kind":"roles","roles":["school_admin","teacher","driver","staff"]}', now());

-- ---------------------------------------------------------------- other staff with the visitor log
select pg_temp.act_as(current_setting('t.staff'));
set local role authenticated;

select pg_temp.check('is_staff() stays school_admin or teacher: other staff are not in it', not is_staff());
select pg_temp.check('is_front_desk() is holding the visitors area', is_front_desk());

select pg_temp.expect_eq('other staff read no learners', (select count(*) from students), 0);
select pg_temp.expect_eq('other staff read only their own profile', (select count(*) from profiles), 1);
select pg_temp.expect_eq('other staff read no marks', (select count(*) from marks), 0);
select pg_temp.expect_eq('other staff read the "All staff" notice',
  (select count(*) from announcements where subject = 'other-staff check'), 1);

select pg_temp.expect_rows('with the visitor log they record a visitor at the gate',
  format($q$insert into visits (tenant_id, visitor_name, purpose, host_kind) values (%L, 'Check Visitor', 'other-staff check', 'office')$q$,
         current_setting('t.a')), 1);
select pg_temp.expect_rows('and move them along at reception',
  $q$update visits set status = 'at_reception' where purpose = 'other-staff check'$q$, 1);
select pg_temp.expect_rows('and escalate to the principal''s office',
  $q$update visits set escalated = true where purpose = 'other-staff check'$q$, 1);
select pg_temp.check('and pick a host from the school''s teachers and admins',
  (select count(*) from visit_hosts(current_setting('t.a')::uuid)) > 0);

select pg_temp.expect_error('they cannot give up or grant themselves the visitor log',
  format($q$select set_staff_areas(%L, array[]::text[])$q$, current_setting('t.staff')), '42501');
select pg_temp.expect_error('they cannot change their own title',
  format($q$update profiles set staff_title = 'Principal' where id = %L$q$, current_setting('t.staff')), '42501');
select pg_temp.expect_error('they cannot make themselves a teacher',
  format($q$update profiles set role = 'teacher' where id = %L$q$, current_setting('t.staff')), '42501');
select pg_temp.expect_rows('they can change their own phone',
  format($q$update profiles set phone = '+254700000001' where id = %L$q$, current_setting('t.staff')), 1);

-- ---------------------------------------------------------------- the office takes the visitor log away
reset role;
select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;

select pg_temp.expect_eq('the office can take the visitor log away',
  (select cardinality(set_staff_areas(current_setting('t.staff')::uuid, array[]::text[]))), 0);

-- ---------------------------------------------------------------- other staff without it
reset role;
select pg_temp.act_as(current_setting('t.staff'));
set local role authenticated;

select pg_temp.check('is_front_desk() is false without the visitor log', not is_front_desk());
select pg_temp.expect_eq('without it they read no visits', (select count(*) from visits), 0);
select pg_temp.expect_error('without it they cannot record a visitor',
  format($q$insert into visits (tenant_id, visitor_name, purpose, host_kind) values (%L, 'Check Visitor', 'other-staff check 2', 'office')$q$,
         current_setting('t.a')), '42501');
select pg_temp.expect_eq('without it the host picker is empty', (select count(*) from visit_hosts(current_setting('t.a')::uuid)), 0);
select pg_temp.expect_eq('without it they still read the "All staff" notice',
  (select count(*) from announcements where subject = 'other-staff check'), 1);

-- ---------------------------------------------------------------- the retired roles
reset role;
-- as the office, so guard_profile_self_edit lets the role change through and the check is what refuses it
select pg_temp.act_as(current_setting('t.admin'));

select pg_temp.expect_error('nobody can be made a guard again, not even by the database owner',
  format($q$update profiles set role = 'guard', handles_visitors = false where id = %L$q$, current_setting('t.staff')), '23514');
select pg_temp.expect_error('or a receptionist',
  format($q$update profiles set role = 'receptionist', handles_visitors = false where id = %L$q$, current_setting('t.staff')), '23514');

rollback;
