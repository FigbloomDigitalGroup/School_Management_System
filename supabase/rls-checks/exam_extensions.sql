-- Extension, resit, missed and excused checks for 20261030100000_exam_extensions.
--
-- Runs against a local database that has the migrations applied and
-- `npm run db:seed` data, inside one transaction that is rolled back.
-- Every check prints PASS or FAIL. now() is fixed for the whole transaction,
-- so the windows below are placed around it.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/exam_extensions.sql

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
-- a classmate with no login of their own in play here: the one who misses the paper
select set_config('t.child2',  (select id::text from students where class_id = current_setting('t.cls')::uuid and active
                                  and id <> current_setting('t.child')::uuid order by full_name limit 1), true);
-- the subject the seeded teacher teaches in that class, and one they don't
select set_config('t.chem',    (select ta.subject_id::text from teaching_assignments ta where ta.teacher_id = current_setting('t.teacher')::uuid and ta.class_id = current_setting('t.cls')::uuid limit 1), true);
select set_config('t.math',    (select id::text from subjects where tenant_id = current_setting('t.a')::uuid and id <> current_setting('t.chem')::uuid
                                  and not exists (select 1 from teaching_assignments ta where ta.teacher_id = current_setting('t.teacher')::uuid
                                                   and ta.class_id = current_setting('t.cls')::uuid and ta.subject_id = subjects.id)
                                order by name limit 1), true);

insert into exams (tenant_id, term_id, name, out_of)
  values (current_setting('t.a')::uuid, (select id from terms where tenant_id = current_setting('t.a')::uuid and is_current), 'RLS Extension Exam', 100);
select set_config('t.exam', (select id::text from exams where name = 'RLS Extension Exam'), true);

-- An online paper that opened three hours ago and closed an hour ago: 30 minutes, one choice question worth 2.
insert into exam_papers (tenant_id, title, class_id, subject_id, exam_id, mode, opens_at, closes_at, duration_minutes, published_at)
values (current_setting('t.a')::uuid, 'RLS closed paper', current_setting('t.cls')::uuid, current_setting('t.chem')::uuid,
        current_setting('t.exam')::uuid, 'online', now() - interval '3 hours', now() - interval '1 hour', 30, now() - interval '4 hours');
select set_config('t.paper', (select id::text from exam_papers where title = 'RLS closed paper'), true);
insert into exam_questions (paper_id, position, kind, prompt, options, points)
values (current_setting('t.paper')::uuid, 1, 'choice', 'Pick a', '["a", "b"]', 2);
select set_config('t.q', (select id::text from exam_questions where paper_id = current_setting('t.paper')::uuid), true);
insert into exam_question_keys (question_id, correct_option) values (current_setting('t.q')::uuid, 0);

-- The same, in a subject the seeded teacher doesn't teach.
insert into exam_papers (tenant_id, title, class_id, subject_id, mode, opens_at, closes_at, duration_minutes, published_at)
values (current_setting('t.a')::uuid, 'RLS other subject paper', current_setting('t.cls')::uuid, current_setting('t.math')::uuid,
        'online', now() - interval '3 hours', now() - interval '1 hour', 30, now() - interval '4 hours');
select set_config('t.paper2', (select id::text from exam_papers where title = 'RLS other subject paper'), true);

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when coalesce(ok, false) then 'PASS' else 'FAIL' end, label; end $$;
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
create function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- closed means closed, without an override
select pg_temp.act_as(current_setting('t.student'));
set local role authenticated;
select pg_temp.expect_error('a learner can''t start after the paper has closed',
  format('select start_exam_attempt(%L)', current_setting('t.paper')), '22023');
reset role;
select pg_temp.check('the classmate who never started shows as missed',
  (select exam_learner_state(p, current_setting('t.child2')::uuid) = 'missed' from exam_papers p where p.id = current_setting('t.paper')::uuid));

-- ---------------------------------------------------------------- who may give an extension
select pg_temp.act_as(current_setting('t.student'));
set local role authenticated;
select pg_temp.expect_error('a learner can''t give themselves their own window',
  format('select set_exam_override(%L, array[%L]::uuid[], now(), now() + interval ''1 hour'', 0, false, ''latest'', ''I was sick'')',
    current_setting('t.paper'), current_setting('t.child')), '42501');
