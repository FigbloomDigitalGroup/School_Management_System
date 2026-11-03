-- Grades and marks in the database (QA 09, FIG-1242): the parts of marks-to-grades that live in SQL.
--
-- The KCSE and CBC letter grades are NOT computed in the database (packages/shared/src/grading.ts is the only place; its table is
-- tested in packages/shared/src/gradeTables.test.ts). What the database does own is: the CBE rubric points (rubric_points(), which
-- must give the numbers the TypeScript rubric gives), the class mean parents see (class_means_for_exam), and the rules a mark
-- must satisfy before it is stored. Runs against a local database with `npm run db:seed` data, in one transaction that is rolled
-- back. Every check prints PASS, FAIL, KNOWN <bug> (a defect already filed: KNOWN until fixed, then PASS) or INFO.
--
-- supabase/rls-checks/exams_homework.sql (33 checks) covers who may publish, what a parent sees before and after, and homework;
-- this file covers the numbers. The marks API as a teacher and a parent sees it is in tests/integration/marksAndPublishing.test.ts.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/grades.sql
-- Check the psql exit code too. Do not run it while e2e is running.

\set ON_ERROR_STOP 1
begin;

create function pg_temp.check(label text, ok boolean, known text default null) returns void language plpgsql as $$
begin raise notice '% %', case when ok then 'PASS' when known is not null then 'KNOWN ' || known else 'FAIL' end, label; end $$;
create function pg_temp.info(label text) returns void language plpgsql as $$ begin raise notice 'INFO %', label; end $$;
create function pg_temp.expect_error(label text, stmt text, errcode text) returns void language plpgsql as $$
begin
  begin execute stmt; raise notice 'FAIL %: allowed', label;
  exception when others then
    if sqlstate = errcode then raise notice 'PASS % (%)', label, sqlerrm;
    else raise notice 'FAIL %: % %', label, sqlstate, sqlerrm; end if;
  end;
end $$;

-- ---------------------------------------------------------------- rubric_points(), against the table typed out by hand
create temp table qa_rubric (level text, code text, points int);
insert into qa_rubric values
  ('pre_primary', 'EE', 4), ('pre_primary', 'ME', 3), ('pre_primary', 'AE', 2), ('pre_primary', 'BE', 1),
  ('primary', 'EE', 4), ('primary', 'ME', 3), ('primary', 'AE', 2), ('primary', 'BE', 1),
  ('junior_secondary', 'EE1', 8), ('junior_secondary', 'EE2', 7), ('junior_secondary', 'ME1', 6), ('junior_secondary', 'ME2', 5),
  ('junior_secondary', 'AE1', 4), ('junior_secondary', 'AE2', 3), ('junior_secondary', 'BE1', 2), ('junior_secondary', 'BE2', 1),
  ('senior_school', 'EE1', 8), ('senior_school', 'EE2', 7), ('senior_school', 'ME1', 6), ('senior_school', 'ME2', 5),
  ('senior_school', 'AE1', 4), ('senior_school', 'AE2', 3), ('senior_school', 'BE1', 2), ('senior_school', 'BE2', 1);
select pg_temp.check('rubric_points() gives the hand-typed points for every level and code (4 levels to Grade 6, 8 levels from junior school)',
  not exists (select 1 from qa_rubric r where rubric_points(r.level::class_level, r.code) is distinct from r.points)
  and (select count(*) from qa_rubric) = 24);
select pg_temp.check('rubric_points() gives nothing for a code from the other rubric, an 8-4-4 class, an unknown code or a lower-case one',
  rubric_points('primary', 'EE1') is null and rubric_points('junior_secondary', 'EE') is null and rubric_points('secondary', 'EE') is null
  and rubric_points('primary', 'XX') is null and rubric_points('primary', 'ee') is null and rubric_points('primary', null) is null);

-- ---------------------------------------------------------------- a mark against its paper's total
select set_config('t.a', (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.admin', (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.a')::uuid order by id limit 1), true);
select set_config('t.term', (select id::text from terms where tenant_id = current_setting('t.a')::uuid and is_current), true);
select set_config('t.class', (select class_id::text from students where tenant_id = current_setting('t.a')::uuid and active and class_id is not null group by class_id having count(*) >= 4 order by class_id limit 1), true);
select set_config('t.subject', (select id::text from subjects where tenant_id = current_setting('t.a')::uuid order by id limit 1), true);
create temp table qa_kids as
  select id, row_number() over (order by id) as n from students where class_id = current_setting('t.class')::uuid and active order by id limit 4;

-- two exams of the school: one out of 100, and one out of 30 (the screens only ever make 100, the API does not stop another total)
insert into exams (id, tenant_id, term_id, name, out_of) values
  ('00000000-0000-4000-8000-0000000000a1', current_setting('t.a')::uuid, current_setting('t.term')::uuid, 'QA9 out of 100', 100),
  ('00000000-0000-4000-8000-0000000000a2', current_setting('t.a')::uuid, current_setting('t.term')::uuid, 'QA9 out of 30', 30);

