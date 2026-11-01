-- Sick bay checks for 20261101300000_medical and 20261101300001_medical_storage_stock.
--
-- Runs against a local database that has the migrations applied, inside one
-- transaction that is rolled back. It makes its own two schools and people
-- (no seed data needed), so it also runs on a fresh copy of production's
-- schema. Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/medical.sql

\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------- helpers
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
-- A statement that must go through (its result is thrown away).
create function pg_temp.expect_ok(label text, stmt text) returns void language plpgsql as $$
begin
  begin execute stmt; raise notice 'PASS %', label;
  exception when others then raise notice 'FAIL %: % %', label, sqlstate, sqlerrm;
  end;
end $$;
create function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- fixtures (as postgres)
-- Two schools; at the first: a principal, a nurse (other staff with the
-- medical area), the class teacher of Check 2 West (no areas), another
-- teacher who doesn't teach it, two learners in it (the first with their
-- own login), a parent of each, and a Medical stock line.
create function pg_temp.person(p_key text, p_tenant uuid, p_role app_role, p_name text) returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v, 'med-check-' || p_key || '-' || v || '@example.invalid');
  insert into profiles (id, tenant_id, role, full_name) values (v, p_tenant, p_role, p_name);
  perform set_config('t.' || p_key, v::text, true);
  return v;
end $$;

with insert_a as (
  insert into tenants (name, slug, county) values ('Medical Check School', 'med-check-a-' || substr(md5(random()::text), 1, 8), 'Nairobi') returning id
) select set_config('t.a', insert_a.id::text, true) from insert_a;
with insert_b as (
  insert into tenants (name, slug, county) values ('Medical Check Other School', 'med-check-b-' || substr(md5(random()::text), 1, 8), 'Nairobi') returning id
) select set_config('t.b', insert_b.id::text, true) from insert_b;

select pg_temp.person('admin',    current_setting('t.a')::uuid, 'school_admin', 'Check Principal');
select pg_temp.person('nurse',    current_setting('t.a')::uuid, 'staff',        'Check Nurse');
select pg_temp.person('teacher',  current_setting('t.a')::uuid, 'teacher',      'Check Class Teacher');
select pg_temp.person('teacher2', current_setting('t.a')::uuid, 'teacher',      'Check Other Teacher');
select pg_temp.person('parent',   current_setting('t.a')::uuid, 'parent',       'Check Parent');
select pg_temp.person('parent2',  current_setting('t.a')::uuid, 'parent',       'Check Other Parent');
select pg_temp.person('learner',  current_setting('t.a')::uuid, 'student',      'Check Learner');
select pg_temp.person('other',    current_setting('t.b')::uuid, 'staff',        'Check Other-School Nurse');
insert into staff_permissions (tenant_id, profile_id, area) values
  (current_setting('t.a')::uuid, current_setting('t.nurse')::uuid, 'medical'),
  (current_setting('t.b')::uuid, current_setting('t.other')::uuid, 'medical');

insert into terms (tenant_id, name, year, index, starts_on, ends_on, is_current)
values (current_setting('t.a')::uuid, 'Check Term', 2026, 3, current_date - 30, current_date + 60, true);
with x as (
  insert into classes (tenant_id, name, form_level, class_teacher_id)
  values (current_setting('t.a')::uuid, 'Check 2 West', 2, current_setting('t.teacher')::uuid) returning id
) select set_config('t.class', x.id::text, true) from x;
with x as (
  insert into students (tenant_id, admission_no, full_name, class_id, profile_id)
  values (current_setting('t.a')::uuid, 'MED-1', 'Amani Check', current_setting('t.class')::uuid, current_setting('t.learner')::uuid) returning id
) select set_config('t.student', x.id::text, true) from x;
with x as (
  insert into students (tenant_id, admission_no, full_name, class_id)
  values (current_setting('t.a')::uuid, 'MED-2', 'Baraka Check', current_setting('t.class')::uuid) returning id
) select set_config('t.student2', x.id::text, true) from x;
insert into guardians (tenant_id, profile_id, student_id) values
  (current_setting('t.a')::uuid, current_setting('t.parent')::uuid, current_setting('t.student')::uuid),
  (current_setting('t.a')::uuid, current_setting('t.parent2')::uuid, current_setting('t.student2')::uuid);