select pg_temp.expect_error('a learner can''t write an override row directly',
  format('insert into exam_paper_overrides (tenant_id, paper_id, student_id, closes_at, reason) values (%L, %L, %L, now() + interval ''1 day'', ''x'')',
    current_setting('t.a'), current_setting('t.paper'), current_setting('t.child')), '42501');
select pg_temp.expect_error('a learner can''t excuse themselves',
  format('select set_exam_excusal(%L, %L, true, ''x'')', current_setting('t.paper'), current_setting('t.child')), '42501');
reset role;

select pg_temp.act_as(current_setting('t.parent'));
set local role authenticated;
select pg_temp.expect_error('a parent can''t give an extension',
  format('select set_exam_override(%L, array[%L]::uuid[], null, null, 15, false, ''latest'', ''x'')',
    current_setting('t.paper'), current_setting('t.child')), '42501');
reset role;

select pg_temp.act_as(current_setting('t.teacher'));
set local role authenticated;
select pg_temp.expect_error('a teacher can''t give an extension on a subject they don''t teach',
  format('select set_exam_override(%L, array[%L]::uuid[], now() - interval ''10 minutes'', now() + interval ''1 hour'', 0, false, ''latest'', ''Sick'')',
    current_setting('t.paper2'), current_setting('t.child')), '42501');
select pg_temp.expect_error('an extension needs a reason',
  format('select set_exam_override(%L, array[%L]::uuid[], now() - interval ''10 minutes'', now() + interval ''1 hour'', 0, false, ''latest'', ''  '')',
    current_setting('t.paper'), current_setting('t.child')), '22023');
select pg_temp.expect_error('a closed paper needs a window of their own, not just extra minutes',
  format('select set_exam_override(%L, array[%L]::uuid[], null, null, 15, false, ''latest'', ''Sick'')',
    current_setting('t.paper'), current_setting('t.child')), '22023');
-- the teacher who sets the paper gives the learner their own window, from ten minutes ago for an hour
select set_exam_override(current_setting('t.paper')::uuid, array[current_setting('t.child')::uuid],
  now() - interval '10 minutes', now() + interval '1 hour', 15, false, 'latest', 'Sick on the day');
select pg_temp.expect_eq('the teacher sees the override, reason and all',
  (select count(*) from exam_paper_overrides where paper_id = current_setting('t.paper')::uuid and reason = 'Sick on the day'), 1);
reset role;

select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
select set_exam_override(current_setting('t.paper2')::uuid, array[current_setting('t.child')::uuid],
  now() - interval '10 minutes', now() + interval '1 hour', 0, false, 'latest', 'Office: sick note');
select pg_temp.expect_eq('the office can give an extension on any paper',
  (select count(*) from exam_paper_overrides where paper_id = current_setting('t.paper2')::uuid), 1);
reset role;

select pg_temp.act_as(current_setting('t.parent'));
set local role authenticated;
select pg_temp.expect_eq('a parent can''t read overrides (the reason is for staff)',
  (select count(*) from exam_paper_overrides), 0);
reset role;
select pg_temp.act_as(current_setting('t.student'));
set local role authenticated;
select pg_temp.expect_eq('a learner can''t read overrides either',
  (select count(*) from exam_paper_overrides), 0);

-- ---------------------------------------------------------------- the learner sits it in their own window
select start_exam_attempt(current_setting('t.paper')::uuid);
select pg_temp.check('the deadline is the learner''s: start + 30 + 15 minutes, inside their own closing time + 15',
  (select (save_exam_attempt(current_setting('t.paper')::uuid, '{}'::jsonb, false) ->> 'deadline')::timestamptz = now() + interval '45 minutes'));
select pg_temp.check('their own view shows their window and the extra minutes',
  (select extra_minutes = 15 and closes_at = now() + interval '1 hour' and state = 'in_progress'
     from learner_exam_states(current_setting('t.child')::uuid) where paper_id = current_setting('t.paper')::uuid));
select save_exam_attempt(current_setting('t.paper')::uuid, jsonb_build_object(current_setting('t.q'), 1), true);
select pg_temp.check('handed in with no resit: Start gives back the handed-in sitting, not a new one',
  (select (start_exam_attempt(current_setting('t.paper')::uuid) ->> 'attempt_no')::int = 1));
