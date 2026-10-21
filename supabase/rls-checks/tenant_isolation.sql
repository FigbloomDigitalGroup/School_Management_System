-- Tenant/role isolation checks for 20261021000000 and 20261021000001.
--
-- Runs against a local database that has the migrations applied and
-- `npm run db:seed` data, entirely inside one transaction that is rolled
-- back -- nothing it creates survives. Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/tenant_isolation.sql
--
-- Not pgTAP (supabase/tests is reserved for that), just plain psql.

\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------- fixtures (as postgres)
select set_config('t.a',        (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.b',        (select id::text from tenants where slug = 'kisumu-boys'), true);
select set_config('t.admin',    (select id::text from profiles where role = 'school_admin'), true);
select set_config('t.parent',   (select id::text from profiles where role = 'parent'), true);
select set_config('t.student',  (select id::text from profiles where role = 'student'), true);
select set_config('t.teacher',  (select id::text from profiles where role = 'teacher'), true);
select set_config('t.driver',   (select id::text from profiles where role = 'driver'), true);
-- the seeded student is also one of the seeded parent's children
select set_config('t.child',    (select s.id::text from students s where s.profile_id = current_setting('t.student')::uuid), true);
select set_config('t.other',    (select s.id::text from students s
                                 where s.tenant_id = current_setting('t.a')::uuid
                                   and s.id not in (select student_id from guardians)
                                 order by s.admission_no limit 1), true);
select set_config('t.inv_child', (select id::text from fee_invoices where student_id = current_setting('t.child')::uuid limit 1), true);
select set_config('t.inv_other', (select id::text from fee_invoices where student_id = current_setting('t.other')::uuid limit 1), true);

insert into classes (tenant_id, name, form_level)
  values (current_setting('t.b')::uuid, 'RLS Check Form 1', (select form_level from classes limit 1));
insert into students (tenant_id, admission_no, full_name, class_id)
  values (current_setting('t.b')::uuid, 'RLS-CHECK-1', 'Other School Learner',
          (select id from classes where name = 'RLS Check Form 1'));
select set_config('t.b_student', (select id::text from students where admission_no = 'RLS-CHECK-1'), true);

insert into storage.objects (bucket_id, name) values
  ('private-documents', current_setting('t.a') || '/students/' || current_setting('t.child') || '/child-record.pdf'),
  ('private-documents', current_setting('t.a') || '/students/' || current_setting('t.other') || '/other-record.pdf'),
  ('private-documents', current_setting('t.a') || '/invoices/' || current_setting('t.inv_child') || '/child-proof.jpg'),
  ('private-documents', current_setting('t.a') || '/invoices/' || current_setting('t.inv_other') || '/other-proof.jpg'),
  ('private-documents', current_setting('t.a') || '/submissions/' || gen_random_uuid() || '/' || current_setting('t.child') || '/child-handin.pdf'),
  ('private-documents', current_setting('t.a') || '/submissions/' || gen_random_uuid() || '/' || current_setting('t.other') || '/other-handin.pdf'),
  ('public-assets', current_setting('t.a') || '/avatars/students-' || current_setting('t.child') || '.jpg'),
  ('public-assets', current_setting('t.b') || '/avatars/students-' || current_setting('t.b_student') || '.jpg');

insert into student_documents (tenant_id, student_id, uploaded_by, doc_type, file_path, file_name) values
  (current_setting('t.a')::uuid, current_setting('t.child')::uuid, current_setting('t.admin')::uuid, 'record', 'x', 'child.pdf'),
  (current_setting('t.a')::uuid, current_setting('t.other')::uuid, current_setting('t.admin')::uuid, 'record', 'y', 'other.pdf');

-- Expect a write to be refused with 42501 (RLS or one of the tenant triggers).
create function pg_temp.expect_denied(label text, stmt text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
    raise notice 'FAIL %: allowed', label;
  exception when others then
    if sqlstate = '42501' then raise notice 'PASS %', label;
    else raise notice 'FAIL %: refused for another reason (%: %)', label, sqlstate, sqlerrm; end if;
  end;
end $$;

-- Expect a write to succeed (then undo it).
create function pg_temp.expect_allowed(label text, stmt text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
    raise exception 'undo';
  exception when others then
    if sqlerrm = 'undo' then raise notice 'PASS %', label;
    else raise notice 'FAIL %: (%: %)', label, sqlstate, sqlerrm; end if;
  end;
end $$;

create function pg_temp.expect_eq(label text, actual bigint, expected bigint) returns void language plpgsql as $$
begin
  if actual = expected then raise notice 'PASS %', label;
  else raise notice 'FAIL %: got %, expected %', label, actual, expected; end if;
end $$;

grant execute on all functions in schema pg_temp to authenticated, anon;

create function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true)
$$;

-- ---------------------------------------------------------------- school admin
select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
select pg_temp.expect_denied('admin links another school''s learner as guardian', format(
  'insert into guardians (tenant_id, profile_id, student_id) values (%L, %L, %L)',
  current_setting('t.a'), current_setting('t.admin'), current_setting('t.b_student')));
select pg_temp.expect_denied('admin writes a guardian row into another school', format(
  'insert into guardians (tenant_id, profile_id, student_id) values (%L, %L, %L)',
  current_setting('t.b'), current_setting('t.parent'), current_setting('t.b_student')));
select pg_temp.expect_denied('admin files a record against another school''s learner', format(
  'insert into student_documents (tenant_id, student_id, uploaded_by, doc_type, file_path, file_name) values (%L, %L, %L, ''record'', ''z'', ''z.pdf'')',
  current_setting('t.a'), current_setting('t.b_student'), current_setting('t.admin')));
select pg_temp.expect_allowed('admin links a parent to a learner in their own school', format(
  'insert into guardians (tenant_id, profile_id, student_id) values (%L, %L, %L)',
  current_setting('t.a'), current_setting('t.parent'), current_setting('t.other')));
reset role;

-- ---------------------------------------------------------------- parent
select pg_temp.act_as(current_setting('t.parent'));
set local role authenticated;
select pg_temp.expect_eq('parent sees only their children''s private documents',
  (select count(*) from storage.objects where bucket_id = 'private-documents'), 3);
select pg_temp.expect_eq('parent sees none of another family''s private documents',
  (select count(*) from storage.objects where bucket_id = 'private-documents' and name like '%other-%'), 0);
select pg_temp.expect_eq('parent sees only their children''s document rows',
  (select count(*) from student_documents), 1);
select pg_temp.expect_eq('parent cannot list another school''s public assets',
  (select count(*) from storage.objects where bucket_id = 'public-assets' and name not like current_setting('t.a') || '/%'), 0);
reset role;

-- ---------------------------------------------------------------- student
select pg_temp.act_as(current_setting('t.student'));
set local role authenticated;
select pg_temp.expect_eq('student sees only their own private documents',
  (select count(*) from storage.objects where bucket_id = 'private-documents'), 3);
select pg_temp.expect_denied('student inserts their own course mark', format(
  'insert into course_marks (tenant_id, assessment_id, student_id, score, entered_by) values (%L, gen_random_uuid(), %L, 100, %L)',
  current_setting('t.a'), current_setting('t.child'), current_setting('t.student')));
select pg_temp.expect_denied('signed-in user writes to the audit log', format(
  'insert into audit_events (tenant_id, actor_label, event, category) values (%L, ''Forged'', ''Forged'', ''access'')',
  current_setting('t.a')));
reset role;

-- ---------------------------------------------------------------- teacher / driver
select pg_temp.act_as(current_setting('t.teacher'));
set local role authenticated;
select pg_temp.expect_eq('teacher still sees every private document in the school',
  (select count(*) from storage.objects where bucket_id = 'private-documents'), 6);
reset role;

select pg_temp.act_as(current_setting('t.driver'));
set local role authenticated;
select pg_temp.expect_eq('driver sees no private documents',
  (select count(*) from storage.objects where bucket_id = 'private-documents'), 0);
reset role;

-- ---------------------------------------------------------------- anonymous
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
select pg_temp.expect_eq('anonymous visitor cannot list public assets',
  (select count(*) from storage.objects where bucket_id = 'public-assets'), 0);
select pg_temp.expect_denied('anonymous visitor writes to the audit log',
  'insert into audit_events (tenant_id, actor_label, event, category) values (null, ''Forged'', ''Forged'', ''access'')');
reset role;

rollback;
