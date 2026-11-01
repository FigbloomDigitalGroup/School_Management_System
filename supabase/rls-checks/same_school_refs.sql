-- Same-school reference checks for 20261103600000 (FIG-1313).
--
-- Runs against a local database that has the migrations applied and
-- `npm run db:seed` data, inside one transaction that is rolled back.
-- Every check prints PASS or FAIL (or SKIP when the seed has no row to try).
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/same_school_refs.sql

\set ON_ERROR_STOP 1
begin;

select set_config('t.a', (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.b', (select id::text from tenants where slug <> 'alliance' order by slug limit 1), true);
select set_config('t.admin', (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.a')::uuid limit 1), true);

-- ---------------------------------------------------------------- fixtures: one of each record in school B (as postgres)
-- `npm run db:seed` only fills Alliance, so B gets a record of each kind to point at.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000b001', 'fig1313-teacher@test.invalid'),
  ('00000000-0000-0000-0000-00000000b002', 'fig1313-student@test.invalid');
insert into profiles (id, role, full_name, tenant_id) values
  ('00000000-0000-0000-0000-00000000b001', 'teacher', 'B Teacher', current_setting('t.b')::uuid),
  ('00000000-0000-0000-0000-00000000b002', 'student', 'B Learner', current_setting('t.b')::uuid);
insert into terms (tenant_id, name, year, index, starts_on, ends_on, is_current)
  values (current_setting('t.b')::uuid, 'B term', 2027, 1, '2027-01-05', '2027-04-02', false);
insert into classes (tenant_id, name, form_level) values (current_setting('t.b')::uuid, 'B class', 1);
insert into subjects (tenant_id, name, code) values (current_setting('t.b')::uuid, 'B subject', 'BSUB');
insert into routes (tenant_id, name) values (current_setting('t.b')::uuid, 'B route');
insert into vehicles (tenant_id, plate_number) values (current_setting('t.b')::uuid, 'KBB 001B');
insert into strands (tenant_id, learning_area_id, grade, name)
  values (current_setting('t.b')::uuid, (select id from learning_areas limit 1), 1, 'B strand'),
         (current_setting('t.a')::uuid, (select id from learning_areas limit 1), 1, 'A strand');

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when ok then 'PASS' else 'FAIL' end, label; end $$;

-- Points one of school A's rows at one of school B's: tbl.col := a row of reftbl in B.
-- Runs as the table owner, so row-level security can't hide the row: what's tested is the trigger.
create function pg_temp.cross(tbl text, col text, reftbl text, ref_filter text default 'true', errcode text default '42501') returns void language plpgsql as $$
declare row_id uuid; ref_id uuid;
begin
  execute format('select id from %I where tenant_id = %L limit 1', tbl, current_setting('t.a')) into row_id;
  execute format('select id from %I where tenant_id = %L and %s limit 1', reftbl, current_setting('t.b'), ref_filter) into ref_id;
  if row_id is null or ref_id is null then
    raise notice 'SKIP %.% -> another school''s % (no seed row to try)', tbl, col, reftbl; return;
  end if;
  begin
    execute format('update %I set %I = %L where id = %L', tbl, col, ref_id, row_id);
    raise notice 'FAIL %.% -> another school''s %: allowed', tbl, col, reftbl;
  exception when others then
    if sqlstate = errcode then raise notice 'PASS %.% -> another school''s % (%)', tbl, col, reftbl, sqlerrm;
    else raise notice 'FAIL %.% -> another school''s %: % %', tbl, col, reftbl, sqlstate, sqlerrm; end if;
  end;
end $$;

-- ---------------------------------------------------------------- every school-to-school reference is guarded
select pg_temp.check('every foreign key between school tables has the same-school trigger (missing: '
    || coalesce(string_agg(m.tbl || '.' || m.col, ', '), 'none') || ')', count(*) = 0)
  from (
    with school as (
      select c.oid, c.relname from pg_class c
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
       where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
    )
    select s.relname as tbl, a.attname as col
      from pg_constraint k
      join school s on s.oid = k.conrelid
      join school r on r.oid = k.confrelid
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
     where k.contype = 'f' and array_length(k.conkey, 1) = 1 and a.attname <> 'tenant_id'
       and s.relname not in ('audit_events', 'impersonation_sessions', 'organization_access_log')
       and not exists (
         select 1 from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
          where tg.tgrelid = s.oid and p.proname = 'enforce_same_school_refs'
            and a.attname = any (string_to_array(rtrim(encode(tg.tgargs, 'escape'), '\000'), '\000')))
  ) m;

-- ---------------------------------------------------------------- the 11 tables QA 03 found open (FIG-1313)
select pg_temp.cross('announcements', 'author_id', 'profiles');
select pg_temp.cross('assignments', 'class_id', 'classes');
select pg_temp.cross('assignments', 'set_by', 'profiles');
select pg_temp.cross('assignments', 'subject_id', 'subjects');
select pg_temp.cross('classes', 'class_teacher_id', 'profiles', 'role = ''teacher''');
select pg_temp.cross('exams', 'term_id', 'terms');
select pg_temp.cross('fee_items', 'term_id', 'terms');
select pg_temp.cross('route_stops', 'route_id', 'routes');
-- strands_check (older, and first alphabetically) already refuses another school's parent strand
select pg_temp.cross('strands', 'parent_id', 'strands', 'true', 'P0001');
select pg_temp.cross('students', 'archived_by', 'profiles');
select pg_temp.cross('students', 'class_id', 'classes');
select pg_temp.cross('students', 'profile_id', 'profiles', 'role = ''student''');
select pg_temp.cross('teaching_assignments', 'class_id', 'classes');
select pg_temp.cross('teaching_assignments', 'subject_id', 'subjects');
select pg_temp.cross('teaching_assignments', 'teacher_id', 'profiles', 'role = ''teacher''');
select pg_temp.cross('timetable_slots', 'class_id', 'classes');
select pg_temp.cross('timetable_slots', 'subject_id', 'subjects');
select pg_temp.cross('vehicle_assignments', 'driver_id', 'profiles');
select pg_temp.cross('vehicle_assignments', 'route_id', 'routes');
select pg_temp.cross('vehicle_assignments', 'vehicle_id', 'vehicles');

-- ---------------------------------------------------------------- what must keep working
select set_config('t.class', (select id::text from classes where tenant_id = current_setting('t.a')::uuid limit 1), true);
select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$ begin
  update classes set class_teacher_id = (select id from profiles where tenant_id = current_setting('t.a')::uuid and role = 'teacher' limit 1)
   where id = current_setting('t.class')::uuid;
  raise notice 'PASS the admin sets a class teacher from their own school';
exception when others then raise notice 'FAIL the admin sets a class teacher from their own school: % %', sqlstate, sqlerrm; end $$;
do $$ begin
  -- by id: row-level security hides school B's profiles from this admin
  update classes set class_teacher_id = '00000000-0000-0000-0000-00000000b001'
   where id = current_setting('t.class')::uuid;
  raise notice 'FAIL the admin sets another school''s teacher as class teacher: allowed';
exception when others then
  raise notice '% the admin sets another school''s teacher as class teacher (%)', case when sqlstate = '42501' then 'PASS' else 'FAIL' end, sqlerrm;
end $$;
reset role;
do $$ begin
  update students set archived_by = (select id from profiles where tenant_id is null limit 1)
   where id = (select id from students where tenant_id = current_setting('t.a')::uuid limit 1);
  raise notice 'PASS a profile with no school (Figbloom staff, an org admin) can still be recorded on a school''s row';
exception when others then raise notice 'FAIL a profile with no school on a school''s row: % %', sqlstate, sqlerrm; end $$;
do $$ begin
  update classes set name = name where tenant_id = current_setting('t.a')::uuid;
  raise notice 'PASS an update that leaves the references alone still works';
exception when others then raise notice 'FAIL an update that leaves the references alone: % %', sqlstate, sqlerrm; end $$;

rollback;