-- health details need consent first (20261103100000_health_consent)
insert into health_consents (student_id, tenant_id, status, method, signed_by)
values (current_setting('t.student')::uuid, current_setting('t.a')::uuid, 'given', 'paper', 'Check guardian');
insert into student_health (student_id, tenant_id, allergies)
values (current_setting('t.student')::uuid, current_setting('t.a')::uuid, array['Penicillin']);
with x as (
  insert into inventory_items (tenant_id, name, category, tracking, quantity)
  values (current_setting('t.a')::uuid, 'Paracetamol 500mg tablets', 'medical', 'stock', 20) returning id
) select set_config('t.stock', x.id::text, true) from x;

-- ---------------------------------------------------------------- the nurse
select pg_temp.act_as(current_setting('t.nurse'));
set local role authenticated;

select pg_temp.check('the nurse holds medical, and is_staff() is not widened to them',
  has_perm(current_setting('t.a')::uuid, 'medical') and not is_staff());
with x as (
  insert into sick_bay_visits (tenant_id, student_id, complaint, temperature_c, assessment)
  values (current_setting('t.a')::uuid, current_setting('t.student')::uuid, 'Headache and fever', 38.6, 'Suspected malaria')
  returning id
) select set_config('t.visit', x.id::text, true) from x;
select pg_temp.check('a nurse with the medical area logs a visit', current_setting('t.visit', true) is not null);
with x as (
  insert into sick_bay_visits (tenant_id, student_id, complaint, outcome, time_out)
  values (current_setting('t.a')::uuid, current_setting('t.student2')::uuid, 'Grazed knee', 'class', now())
  returning id
) select set_config('t.visit2', x.id::text, true) from x;
select pg_temp.expect_eq('the board: one learner still in the sick bay',
  (select count(*) from sick_bay_visits where tenant_id = current_setting('t.a')::uuid and time_out is null), 1);
select pg_temp.expect_ok('the nurse gives paracetamol from the Medical stock',
  format($q$insert into visit_medications (tenant_id, visit_id, drug, dose, inventory_item_id, stock_quantity)
            values (%L, %L, 'Paracetamol', '1g', %L, 2)$q$, current_setting('t.a'), current_setting('t.visit'), current_setting('t.stock')));
select pg_temp.expect_error('but not more than is left',
  format($q$insert into visit_medications (tenant_id, visit_id, drug, dose, inventory_item_id, stock_quantity)
            values (%L, %L, 'Paracetamol', '1g', %L, 50)$q$, current_setting('t.a'), current_setting('t.visit'), current_setting('t.stock')), '23514');
select pg_temp.expect_eq('and sees what is left', (select quantity from medical_stock(current_setting('t.a')::uuid)), 18);
select pg_temp.expect_rows('the nurse sends the learner home',
  format($q$update sick_bay_visits set outcome = 'home', time_out = now() where id = %L$q$, current_setting('t.visit')), 1);
select pg_temp.expect_eq('which tells the learner''s guardian', (select count(*) from medical_notices where visit_id = current_setting('t.visit')::uuid), 1);
select pg_temp.expect_eq('but going back to class tells nobody (serious outcomes only, the default)',
  (select count(*) from medical_notices where visit_id = current_setting('t.visit2')::uuid), 0);
select pg_temp.expect_error('attendance is not changed by editing the visit',
  format($q$update sick_bay_visits set attendance_mark = 'excused' where id = %L$q$, current_setting('t.visit')), '42501');
select pg_temp.expect_ok('the nurse marks the learner excused in today''s register',
  format($q$select medical_mark_attendance(%L, 'excused')$q$, current_setting('t.visit')));
select pg_temp.expect_error('but not a learner who went back to class',
  format($q$select medical_mark_attendance(%L, 'excused')$q$, current_setting('t.visit2')), '22023');
select pg_temp.expect_eq('opening the record logs one audit event',
  (select count(*) from (select medical_record(current_setting('t.student')::uuid)) r) +
  (select count(*) from (select medical_record(current_setting('t.student')::uuid)) r), 2);
with x as (
  insert into medication_schedules (tenant_id, student_id, drug, dose, times, starts_on, ends_on)
  values (current_setting('t.a')::uuid, current_setting('t.student')::uuid, 'Artemether', '80mg', array['20:00', '08:00'], current_date, current_date + 2)
  returning id
) select set_config('t.schedule', x.id::text, true) from x;
select pg_temp.expect_eq('a schedule''s times are kept in order',
  (select count(*) from medication_schedules where id = current_setting('t.schedule')::uuid and times = array['08:00', '20:00']), 1);
select pg_temp.expect_ok('the nurse records the morning dose as given',
  format($q$insert into medication_doses (tenant_id, schedule_id, student_id, due_on, due_time, status)
            values (%L, %L, %L, current_date, '08:00', 'given')$q$, current_setting('t.a'), current_setting('t.schedule'), current_setting('t.student')));
