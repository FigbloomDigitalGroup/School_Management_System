-- Suspended school / organization checks for 20261026080000_suspended_tenants_and_orgs.
--
-- Runs against a local database that has the migrations applied and
-- `npm run db:seed` data, inside one transaction that is rolled back.
-- Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/suspended.sql

\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------- fixtures (as postgres)
select set_config('t.a',       (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.admin',   (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.a')::uuid limit 1), true);
select set_config('t.teacher', (select id::text from profiles where role = 'teacher' and tenant_id = current_setting('t.a')::uuid limit 1), true);
select set_config('t.parent',  (select id::text from profiles where role = 'parent' and tenant_id = current_setting('t.a')::uuid limit 1), true);
select set_config('t.super',   (select id::text from profiles where role = 'super_admin' limit 1), true);
select set_config('t.student', (select id::text from profiles where role = 'student' and tenant_id = current_setting('t.a')::uuid limit 1), true);
update auth.users set banned_until = now() + interval '10 years' where id = current_setting('t.student')::uuid;
select set_config('t.n_students', (select count(*)::text from students where tenant_id = current_setting('t.a')::uuid), true);

-- an organization with one admin, and Alliance as a member school
insert into auth.users (id) values ('00000000-0000-4000-8000-0000000000a1');
insert into profiles (id, role, full_name) values ('00000000-0000-4000-8000-0000000000a1', 'org_admin', 'Check Org Admin');
insert into organizations (id, name, slug, kind, status)
  values ('00000000-0000-4000-8000-0000000000b1', 'Check Group', 'check-group', 'group_owner', 'active');
insert into organization_admins (profile_id, organization_id)
  values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1');
update tenants set organization_id = '00000000-0000-4000-8000-0000000000b1' where id = current_setting('t.a')::uuid;
select set_config('t.org_admin', '00000000-0000-4000-8000-0000000000a1', true);

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when ok then 'PASS' else 'FAIL' end, label; end $$;
create function pg_temp.expect_eq(label text, actual bigint, expected bigint) returns void language plpgsql as $$
begin
  if actual = expected then raise notice 'PASS %', label;
  else raise notice 'FAIL %: got %, expected %', label, actual, expected; end if;
end $$;
create function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true)
$$;
-- How many rows the signed-in person can see, as the authenticated role.
create function pg_temp.visible(tbl text) returns bigint language plpgsql as $$
declare n bigint;
begin execute format('select count(*) from %s', tbl) into n; return n; end $$;
grant execute on all functions in schema pg_temp to authenticated;

select pg_temp.check('the fixture has a school with learners, a teacher, a parent and a school admin',
  current_setting('t.n_students')::int > 0 and current_setting('t.teacher', true) <> ''
  and current_setting('t.parent', true) <> '' and current_setting('t.admin', true) <> '');

-- ---------------------------------------------------------------- the school is active: everyone sees their data
select pg_temp.act_as(current_setting('t.teacher')); set local role authenticated;
select pg_temp.expect_eq('active school: a teacher sees the learners', pg_temp.visible('students'), current_setting('t.n_students')::bigint);
reset role;
select pg_temp.act_as(current_setting('t.admin')); set local role authenticated;
select pg_temp.expect_eq('active school: the school admin sees the learners', pg_temp.visible('students'), current_setting('t.n_students')::bigint);
select pg_temp.check('active school: the school admin may administer it', may_administer(current_setting('t.a')::uuid));
select pg_temp.expect_eq('active school: the school admin sees their school', pg_temp.visible('tenants'), 1);
reset role;
select pg_temp.act_as(current_setting('t.org_admin')); set local role authenticated;
select pg_temp.expect_eq('active organization: its admin sees the member school', (select count(*) from tenants where id = current_setting('t.a')::uuid), 1);
select pg_temp.check('active organization: its admin may administer the member school', may_administer(current_setting('t.a')::uuid));
reset role;

-- ---------------------------------------------------------------- the school is suspended
update tenants set status = 'suspended' where id = current_setting('t.a')::uuid;

select pg_temp.act_as(current_setting('t.teacher')); set local role authenticated;
select pg_temp.expect_eq('suspended school: a teacher sees no learners', pg_temp.visible('students'), 0);
select pg_temp.expect_eq('suspended school: a teacher sees no attendance', pg_temp.visible('attendance'), 0);
select pg_temp.expect_eq('suspended school: a teacher sees no marks', pg_temp.visible('marks'), 0);
select pg_temp.expect_eq('suspended school: a teacher still sees their own profile', (select count(*) from profiles where id = current_setting('t.teacher')::uuid), 1);
reset role;

