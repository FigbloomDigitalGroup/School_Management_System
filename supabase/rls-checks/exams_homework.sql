-- Exam publication and homework checks for 20261023000000_exam_marks_publication.
--
-- Runs against a local database that has the migrations applied and
-- `npm run db:seed` data, inside one transaction that is rolled back.
-- Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/exams_homework.sql

\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------- fixtures (as postgres)
select set_config('t.a',       (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.admin',   (select id::text from profiles where role = 'school_admin' and tenant_id = (select id from tenants where slug = 'alliance') limit 1), true);
select set_config('t.teacher', (select id::text from profiles where role = 'teacher' and tenant_id = (select id from tenants where slug = 'alliance') limit 1), true);
select set_config('t.parent',  (select id::text from profiles where role = 'parent' and tenant_id = (select id from tenants where slug = 'alliance') limit 1), true);
select set_config('t.student', (select id::text from profiles where role = 'student' and tenant_id = (select id from tenants where slug = 'alliance') limit 1), true);
select set_config('t.child',   (select id::text from students where profile_id = current_setting('t.student')::uuid), true);
select set_config('t.cls',     (select class_id::text from students where id = current_setting('t.child')::uuid), true);
-- another class in the same school, for "families only see their own class"
select set_config('t.cls2',    (select id::text from classes where tenant_id = current_setting('t.a')::uuid and id <> current_setting('t.cls')::uuid order by name limit 1), true);
-- the subject the seeded teacher teaches, and one they don't
select set_config('t.chem',    (select ta.subject_id::text from teaching_assignments ta where ta.teacher_id = current_setting('t.teacher')::uuid and ta.class_id = current_setting('t.cls')::uuid), true);
select set_config('t.math',    (select id::text from subjects where tenant_id = current_setting('t.a')::uuid and id <> current_setting('t.chem')::uuid order by name limit 1), true);

insert into exams (tenant_id, term_id, name, out_of)
  values (current_setting('t.a')::uuid, (select id from terms where tenant_id = current_setting('t.a')::uuid and is_current), 'RLS Check Exam', 100);
select set_config('t.exam', (select id::text from exams where name = 'RLS Check Exam'), true);

-- finished marks for the same learner in two subjects: one the teacher owns, one they don't
insert into marks (tenant_id, exam_id, student_id, subject_id, score, entered_by) values
  (current_setting('t.a')::uuid, current_setting('t.exam')::uuid, current_setting('t.child')::uuid, current_setting('t.chem')::uuid, 70, current_setting('t.teacher')::uuid),
  (current_setting('t.a')::uuid, current_setting('t.exam')::uuid, current_setting('t.child')::uuid, current_setting('t.math')::uuid, 80, current_setting('t.teacher')::uuid);

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
-- A statement that row-level security quietly turns into "0 rows".
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

-- ---------------------------------------------------------------- nothing is out yet
select pg_temp.act_as(current_setting('t.parent'));
set local role authenticated;
select pg_temp.expect_eq('parent sees none of an unpublished exam''s marks',
  (select count(*) from marks where exam_id = current_setting('t.exam')::uuid), 0);
reset role;

-- ---------------------------------------------------------------- the teacher publishes THEIR subject only
select pg_temp.act_as(current_setting('t.teacher'));
set local role authenticated;
select publish_marks(current_setting('t.exam')::uuid, current_setting('t.cls')::uuid, current_setting('t.chem')::uuid);
reset role;

select pg_temp.act_as(current_setting('t.parent'));
set local role authenticated;
select pg_temp.expect_eq('after the chemistry teacher publishes, the parent sees exactly that one subject',
  (select count(*) from marks where exam_id = current_setting('t.exam')::uuid), 1);
select pg_temp.expect_eq('...and it is chemistry, not the other teacher''s unfinished subject',
  (select count(*) from marks where exam_id = current_setting('t.exam')::uuid and subject_id = current_setting('t.math')::uuid), 0);
select pg_temp.expect_eq('class means are only given for the published subject',
  (select count(*) from class_means_for_exam(current_setting('t.exam')::uuid, current_setting('t.cls')::uuid)), 1);
reset role;

select pg_temp.act_as(current_setting('t.student'));
set local role authenticated;
select pg_temp.expect_eq('the learner sees the same single subject',
  (select count(*) from marks where exam_id = current_setting('t.exam')::uuid), 1);
reset role;

select pg_temp.check('the exam now counts as published (so result screens list it)',
  (select published_at is not null from exams where id = current_setting('t.exam')::uuid));
select pg_temp.check('the publication is audited with the teacher as actor',
  (select count(*) from audit_events where actor_id = current_setting('t.teacher')::uuid and event like '%RLS Check Exam results published%') = 1);

-- ---------------------------------------------------------------- what a teacher must not be able to do
select pg_temp.act_as(current_setting('t.teacher'));
set local role authenticated;
select pg_temp.expect_error('teacher publishes a subject they do not teach',
  format('select publish_marks(%L, %L, %L)', current_setting('t.exam'), current_setting('t.cls'), current_setting('t.math')), '42501');
select pg_temp.expect_error('teacher publishes a class with no marks',
  format('select publish_marks(%L, %L, %L)', current_setting('t.exam'), current_setting('t.cls2'), current_setting('t.chem')), '22023');
select pg_temp.expect_rows('teacher renames an exam directly',
  format('update exams set name = ''Hijacked'' where id = %L', current_setting('t.exam')), 0);
select pg_temp.expect_rows('teacher changes an exam''s total directly',
  format('update exams set out_of = 5 where id = %L', current_setting('t.exam')), 0);
select pg_temp.expect_rows('teacher unpublishes an exam by editing it',
  format('update exams set published_at = null where id = %L', current_setting('t.exam')), 0);
select pg_temp.expect_error('teacher writes a publication row directly',
  format('insert into mark_publications (exam_id, class_id, subject_id, tenant_id) values (%L, %L, %L, %L)',
    current_setting('t.exam'), current_setting('t.cls'), current_setting('t.math'), current_setting('t.a')), '42501');
reset role;

select pg_temp.act_as(current_setting('t.parent'));
set local role authenticated;
select pg_temp.expect_error('a parent publishes marks',
  format('select publish_marks(%L, %L, %L)', current_setting('t.exam'), current_setting('t.cls'), current_setting('t.chem')), '42501');
reset role;

-- ---------------------------------------------------------------- an admin can publish any subject; both can withdraw
select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
select publish_marks(current_setting('t.exam')::uuid, current_setting('t.cls')::uuid, current_setting('t.math')::uuid);
reset role;
select pg_temp.act_as(current_setting('t.parent'));
set local role authenticated;
select pg_temp.expect_eq('with an admin''s publish of the second subject, the parent sees both',
  (select count(*) from marks where exam_id = current_setting('t.exam')::uuid), 2);
reset role;

select pg_temp.act_as(current_setting('t.teacher'));
set local role authenticated;
select unpublish_marks(current_setting('t.exam')::uuid, current_setting('t.cls')::uuid, current_setting('t.chem')::uuid);
select pg_temp.expect_error('teacher withdraws a subject they do not teach',
  format('select unpublish_marks(%L, %L, %L)', current_setting('t.exam'), current_setting('t.cls'), current_setting('t.math')), '42501');
reset role;
select pg_temp.act_as(current_setting('t.parent'));
set local role authenticated;
select pg_temp.expect_eq('after the teacher withdraws chemistry, the parent sees only the admin-published subject',
  (select count(*) from marks where exam_id = current_setting('t.exam')::uuid), 1);
reset role;

select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
select unpublish_marks(current_setting('t.exam')::uuid, current_setting('t.cls')::uuid, current_setting('t.math')::uuid);
reset role;
select pg_temp.check('with nothing left out, the exam is no longer published',
  (select published_at is null from exams where id = current_setting('t.exam')::uuid));

-- ---------------------------------------------------------------- exams that have marks can't be deleted by hand
select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
select pg_temp.expect_error('admin deletes an exam that has marks',
  format('delete from exams where id = %L', current_setting('t.exam')), '23001');
reset role;
insert into exams (tenant_id, term_id, name, out_of)
  values (current_setting('t.a')::uuid, (select term_id from exams where id = current_setting('t.exam')::uuid), 'RLS Empty Exam', 50);
select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
select pg_temp.expect_rows('admin deletes an exam with no marks',
  'delete from exams where name = ''RLS Empty Exam''', 1);
reset role;

-- a whole term removed cascades through exams and marks and must still work
insert into terms (tenant_id, name, year, index, starts_on, ends_on, is_current)
  values (current_setting('t.a')::uuid, 'RLS Term', 2099, 1, '2099-01-01', '2099-04-01', false);
insert into exams (tenant_id, term_id, name, out_of)
  select current_setting('t.a')::uuid, id, 'RLS Cascade Exam', 100 from terms where name = 'RLS Term';
insert into marks (tenant_id, exam_id, student_id, subject_id, score, entered_by)
  select current_setting('t.a')::uuid, e.id, current_setting('t.child')::uuid, current_setting('t.chem')::uuid, 50, current_setting('t.teacher')::uuid
    from exams e where e.name = 'RLS Cascade Exam';
select pg_temp.expect_rows('removing a whole term still cascades through its exams and marks',
  'delete from terms where name = ''RLS Term''', 1);

-- ---------------------------------------------------------------- homework
-- a class-2 assignment the learner must not see, and an admin-set one a teacher must not touch
insert into assignments (tenant_id, class_id, subject_id, set_by, title, body, due_on)
  values (current_setting('t.a')::uuid, current_setting('t.cls2')::uuid, current_setting('t.chem')::uuid, current_setting('t.teacher')::uuid, 'RLS other class', '', current_date + 7),
         (current_setting('t.a')::uuid, current_setting('t.cls')::uuid, current_setting('t.math')::uuid, current_setting('t.admin')::uuid, 'RLS admin set', '', current_date + 7);

select pg_temp.act_as(current_setting('t.teacher'));
set local role authenticated;
select pg_temp.expect_rows('teacher sets homework for a class and subject they teach',
  format('insert into assignments (tenant_id, class_id, subject_id, set_by, title, body, due_on) values (%L, %L, %L, %L, ''RLS mine'', ''Read ch. 3'', current_date + 3)',
    current_setting('t.a'), current_setting('t.cls'), current_setting('t.chem'), current_setting('t.teacher')), 1);
select pg_temp.expect_error('teacher sets homework for a subject they do not teach',
  format('insert into assignments (tenant_id, class_id, subject_id, set_by, title, body, due_on) values (%L, %L, %L, %L, ''RLS bad'', '''', current_date + 3)',
    current_setting('t.a'), current_setting('t.cls'), current_setting('t.math'), current_setting('t.teacher')), '42501');
select pg_temp.expect_error('teacher sets homework in someone else''s name',
  format('insert into assignments (tenant_id, class_id, subject_id, set_by, title, body, due_on) values (%L, %L, %L, %L, ''RLS forged'', '''', current_date + 3)',
    current_setting('t.a'), current_setting('t.cls'), current_setting('t.chem'), current_setting('t.admin')), '42501');
select pg_temp.expect_rows('teacher edits their own homework',
  'update assignments set due_on = current_date + 10 where title = ''RLS mine''', 1);
select pg_temp.expect_error('teacher moves their own homework to a subject they do not teach',
  format('update assignments set subject_id = %L where title = ''RLS mine''', current_setting('t.math')), '42501');
select pg_temp.expect_rows('teacher edits homework someone else set',
  'update assignments set title = ''taken over'' where title = ''RLS admin set''', 0);
select pg_temp.expect_rows('teacher deletes homework someone else set',
  'delete from assignments where title = ''RLS admin set''', 0);
select pg_temp.expect_rows('teacher deletes their own homework',
  'delete from assignments where title = ''RLS mine''', 1);
reset role;

-- what the learner's class really has, counted without row-level security
select set_config('t.hw_own', (select count(*) from assignments where class_id = current_setting('t.cls')::uuid)::text, true);
select pg_temp.act_as(current_setting('t.student'));
set local role authenticated;
select pg_temp.expect_eq('a learner sees all of their own class''s homework',
  (select count(*) from assignments where class_id = current_setting('t.cls')::uuid), current_setting('t.hw_own')::bigint);
select pg_temp.expect_eq('a learner sees no other class''s homework',
  (select count(*) from assignments where class_id = current_setting('t.cls2')::uuid), 0);
reset role;

select pg_temp.act_as(current_setting('t.parent'));
set local role authenticated;
select pg_temp.expect_eq('a parent sees no homework from a class their children are not in',
  (select count(*) from assignments where title = 'RLS other class'), 0);
reset role;

select pg_temp.act_as(current_setting('t.teacher'));
set local role authenticated;
select pg_temp.check('staff still see every class''s homework',
  (select count(*) from assignments where title = 'RLS other class') = 1);
reset role;

rollback;
