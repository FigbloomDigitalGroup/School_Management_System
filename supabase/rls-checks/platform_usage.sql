-- Platform > Usage & capacity (FIG-1450): platform_usage_counts() adds up each school's active learners and staff seats in the database.
--
-- The page used to read every active learner of the platform through the API, which answers at most 1,000 rows and says nothing when
-- it stops. This file proves the function equals an independent count over the raw rows for every school, and that only a platform
-- admin gets rows.
--
-- Runs against a local database with `npm run db:seed` and `db:seed-org` data, in one transaction that is rolled back. Every check
-- prints PASS, FAIL, KNOWN <bug> or INFO.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/platform_usage.sql
-- Check the psql exit code too. Do not run it while e2e or the integration tests are running.

\set ON_ERROR_STOP 1
begin;

create function pg_temp.check(label text, ok boolean, known text default null) returns void language plpgsql as $$
begin raise notice '% %', case when ok then 'PASS' when known is not null then 'KNOWN ' || known else 'FAIL' end, label; end $$;
create function pg_temp.info(label text) returns void language plpgsql as $$ begin raise notice 'INFO %', label; end $$;

create function pg_temp.usage_as(p_user uuid) returns jsonb language plpgsql as $$
declare j jsonb;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select coalesce(jsonb_agg(to_jsonb(u) order by u.tenant_id), '[]'::jsonb) into j from platform_usage_counts() u;
  reset role;
  return j;
exception when others then
  reset role;
  raise;
end $$;

select set_config('t.a', (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.admin', (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.a')::uuid order by id limit 1), true);
select set_config('t.teacher', (select id::text from profiles where login_id = 'TC-0002' and tenant_id = current_setting('t.a')::uuid), true);
select set_config('t.parent', (select id::text from profiles where login_id = 'PT-0002' and tenant_id = current_setting('t.a')::uuid), true);
select set_config('t.org', (select id::text from profiles where role = 'org_admin' order by id limit 1), true);
select set_config('t.super', (select id::text from profiles where role = 'super_admin' order by id limit 1), true);
select pg_temp.check('the seed has what these checks need (a platform admin, a school admin, a teacher, a parent, a group admin)',
  current_setting('t.admin') <> '' and current_setting('t.teacher') <> '' and current_setting('t.parent') <> '' and current_setting('t.org') <> '' and current_setting('t.super') <> '');

-- ---------------------------------------------------------------- the counts equal the raw rows
select pg_temp.check('the platform admin gets one row per school, with the active learners and the school admins and teachers counted from the raw rows',
  pg_temp.usage_as(current_setting('t.super')::uuid)
    = (select coalesce(jsonb_agg(jsonb_build_object(
          'tenant_id', t.id,
          'learners', (select count(*) from students s where s.tenant_id = t.id and s.active),
          'staff', (select count(*) from profiles p where p.tenant_id = t.id and p.role in ('school_admin', 'teacher'))) order by t.id), '[]'::jsonb)
         from tenants t)
  and jsonb_array_length(pg_temp.usage_as(current_setting('t.super')::uuid)) = (select count(*) from tenants));
select pg_temp.check('Alliance''s count is its active learners (archived ones are not counted)',
  (select (x->>'learners')::int from jsonb_array_elements(pg_temp.usage_as(current_setting('t.super')::uuid)) x where (x->>'tenant_id')::uuid = current_setting('t.a')::uuid)
    = (select count(*) from students where tenant_id = current_setting('t.a')::uuid and active));
insert into students (tenant_id, admission_no, full_name, gender, class_id)
  select current_setting('t.a')::uuid, 'USAGE-1', 'Usage check', 'female', id from classes where tenant_id = current_setting('t.a')::uuid order by name limit 1;
select pg_temp.check('adding a learner adds one to the school''s count and to nobody else''s',
  (select (x->>'learners')::int from jsonb_array_elements(pg_temp.usage_as(current_setting('t.super')::uuid)) x where (x->>'tenant_id')::uuid = current_setting('t.a')::uuid)
    = (select count(*) from students where tenant_id = current_setting('t.a')::uuid and active)
  and (select sum((x->>'learners')::int) from jsonb_array_elements(pg_temp.usage_as(current_setting('t.super')::uuid)) x)
    = (select count(*) from students where active));
update students set active = false, archived_at = now() where tenant_id = current_setting('t.a')::uuid and admission_no = 'USAGE-1';
select pg_temp.check('archiving that learner takes the count back down',
  (select sum((x->>'learners')::int) from jsonb_array_elements(pg_temp.usage_as(current_setting('t.super')::uuid)) x)
    = (select count(*) from students where active));

-- ---------------------------------------------------------------- who gets rows
select pg_temp.check('a school admin, a teacher, a parent and a group admin get no rows',
  pg_temp.usage_as(current_setting('t.admin')::uuid) = '[]'::jsonb
  and pg_temp.usage_as(current_setting('t.teacher')::uuid) = '[]'::jsonb
  and pg_temp.usage_as(current_setting('t.parent')::uuid) = '[]'::jsonb
  and pg_temp.usage_as(current_setting('t.org')::uuid) = '[]'::jsonb);
select pg_temp.check('anon cannot execute the function; a signed-in user can',
  not has_function_privilege('anon', 'platform_usage_counts()', 'execute') and has_function_privilege('authenticated', 'platform_usage_counts()', 'execute'));

rollback;