select pg_temp.expect_error('but not a dose that isn''t on the schedule',
  format($q$insert into medication_doses (tenant_id, schedule_id, student_id, due_on, due_time, status)
            values (%L, %L, %L, current_date, '12:00', 'given')$q$, current_setting('t.a'), current_setting('t.schedule'), current_setting('t.student')), '22023');

reset role;
select pg_temp.expect_eq('the register says excused, with why',
  (select count(*) from attendance where student_id = current_setting('t.student')::uuid and mark = 'excused' and note = 'Sick bay: sent home'), 1);
select pg_temp.expect_eq('the audit trail has who opened the record, once, and no clinical detail',
  (select count(*) from audit_events where tenant_id = current_setting('t.a')::uuid and actor_id = current_setting('t.nurse')::uuid
      and metadata ->> 'medical_record' = current_setting('t.student') and event not ilike '%malaria%'), 1);
select pg_temp.expect_eq('the stock line went down by two', (select quantity from inventory_items where id = current_setting('t.stock')::uuid), 18);

-- ---------------------------------------------------------------- a teacher without the area
select pg_temp.act_as(current_setting('t.teacher'));
set local role authenticated;

select pg_temp.check('the class teacher is staff but doesn''t hold medical', is_staff() and not has_perm(current_setting('t.a')::uuid, 'medical'));
select pg_temp.expect_eq('a teacher without the area reads no visits', (select count(*) from sick_bay_visits), 0);
select pg_temp.expect_eq('or medicines given', (select count(*) from visit_medications), 0);
select pg_temp.expect_eq('or schedules', (select count(*) from medication_schedules), 0);
select pg_temp.expect_eq('or doses', (select count(*) from medication_doses), 0);
select pg_temp.expect_eq('or notices', (select count(*) from medical_notices), 0);
select pg_temp.expect_error('and can''t open a record',
  format($q$select medical_record(%L)$q$, current_setting('t.student')), '42501');
select pg_temp.expect_error('or log a visit',
  format($q$insert into sick_bay_visits (tenant_id, student_id, complaint) values (%L, %L, 'x')$q$,
         current_setting('t.a'), current_setting('t.student2')), '42501');
select pg_temp.expect_eq('the class teacher learns only who was sent home today',
  (select count(*) from sick_bay_class_status(current_setting('t.class')::uuid) s
    where s.student_id = current_setting('t.student')::uuid and s.status = 'sent_home'), 1);
select pg_temp.expect_eq('and nothing about the learner who went back to class',
  (select count(*) from sick_bay_class_status(current_setting('t.class')::uuid) s where s.student_id = current_setting('t.student2')::uuid), 0);

reset role;
select pg_temp.act_as(current_setting('t.teacher2'));
set local role authenticated;
select pg_temp.expect_eq('a teacher who doesn''t teach the class learns nothing', (select count(*) from sick_bay_class_status(current_setting('t.class')::uuid)), 0);

-- ---------------------------------------------------------------- guardians
reset role;
select pg_temp.act_as(current_setting('t.parent'));
set local role authenticated;

select pg_temp.expect_eq('a guardian sees their own child''s visit', (select count(*) from sick_bay_visits where student_id = current_setting('t.student')::uuid), 1);
select pg_temp.expect_eq('and only their own child''s', (select count(*) from sick_bay_visits), 1);
select pg_temp.expect_eq('with the medicine given', (select count(*) from visit_medications), 1);
select pg_temp.expect_eq('and the medication record', (select count(*) from medication_doses), 1);
select pg_temp.expect_eq('and the notice', (select count(*) from medical_notices where read_at is null), 1);
select pg_temp.expect_ok('and marks it read', format($q$select mark_medical_notices_read(%L)$q$, current_setting('t.student')));
select pg_temp.expect_eq('so it is read', (select count(*) from medical_notices where read_at is null), 0);
select pg_temp.expect_error('a guardian can''t open the nurse''s record view',
  format($q$select medical_record(%L)$q$, current_setting('t.student')), '42501');
with x as (
  insert into medication_requests (tenant_id, student_id, drug, dose, times_per_day, starts_on, ends_on, prescription_path)
  values (current_setting('t.a')::uuid, current_setting('t.student')::uuid, 'Amoxicillin', '250mg', 3, current_date, current_date + 4,
          current_setting('t.a') || '/medical/' || current_setting('t.student') || '/rx.jpg')
  returning id
) select set_config('t.request', x.id::text, true) from x;
select pg_temp.check('a guardian asks the nurse to give a prescribed medicine', current_setting('t.request', true) is not null);
select pg_temp.expect_error('but not for someone else''s child',
  format($q$insert into medication_requests (tenant_id, student_id, drug, dose, times_per_day, starts_on)
            values (%L, %L, 'Amoxicillin', '250mg', 3, current_date)$q$, current_setting('t.a'), current_setting('t.student2')), '42501');