reset role;
select pg_temp.expect_eq('the learner started inside their override window after the paper closed for everyone else',
  (select count(*) from exam_attempts where paper_id = current_setting('t.paper')::uuid and student_id = current_setting('t.child')::uuid and submitted_at is not null), 1);
select pg_temp.check('the wrong answer scored 0 of 2',
  (select final_score = 0 from exam_attempts where paper_id = current_setting('t.paper')::uuid and student_id = current_setting('t.child')::uuid));

-- ---------------------------------------------------------------- a resit, best sitting counts
select pg_temp.act_as(current_setting('t.teacher'));
set local role authenticated;
select pg_temp.expect_error('a resit is only for a learner who has handed in',
  format('select set_exam_override(%L, array[%L]::uuid[], now() - interval ''10 minutes'', now() + interval ''1 hour'', 0, true, ''best'', ''Retry'')',
    current_setting('t.paper'), current_setting('t.child2')), '22023');
select set_exam_override(current_setting('t.paper')::uuid, array[current_setting('t.child')::uuid],
  now() - interval '10 minutes', now() + interval '1 hour', 15, true, 'best', 'Resit after illness');
select pg_temp.expect_error('an excusal is refused once the learner has started',
  format('select set_exam_excusal(%L, %L, true, ''x'')', current_setting('t.paper'), current_setting('t.child')), '22023');
reset role;

select pg_temp.act_as(current_setting('t.student'));
set local role authenticated;
select pg_temp.check('the resit starts as sitting 2',
  (select (start_exam_attempt(current_setting('t.paper')::uuid) ->> 'attempt_no')::int = 2));
select save_exam_attempt(current_setting('t.paper')::uuid, jsonb_build_object(current_setting('t.q'), 0), true);
reset role;
select pg_temp.expect_eq('the original sitting is kept for the record',
  (select count(*) from exam_attempts where paper_id = current_setting('t.paper')::uuid and student_id = current_setting('t.child')::uuid), 2);
select pg_temp.check('the best sitting (the resit, 2 of 2) is the one that counts',
  (select attempt_no = 2 and final_score = 2 from exam_attempts
    where id = exam_counting_attempt(current_setting('t.paper')::uuid, current_setting('t.child')::uuid)));
select pg_temp.expect_eq('exactly one sitting counts',
  (select count(*) from exam_attempts a where a.paper_id = current_setting('t.paper')::uuid and is_counting(a)), 1);

-- ---------------------------------------------------------------- excused, and the Gradebook
select pg_temp.act_as(current_setting('t.teacher'));
set local role authenticated;
select set_exam_excusal(current_setting('t.paper')::uuid, current_setting('t.child2')::uuid, true, 'At the county games');
select send_exam_scores_to_gradebook(current_setting('t.paper')::uuid);
reset role;
select pg_temp.check('the excused classmate is excused, not missed',
  (select exam_learner_state(p, current_setting('t.child2')::uuid) = 'excused' from exam_papers p where p.id = current_setting('t.paper')::uuid));
select pg_temp.check('the Gradebook gets the counting sitting, scaled: 2 of 2 is 100',
  (select score = 100 and absence is null from marks
    where exam_id = current_setting('t.exam')::uuid and student_id = current_setting('t.child')::uuid));
select pg_temp.check('the excused learner goes in as Excused with no score, not 0',
  (select score is null and absence = 'excused' from marks
    where exam_id = current_setting('t.exam')::uuid and student_id = current_setting('t.child2')::uuid));
select pg_temp.check('learners who missed it go in as Missed with no score',
  (select bool_and(m.score is null and m.absence = 'missed') from marks m join students s on s.id = m.student_id
    where m.exam_id = current_setting('t.exam')::uuid and s.id not in (current_setting('t.child')::uuid, current_setting('t.child2')::uuid))
  is not false);
update marks set score = 40 where exam_id = current_setting('t.exam')::uuid and student_id = current_setting('t.child2')::uuid;
select pg_temp.check('typing a score over an excused mark clears the absence',
  (select score = 40 and absence is null from marks
    where exam_id = current_setting('t.exam')::uuid and student_id = current_setting('t.child2')::uuid));

rollback;
