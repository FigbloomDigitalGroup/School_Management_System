\set ON_ERROR_STOP 1
\pset pager off
\pset format unaligned
\pset tuples_only on
-- Cost of one call of each permission helper (my_tenant, is_staff, has_perm, ...) as a signed-in admin, teacher and parent,
-- and of one my_students() call. Needs the load school. Everything is rolled back:
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < tests/load/helpers.sql
-- Each helper is called 2,000 times; the last column is microseconds per call.
select id as t from tenants where slug = 'load-test' \gset
select id as admin from profiles where email = 'principal@load-test.sc.ke' \gset
select id as teacher from profiles where login_id = 'TC-L001' \gset
select id as parent from profiles where login_id = 'PT-L0001' \gset

create temp table bench (who text, fn text, calls int, ms numeric);
grant all on bench to public;

create or replace function pg_temp.time_it(p_who text, p_uid uuid, p_fn text, p_n int) returns void language plpgsql as $$
declare t0 timestamptz; t1 timestamptz;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  t0 := clock_timestamp();
  execute format('select count(%s) from generate_series(1,%s) g', p_fn, p_n);
  t1 := clock_timestamp();
  insert into bench values (p_who, p_fn, p_n, round((extract(epoch from (t1 - t0)) * 1000)::numeric, 1));
end $$;

begin;
set local role authenticated;
select pg_temp.time_it('admin',   :'admin',   'my_tenant()', 2000);
select pg_temp.time_it('admin',   :'admin',   'is_staff()', 2000);
select pg_temp.time_it('admin',   :'admin',   'is_super()', 2000);
select pg_temp.time_it('admin',   :'admin',   'my_role()', 2000);
select pg_temp.time_it('admin',   :'admin',   format('has_perm(%L, ''attendance'')', :'t'), 2000);
select pg_temp.time_it('admin',   :'admin',   format('may_administer(%L)', :'t'), 2000);
select pg_temp.time_it('teacher', :'teacher', 'my_tenant()', 2000);
select pg_temp.time_it('teacher', :'teacher', 'is_staff()', 2000);
select pg_temp.time_it('teacher', :'teacher', format('has_perm(%L, ''attendance'')', :'t'), 2000);
select pg_temp.time_it('parent',  :'parent',  'my_tenant()', 2000);
select pg_temp.time_it('parent',  :'parent',  format('has_perm(%L, ''attendance'')', :'t'), 2000);
select who, fn, calls, ms, round(ms / calls * 1000) as microseconds_per_call from bench order by who, fn;
rollback;

\echo ---- one call of my_students() (set-returning, runs per STATEMENT that uses it), rows returned and ms
begin; set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'teacher', 'role', 'authenticated')::text, true);
\timing on
select count(*) from my_students();
select count(*) from my_students();
\timing off
select set_config('request.jwt.claims', json_build_object('sub', :'parent', 'role', 'authenticated')::text, true);
\timing on
select count(*) from my_students();
select count(*) from my_students();
\timing off
rollback;