select pg_temp.expect_error('or approve their own request',
  format($q$select approve_medication_request(%L, null, null, array['08:00'], null, null, null)$q$, current_setting('t.request')), '42501');
select pg_temp.expect_error('or change it to approved',
  format($q$update medication_requests set status = 'approved' where id = %L$q$, current_setting('t.request')), '42501');
select pg_temp.expect_ok('the guardian uploads the prescription photo to their child''s folder',
  format($q$insert into storage.objects (bucket_id, name, owner) values ('private-documents', %L, auth.uid())$q$,
         current_setting('t.a') || '/medical/' || current_setting('t.student') || '/rx.jpg'));
select pg_temp.expect_error('but not to another child''s',
  format($q$insert into storage.objects (bucket_id, name, owner) values ('private-documents', %L, auth.uid())$q$,
         current_setting('t.a') || '/medical/' || current_setting('t.student2') || '/rx.jpg'), '42501');
select pg_temp.expect_eq('and reads it back', (select count(*) from storage.objects where name like '%/medical/%'), 1);

reset role;
select pg_temp.act_as(current_setting('t.parent2'));
set local role authenticated;
select pg_temp.expect_eq('the other guardian sees none of it: visits', (select count(*) from sick_bay_visits where student_id = current_setting('t.student')::uuid), 0);
select pg_temp.expect_eq('requests', (select count(*) from medication_requests), 0);
select pg_temp.expect_eq('or the prescription', (select count(*) from storage.objects where name like '%/medical/%'), 0);

-- ---------------------------------------------------------------- learners
reset role;
select pg_temp.act_as(current_setting('t.learner'));
set local role authenticated;
select pg_temp.expect_eq('a learner can''t read another learner''s visit', (select count(*) from sick_bay_visits where student_id = current_setting('t.student2')::uuid), 0);
select pg_temp.expect_eq('(nor their own: it is their family''s and the nurse''s)', (select count(*) from sick_bay_visits), 0);
select pg_temp.expect_eq('or anyone''s medication', (select count(*) from medication_schedules), 0);

-- ---------------------------------------------------------------- the prescription photo
reset role;
select pg_temp.act_as(current_setting('t.teacher'));
set local role authenticated;
select pg_temp.expect_eq('a teacher reads other private documents but not the medical folder',
  (select count(*) from storage.objects where name like '%/medical/%'), 0);

reset role;
select pg_temp.act_as(current_setting('t.nurse'));
set local role authenticated;
select pg_temp.expect_eq('the nurse reads the prescription', (select count(*) from storage.objects where name like '%/medical/%'), 1);
select pg_temp.expect_ok('and approves the request into a schedule',
  format($q$select approve_medication_request(%L, null, null, array['07:00', '13:00', '19:00'], null, null, null)$q$, current_setting('t.request')));
select pg_temp.expect_eq('which is now on the learner''s schedules',
  (select count(*) from medication_schedules where student_id = current_setting('t.student')::uuid and drug = 'Amoxicillin'), 1);
select pg_temp.expect_error('and can''t be decided twice',
  format($q$select decline_medication_request(%L, 'no')$q$, current_setting('t.request')), '22023');

-- ---------------------------------------------------------------- the other school
reset role;
select pg_temp.act_as(current_setting('t.other'));
set local role authenticated;
select pg_temp.expect_eq('another school''s nurse reads none of this school''s visits', (select count(*) from sick_bay_visits), 0);
select pg_temp.expect_error('or opens its records',
  format($q$select medical_record(%L)$q$, current_setting('t.student')), '42501');
select pg_temp.expect_error('or logs a visit there',
  format($q$insert into sick_bay_visits (tenant_id, student_id, complaint) values (%L, %L, 'x')$q$,
         current_setting('t.a'), current_setting('t.student')), '42501');

-- ---------------------------------------------------------------- the principal
reset role;
select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
select pg_temp.expect_eq('a full admin reads every visit', (select count(*) from sick_bay_visits), 2);
select pg_temp.expect_eq('and the audit trail of who opened records',
  (select count(*) from audit_events where metadata ->> 'medical_record' = current_setting('t.student')), 1);

rollback;