create function pg_temp.put(p_exam uuid, p_n int, p_score int) returns boolean language plpgsql as $$
begin
  insert into marks (tenant_id, exam_id, student_id, subject_id, score, entered_by)
  select current_setting('t.a')::uuid, p_exam, k.id, current_setting('t.subject')::uuid, p_score, current_setting('t.admin')::uuid
    from qa_kids k where k.n = p_n
  on conflict (exam_id, student_id, subject_id) do update set score = excluded.score;
  return true;
end $$;

select pg_temp.expect_error('a mark above the paper total is refused (out of 100)', $q$select pg_temp.put('00000000-0000-4000-8000-0000000000a1', 1, 101)$q$, 'P0001');
select pg_temp.expect_error('a mark above the paper total is refused (out of 30: 31)', $q$select pg_temp.put('00000000-0000-4000-8000-0000000000a2', 1, 31)$q$, 'P0001');
select pg_temp.check('a mark equal to the paper total is accepted (30 of 30, 100 of 100), and so is 0', 
  pg_temp.put('00000000-0000-4000-8000-0000000000a2', 1, 30) and pg_temp.put('00000000-0000-4000-8000-0000000000a1', 1, 100) and pg_temp.put('00000000-0000-4000-8000-0000000000a1', 2, 0));
select pg_temp.expect_error('a negative mark is refused', $q$select pg_temp.put('00000000-0000-4000-8000-0000000000a1', 1, -1)$q$, '23514');
select pg_temp.info('exams.out_of only has to be above 0: the API accepts an exam out of 30, but every screen reads a mark as a percentage (21 of 30 would be graded as a fail). Known limitation: exams are out of 100 only.');

-- ---------------------------------------------------------------- class means, worked by hand
-- the exam out of 100, one subject, the first learner's class; the 4 learners get the marks below and the class is published
delete from marks where exam_id = '00000000-0000-4000-8000-0000000000a1';
create function pg_temp.mean_of(p_a int, p_b int, p_c int, p_d int) returns numeric language plpgsql as $$
declare m numeric;
begin
  delete from marks where exam_id = '00000000-0000-4000-8000-0000000000a1';
  perform pg_temp.put('00000000-0000-4000-8000-0000000000a1', 1, p_a);
  perform pg_temp.put('00000000-0000-4000-8000-0000000000a1', 2, p_b);
  perform pg_temp.put('00000000-0000-4000-8000-0000000000a1', 3, p_c);
  perform pg_temp.put('00000000-0000-4000-8000-0000000000a1', 4, p_d);
  insert into mark_publications (exam_id, class_id, subject_id, tenant_id, published_by)
    values ('00000000-0000-4000-8000-0000000000a1', current_setting('t.class')::uuid, current_setting('t.subject')::uuid, current_setting('t.a')::uuid, current_setting('t.admin')::uuid)
    on conflict do nothing;
  perform set_config('request.jwt.claims', json_build_object('sub', current_setting('t.admin'), 'role', 'authenticated')::text, true);
  set local role authenticated;
  select mean_score into m from class_means_for_exam('00000000-0000-4000-8000-0000000000a1', current_setting('t.class')::uuid) limit 1;
  reset role;
  return m;
end $$;
-- (90 + 80 + 71 + 0) / 4 = 60.25 -> 60: a zero counts
select pg_temp.check('class mean: (90 + 80 + 71 + 0) / 4 = 60.25 is shown as 60 (a zero counts)', pg_temp.mean_of(90, 80, 71, 0) = 60);
-- (90 + 80 + 71 + no mark) / 3 = 80.33 -> 80: a learner with no score is not in the mean
select pg_temp.check('class mean: (90 + 80 + 71) / 3 = 80.33 is shown as 80 (a learner with no score is left out)', pg_temp.mean_of(90, null, 71, 80) = 80);
-- (84 + 85 + 85 + 85) / 4 = 84.75 -> 85; (84 + 84 + 85 + 84) / 4 = 84.25 -> 84; exactly .5 goes up: (84 + 85) / 2 = 84.5 -> 85
select pg_temp.check('class mean: 84.75 -> 85 and 84.25 -> 84', pg_temp.mean_of(84, 85, 85, 85) = 85 and pg_temp.mean_of(84, 84, 85, 84) = 84);
select pg_temp.check('class mean: exactly 84.5 goes up to 85 ((84 + 85) / 2, two learners marked)', pg_temp.mean_of(84, 85, null, null) = 85);
select pg_temp.check('class mean: exactly 83.5 goes up to 84 ((83 + 84) / 2)', pg_temp.mean_of(83, 84, null, null) = 84);

-- ---------------------------------------------------------------- higher education
-- A school exam mark is checked against its paper (marks_within_paper). A higher-ed mark is not checked against its assessment.
select pg_temp.check('a higher-ed mark above its assessment''s total is refused by the database (a trigger or check on course_marks that looks at out_of)',
  exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
           where t.tgrelid = 'public.course_marks'::regclass and not t.tgisinternal and pg_get_functiondef(p.oid) ilike '%out_of%')
  or exists (select 1 from pg_constraint c where c.conrelid = 'public.course_marks'::regclass and c.contype = 'c' and pg_get_constraintdef(c.oid) ilike '%out_of%'),
  'FIG-1377');
select pg_temp.info('no higher-ed data is seeded (courses, sections, assessments), so the line above is read from the catalog, not driven with a mark');

rollback;