select pg_temp.act_as(current_setting('t.admin')); set local role authenticated;
select pg_temp.expect_eq('suspended school: the school admin sees no learners', pg_temp.visible('students'), 0);
select pg_temp.expect_eq('suspended school: the school admin sees no invoices', pg_temp.visible('fee_invoices'), 0);
select pg_temp.check('suspended school: the school admin may not administer it', not may_administer(current_setting('t.a')::uuid));
reset role;

-- A parent's invoice policy reads the guardians table directly, so it is the Auth ban, not
-- my_tenant(), that shuts a parent out: they keep what their current token can read until it
-- expires (up to an hour) and cannot sign in or refresh again.
select pg_temp.check('suspended school: a teacher is banned from signing in',
  (select banned_until > now() + interval '50 years' from auth.users where id = current_setting('t.teacher')::uuid));
select pg_temp.check('suspended school: the school admin is banned from signing in',
  (select banned_until > now() + interval '50 years' from auth.users where id = current_setting('t.admin')::uuid));
select pg_temp.check('suspended school: a parent is banned from signing in',
  (select banned_until > now() + interval '50 years' from auth.users where id = current_setting('t.parent')::uuid));
select pg_temp.check('suspended school: the super admin is not banned',
  (select banned_until is null from auth.users where id = current_setting('t.super')::uuid));
select pg_temp.check('suspended school: someone banned for another reason keeps their own ban',
  (select banned_until = now() + interval '10 years' from auth.users where id = current_setting('t.student')::uuid));
select pg_temp.check('suspended school: a user at another school is not banned',
  (select count(*) = 0 from auth.users u join profiles p on p.id = u.id
    where p.tenant_id <> current_setting('t.a')::uuid and u.banned_until is not null));

select pg_temp.act_as(current_setting('t.super')); set local role authenticated;
-- Alliance's learners only: other seeded schools (db:seed-org) are visible to the super admin too
select pg_temp.expect_eq('suspended school: the super admin still sees the learners',
  pg_temp.visible(format('students where tenant_id = %L', current_setting('t.a'))), current_setting('t.n_students')::bigint);
reset role;

-- ---------------------------------------------------------------- un-suspended: everything comes back
update tenants set status = 'active' where id = current_setting('t.a')::uuid;
select pg_temp.act_as(current_setting('t.teacher')); set local role authenticated;
select pg_temp.expect_eq('reactivated: a teacher sees the learners again', pg_temp.visible('students'), current_setting('t.n_students')::bigint);
reset role;
select pg_temp.check('reactivated: the teacher, school admin and parent can sign in again',
  (select count(*) = 3 from auth.users where banned_until is null
    and id in (current_setting('t.teacher')::uuid, current_setting('t.admin')::uuid, current_setting('t.parent')::uuid)));
select pg_temp.check('reactivated: the ban flag is gone',
  (select count(*) = 0 from auth.users where raw_app_meta_data ? 'suspended_with_school'));
select pg_temp.check('reactivated: someone banned for another reason is still banned',
  (select banned_until = now() + interval '10 years' from auth.users where id = current_setting('t.student')::uuid));

-- the other states keep working: only 'suspended' blocks
update tenants set status = 'overdue' where id = current_setting('t.a')::uuid;
select pg_temp.act_as(current_setting('t.admin')); set local role authenticated;
select pg_temp.expect_eq('overdue school: the school admin still sees the learners', pg_temp.visible('students'), current_setting('t.n_students')::bigint);
reset role;
update tenants set status = 'trial' where id = current_setting('t.a')::uuid;
select pg_temp.act_as(current_setting('t.admin')); set local role authenticated;
select pg_temp.expect_eq('trial school: the school admin still sees the learners', pg_temp.visible('students'), current_setting('t.n_students')::bigint);
reset role;
update tenants set status = 'active' where id = current_setting('t.a')::uuid;

-- ---------------------------------------------------------------- the organization is suspended
update organizations set status = 'suspended' where id = '00000000-0000-4000-8000-0000000000b1';
select pg_temp.act_as(current_setting('t.org_admin')); set local role authenticated;
select pg_temp.expect_eq('suspended organization: its admin no longer sees the member school', (select count(*) from tenants where id = current_setting('t.a')::uuid), 0);
select pg_temp.check('suspended organization: its admin may not administer the member school', not may_administer(current_setting('t.a')::uuid));
select pg_temp.expect_eq('suspended organization: its admin sees no learners at the member school', pg_temp.visible('students'), 0);
select pg_temp.expect_eq('suspended organization: its admin can still read their own organization (to see why)', (select count(*) from organizations where id = '00000000-0000-4000-8000-0000000000b1'), 1);
reset role;

-- and the member school itself carries on: suspending the organization is not suspending the school
select pg_temp.act_as(current_setting('t.admin')); set local role authenticated;
select pg_temp.expect_eq('suspended organization: the member school''s own admin is unaffected', pg_temp.visible('students'), current_setting('t.n_students')::bigint);
reset role;

rollback;
