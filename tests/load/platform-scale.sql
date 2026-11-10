\set ON_ERROR_STOP 1
\pset pager off
\pset format unaligned
\pset tuples_only on
-- Does one call of my_students() get slower as OTHER schools add learners? Run it on the seeded database, without the load school:
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < tests/load/platform-scale.sql
-- Learners are added to the nine empty schools inside a transaction and rolled back.
select id as at from tenants where slug = 'alliance' \gset
select id as ateacher from profiles where login_id = 'TC-0002' and tenant_id = :'at' \gset
select id as acls from classes where tenant_id = :'at' and class_teacher_id = :'ateacher' \gset
select id as aterm from terms where tenant_id = :'at' and is_current \gset

begin;
alter table students disable trigger students_class_required_for_k12;
alter table students disable trigger refresh_org_summary_students_ins;
alter table students disable trigger refresh_org_summary_students_upd;
alter table students disable trigger refresh_org_summary_students_del;

create or replace function pg_temp.measure(p_label text) returns void language plpgsql as $$
declare t0 timestamptz; n int; ms1 numeric; ms2 numeric; tot int;
begin
  select count(*) into tot from students;
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('qa.teacher'), 'role', 'authenticated')::text, true);
  set local role authenticated;
  t0 := clock_timestamp(); select count(*) into n from my_students(); ms1 := extract(epoch from clock_timestamp() - t0) * 1000;
  t0 := clock_timestamp(); select count(*) into n from my_students(); ms2 := extract(epoch from clock_timestamp() - t0) * 1000;
  reset role;
  raise notice '% | students on the platform: % | my_students() returns % rows | % ms and % ms', p_label, tot, n, round(ms1), round(ms2);
end $$;

select set_config('qa.teacher', :'ateacher', true);
select pg_temp.measure('as is');

insert into students (tenant_id, admission_no, full_name, class_id, boarding)
select t.id, 'SCALE-' || g, 'x', null, false from tenants t cross join generate_series(1, 1000) g where t.slug not in ('alliance', 'kijani-ridge', 'load-test');
analyze students;
select pg_temp.measure('+9,000 learners in other schools');

insert into students (tenant_id, admission_no, full_name, class_id, boarding)
select t.id, 'SCALE2-' || g, 'x', null, false from tenants t cross join generate_series(1, 3000) g where t.slug not in ('alliance', 'kijani-ridge', 'load-test');
analyze students;
select pg_temp.measure('+36,000 learners in other schools');
rollback;
