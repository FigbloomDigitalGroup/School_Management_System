-- School setup in the database (QA 12, FIG-1245): terms, classes, subjects, the timetable, leave and cover, and what deleting
-- a piece of the setup does to records that already exist.
--
-- The onboarding wizard is in e2e/flows.spec.ts ("platform"), the pure logic is in packages/shared/src/{timetable,curriculum,levels}.test.ts,
-- the app's own functions are in tests/integration/schoolSetup.test.ts, and the screens are in e2e/setup.spec.ts. Runs against a local
-- database with `npm run db:seed` and `db:seed-org` data, in one transaction that is rolled back. Every check prints PASS, FAIL,
-- KNOWN <bug> (a defect already filed: KNOWN until it is fixed, then PASS) or INFO.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/school_setup.sql
-- Check the psql exit code too. Do not run it while e2e or the integration tests are running.

\set ON_ERROR_STOP 1
begin;

create function pg_temp.check(label text, ok boolean, known text default null) returns void language plpgsql as $$
begin raise notice '% %', case when ok then 'PASS' when known is not null then 'KNOWN ' || known else 'FAIL' end, label; end $$;
create function pg_temp.info(label text) returns void language plpgsql as $$ begin raise notice 'INFO %', label; end $$;

-- Runs one statement as a signed-in user and says whether the database took it.
create function pg_temp.as_user(p_user uuid, p_stmt text) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    execute p_stmt;
    reset role;
    return 'allowed';
  exception when others then
    reset role;
    return 'refused ' || sqlstate;
  end;
end $$;
-- How many rows a query gives a signed-in user.
create function pg_temp.count_as(p_user uuid, p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute p_sql into n;
  reset role;
  return n;
exception when others then
  reset role;
  raise;
end $$;

-- The writes the setup screens make, one helper each, run as the user given (Alliance).
create function pg_temp.term_as(p_user uuid, p_year int, p_index int, p_start date, p_end date, p_current boolean default false, p_name text default null) returns text language sql as $$
  select pg_temp.as_user(p_user, format('insert into terms (tenant_id, name, year, index, starts_on, ends_on, is_current) values (%L, %L, %s, %s, %L, %L, %L)',
    current_setting('t.a'), coalesce(p_name, 'QA12 term ' || p_year || '-' || p_index), p_year, p_index, p_start, p_end, p_current));
$$;
create function pg_temp.class_as(p_user uuid, p_name text, p_level text, p_year int, p_pathway text default null) returns text language sql as $$
  select pg_temp.as_user(p_user, format('insert into classes (tenant_id, name, level, form_level, pathway) values (%L, %L, %L, %s, %L)',
    current_setting('t.a'), p_name, p_level, p_year, p_pathway));
$$;
create function pg_temp.subject_as(p_user uuid, p_name text, p_code text, p_level text default null, p_min int default null, p_max int default null) returns text language sql as $$
  select pg_temp.as_user(p_user, format('insert into subjects (tenant_id, name, code, level, min_form_level, max_form_level) values (%L, %L, %L, %L, %L, %L)',
    current_setting('t.a'), p_name, p_code, p_level, p_min, p_max));
$$;
create function pg_temp.slot_as(p_user uuid, p_class uuid, p_day text, p_start text, p_subject uuid default null) returns text language sql as $$
  select pg_temp.as_user(p_user, format('insert into timetable_slots (tenant_id, class_id, day, start_time, label, subject_id) values (%L, %L, %L, %L, %L, %L)',
    current_setting('t.a'), p_class, p_day, p_start, 'QA12', p_subject));
$$;
create function pg_temp.leave_as(p_user uuid, p_start date, p_end date) returns text language sql as $$
  select pg_temp.as_user(p_user, format('insert into leave_requests (tenant_id, teacher_id, starts_on, ends_on, reason) values (%L, %L, %L, %L, %L)',
    current_setting('t.a'), p_user, p_start, p_end, 'QA12'));
$$;
create function pg_temp.cover_as(p_user uuid, p_date date, p_class uuid, p_start text, p_absent uuid, p_cover uuid) returns text language sql as $$
  select pg_temp.as_user(p_user, format('insert into coverage_assignments (tenant_id, date, class_id, subject_id, start_time, absent_teacher_id, covering_teacher_id, assigned_by) values (%L, %L, %L, %L, %L, %L, %L, %L)',
    current_setting('t.a'), p_date, p_class, current_setting('t.che'), p_start, p_absent, p_cover, p_user));
$$;

-- ---------------------------------------------------------------- what is there to work with
select set_config('t.a', (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.k', (select id::text from tenants where slug = 'kijani-ridge'), true);
select set_config('t.admin', (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.a')::uuid order by id limit 1), true);
select set_config('t.teacher', (select id::text from profiles where login_id = 'TC-0002' and tenant_id = current_setting('t.a')::uuid), true);
select set_config('t.parent', (select id::text from profiles where login_id = 'PT-0002' and tenant_id = current_setting('t.a')::uuid), true);
select set_config('t.student', (select id::text from profiles where login_id = 'ST-0002' and tenant_id = current_setting('t.a')::uuid), true);
select set_config('t.kadmin', (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.k')::uuid order by id limit 1), true);
select set_config('t.west', (select id::text from classes where tenant_id = current_setting('t.a')::uuid and name = 'Form 2 West'), true);
select set_config('t.c1', (select id::text from classes where tenant_id = current_setting('t.a')::uuid and name = 'Form 1 East'), true);
select set_config('t.c3', (select id::text from classes where tenant_id = current_setting('t.a')::uuid and name = 'Form 3 East'), true);
select set_config('t.che', (select id::text from subjects where tenant_id = current_setting('t.a')::uuid and code = 'CHE'), true);
select set_config('t.term', (select id::text from terms where tenant_id = current_setting('t.a')::uuid and is_current), true);
select set_config('t.faith', (select id::text from students where tenant_id = current_setting('t.a')::uuid and admission_no = '4102'), true);
select pg_temp.check('the seed has what these checks need (Alliance admin, teacher TC-0002, parent PT-0002, student ST-0002, Form 1 East, Form 2 West, Form 3 East, Chemistry, a current term, Faith, a Kijani Ridge admin)',
  current_setting('t.admin') <> '' and current_setting('t.teacher') <> '' and current_setting('t.parent') <> '' and current_setting('t.student') <> ''
  and current_setting('t.kadmin') <> '' and current_setting('t.west') <> '' and current_setting('t.c1') <> '' and current_setting('t.c3') <> ''
  and current_setting('t.che') <> '' and current_setting('t.term') <> '' and current_setting('t.faith') <> '');
select pg_temp.check('TC-0002 teaches Chemistry in both Form 1 East and Form 3 East (the double-booking checks below rely on it)',
  (select count(*) from teaching_assignments where teacher_id = current_setting('t.teacher')::uuid and subject_id = current_setting('t.che')::uuid
     and class_id in (current_setting('t.c1')::uuid, current_setting('t.c3')::uuid)) = 2);

-- ---------------------------------------------------------------- terms
select pg_temp.check('a term that ends before it starts is refused (terms_check)',
  pg_temp.term_as(current_setting('t.admin')::uuid, 2040, 1, '2040-02-10', '2040-02-01') = 'refused 23514');
select pg_temp.check('a term that ends the day it starts is refused too (ends_on must be after starts_on)',
  pg_temp.term_as(current_setting('t.admin')::uuid, 2040, 1, '2040-02-10', '2040-02-10') = 'refused 23514');
select pg_temp.check('a term number of 0 or 4 is refused (1 to 3 only)',
  pg_temp.term_as(current_setting('t.admin')::uuid, 2040, 0, '2040-01-05', '2040-04-01') = 'refused 23514'
  and pg_temp.term_as(current_setting('t.admin')::uuid, 2040, 4, '2040-01-05', '2040-04-01') = 'refused 23514');
select pg_temp.check('the same year and term number twice in one school is refused (Term 3, 2026 already exists)',
  pg_temp.term_as(current_setting('t.admin')::uuid, 2026, 3, '2026-12-01', '2026-12-20') = 'refused 23505');
select pg_temp.check('a second current term is refused: a school has one current term at a time (one_current_term)',
  pg_temp.term_as(current_setting('t.admin')::uuid, 2040, 1, '2040-01-05', '2040-04-01', true) = 'refused 23505');
select pg_temp.check('an ordinary new term is accepted (Term 1, 2040)',
  pg_temp.term_as(current_setting('t.admin')::uuid, 2040, 1, '2040-01-05', '2040-04-01') = 'allowed');
select pg_temp.check('a term that starts before the previous one has ended is refused (Term 2, 2040 starting 2040-03-01, inside Term 1)',
  pg_temp.term_as(current_setting('t.admin')::uuid, 2040, 2, '2040-03-01', '2040-07-01') like 'refused%', 'QA12-TERMS FIG-1432');
select pg_temp.check('a Term 3 that sits before the year''s Term 1 is refused (terms must run in order)',
  pg_temp.term_as(current_setting('t.admin')::uuid, 2040, 3, '2039-12-01', '2039-12-20') like 'refused%', 'QA12-TERMS FIG-1432');
select pg_temp.info('two terms may carry the same name (the screen writes "Term N, YEAR", so only a direct write can): '
  || pg_temp.term_as(current_setting('t.admin')::uuid, 2041, 1, '2041-01-05', '2041-04-01', false, 'QA12 same name') || ' then '
  || pg_temp.term_as(current_setting('t.admin')::uuid, 2041, 2, '2041-05-01', '2041-08-01', false, 'QA12 same name'));
select pg_temp.check('a teacher cannot create a term (42501)',
  pg_temp.term_as(current_setting('t.teacher')::uuid, 2044, 1, '2044-01-05', '2044-04-01') = 'refused 42501');
select pg_temp.info('the dates of the current term can be moved after attendance and invoices exist (nothing looks at them): '
  || pg_temp.as_user(current_setting('t.admin')::uuid, format('update terms set starts_on = %L where id = %L', '2026-11-26', current_setting('t.term')))
  || '. Rows keep their term_id, so the figures do not move.');

-- ---------------------------------------------------------------- classes
select pg_temp.check('the same class name twice in one school is refused (unique tenant_id, name)',
  pg_temp.class_as(current_setting('t.admin')::uuid, 'Form 1 East', 'secondary', 1) = 'refused 23505');
insert into classes (tenant_id, name, level, form_level) values (current_setting('t.k')::uuid, 'Form 1 East', 'secondary', 1);
select pg_temp.check('the same class name in another school is fine: class names belong to the school',
  (select count(*) from classes where name = 'Form 1 East') = 2);
select pg_temp.check('the first and last year of every level are accepted (PP1-2, Grade 1-6, 7-9, 10-12, Form 1-4)',
  (select bool_and(pg_temp.class_as(current_setting('t.admin')::uuid, 'QA12 ok ' || i, lvl, yr) = 'allowed')
     from (values (1,'secondary',1),(2,'secondary',4),(3,'pre_primary',1),(4,'pre_primary',2),(5,'primary',1),(6,'primary',6),
                  (7,'junior_secondary',7),(8,'junior_secondary',9),(9,'senior_school',10),(10,'senior_school',12)) v(i, lvl, yr)));
select pg_temp.check('a year outside its level is refused (Form 0 and 5, PP3, Grade 7 as primary, Grade 6 and 10 as junior, Grade 9 and 13 as senior)',
  (select bool_and(pg_temp.class_as(current_setting('t.admin')::uuid, 'QA12 bad ' || i, lvl, yr) like 'refused%')
     from (values (1,'secondary',0),(2,'secondary',5),(3,'pre_primary',3),(4,'primary',7),(5,'junior_secondary',6),(6,'junior_secondary',10),
                  (7,'senior_school',9),(8,'senior_school',13)) v(i, lvl, yr)));
select pg_temp.check('a pathway on a class that is not senior school is refused, and on a senior school class it is accepted',
  pg_temp.class_as(current_setting('t.admin')::uuid, 'QA12 path no', 'junior_secondary', 8, (enum_range(null::cbe_pathway))[1]::text) like 'refused%'
  and pg_temp.class_as(current_setting('t.admin')::uuid, 'QA12 path yes', 'senior_school', 10, (enum_range(null::cbe_pathway))[1]::text) = 'allowed');
select pg_temp.check('a class that still has learners cannot be deleted',
  pg_temp.as_user(current_setting('t.admin')::uuid, format('delete from classes where id = %L', current_setting('t.c1'))) = 'refused 23503'
  and exists (select 1 from classes where id = current_setting('t.c1')::uuid));

-- ---------------------------------------------------------------- subjects
select pg_temp.check('the same subject code twice in one school is refused (unique tenant_id, code)',
  pg_temp.subject_as(current_setting('t.admin')::uuid, 'QA12 Chemistry copy', 'CHE') = 'refused 23505');
select pg_temp.info('two subjects may carry the same name under different codes: '
  || pg_temp.subject_as(current_setting('t.admin')::uuid, 'Chemistry', 'QX9'));
select pg_temp.check('a first form outside the subject''s level is refused (Form 5 of the 8-4-4 levels)',
  pg_temp.subject_as(current_setting('t.admin')::uuid, 'QA12 range', 'QX2', 'secondary', 5, null) = 'refused 23514');
select pg_temp.check('a subject that starts in a later form than it ends in is refused (from Form 4 to Form 1 is offered nowhere)',
  pg_temp.subject_as(current_setting('t.admin')::uuid, 'QA12 backwards', 'QX3', 'secondary', 4, 1) like 'refused%', 'QA12-RANGE FIG-1436');
select pg_temp.check('a teacher cannot create a subject (42501)',
  pg_temp.as_user(current_setting('t.teacher')::uuid, format('insert into subjects (tenant_id, name, code) values (%L, %L, %L)', current_setting('t.a'), 'QA12 by teacher', 'QX4')) = 'refused 42501');

-- ---------------------------------------------------------------- the timetable
select set_config('t.tt', (select class_id::text from timetable_slots where tenant_id = current_setting('t.a')::uuid limit 1), true);
select pg_temp.check('the seeded Alliance timetable belongs to Form 2 West (what the read checks below use)', current_setting('t.tt') = current_setting('t.west'));
select pg_temp.check('a class cannot have two periods at the same day and time (Mon 07:00 twice)',
  pg_temp.slot_as(current_setting('t.admin')::uuid, current_setting('t.c1')::uuid, 'Mon', '07:00') = 'allowed'
  and pg_temp.slot_as(current_setting('t.admin')::uuid, current_setting('t.c1')::uuid, 'Mon', '07:00') = 'refused 23505');
select pg_temp.check('a day other than Mon to Fri is refused (Sat)',
  pg_temp.slot_as(current_setting('t.admin')::uuid, current_setting('t.c1')::uuid, 'Sat', '08:00') = 'refused 23514');
select pg_temp.check('a time that is not HH:MM is refused (8:00, 24:00, 08:60, empty)',
  (select bool_and(pg_temp.slot_as(current_setting('t.admin')::uuid, current_setting('t.c1')::uuid, 'Tue', t) = 'refused 23514') from unnest(array['8:00','24:00','08:60','']) t));
select pg_temp.check('a teacher cannot be put in two classes at the same time: Chemistry (TC-0002) in Form 1 East and Form 3 East at Wed 10:00',
  pg_temp.slot_as(current_setting('t.admin')::uuid, current_setting('t.c1')::uuid, 'Wed', '10:00', current_setting('t.che')::uuid) = 'allowed'
  and pg_temp.slot_as(current_setting('t.admin')::uuid, current_setting('t.c3')::uuid, 'Wed', '10:00', current_setting('t.che')::uuid) like 'refused%', 'QA12-CLASH FIG-1429');
select pg_temp.check('the clash above is in the database: TC-0002 now has two periods at Wed 10:00 on two different classes',
  (select count(*) from timetable_slots s join teaching_assignments ta on ta.class_id = s.class_id and ta.subject_id = s.subject_id
    where ta.teacher_id = current_setting('t.teacher')::uuid and s.day = 'Wed' and s.start_time = '10:00') < 2, 'QA12-CLASH FIG-1429');
select set_config('t.orphan', (select id::text from subjects where tenant_id = current_setting('t.a')::uuid and code = 'QX9'), true);
select pg_temp.info('a period can be linked to a subject nobody teaches in that class (the teacher column stays empty and only the class teacher sees it): '
  || pg_temp.slot_as(current_setting('t.admin')::uuid, current_setting('t.c1')::uuid, 'Thu', '09:00', current_setting('t.orphan')::uuid));
select pg_temp.info('a period has a start time and no end, so two periods ten minutes apart in one class are both accepted: '
  || pg_temp.slot_as(current_setting('t.admin')::uuid, current_setting('t.c1')::uuid, 'Fri', '08:00') || ' and '
  || pg_temp.slot_as(current_setting('t.admin')::uuid, current_setting('t.c1')::uuid, 'Fri', '08:10'));
select pg_temp.check('the class timetable is readable by the school''s teacher, parent, student and admin, and by nobody from another school',
  pg_temp.count_as(current_setting('t.teacher')::uuid, format('select count(*) from timetable_slots where class_id = %L', current_setting('t.west'))) = 40
  and pg_temp.count_as(current_setting('t.parent')::uuid, format('select count(*) from timetable_slots where class_id = %L', current_setting('t.west'))) = 40
  and pg_temp.count_as(current_setting('t.student')::uuid, format('select count(*) from timetable_slots where class_id = %L', current_setting('t.west'))) = 40
  and pg_temp.count_as(current_setting('t.admin')::uuid, format('select count(*) from timetable_slots where class_id = %L', current_setting('t.west'))) = 40
  and pg_temp.count_as(current_setting('t.kadmin')::uuid, format('select count(*) from timetable_slots where class_id = %L', current_setting('t.west'))) = 0);
select pg_temp.check('a teacher, a parent and a student cannot write a period (42501)',
  pg_temp.slot_as(current_setting('t.teacher')::uuid, current_setting('t.c1')::uuid, 'Mon', '06:00') = 'refused 42501'
  and pg_temp.slot_as(current_setting('t.parent')::uuid, current_setting('t.c1')::uuid, 'Mon', '06:00') = 'refused 42501'
  and pg_temp.slot_as(current_setting('t.student')::uuid, current_setting('t.c1')::uuid, 'Mon', '06:00') = 'refused 42501');

-- ---------------------------------------------------------------- leave and cover
select pg_temp.check('leave that ends before it starts is refused (leave_requests_check)',
  pg_temp.leave_as(current_setting('t.teacher')::uuid, '2040-05-10', '2040-05-09') = 'refused 23514');
select pg_temp.check('TC-0002 starts with no leave of their own (the seeded leave in the database is Kijani Ridge''s TC-0001)',
  (select count(*) from leave_requests where teacher_id = current_setting('t.teacher')::uuid) = 0);
select pg_temp.check('an ordinary request is accepted (10-12 May 2040)',
  pg_temp.leave_as(current_setting('t.teacher')::uuid, '2040-05-10', '2040-05-12') = 'allowed');
select set_config('t.lv1', (select id::text from leave_requests where teacher_id = current_setting('t.teacher')::uuid and starts_on = '2040-05-10' and ends_on = '2040-05-12' limit 1), true);
select set_config('t.r', pg_temp.as_user(current_setting('t.admin')::uuid,
  format('update leave_requests set status = %L, reviewed_by = %L, reviewed_at = now() where id = %L', 'approved', current_setting('t.admin'), current_setting('t.lv1'))), true);
select pg_temp.check('the principal approves it',
  current_setting('t.r') = 'allowed' and (select status::text from leave_requests where id = current_setting('t.lv1')::uuid) = 'approved');
select pg_temp.check('a second request that overlaps leave already approved for the same teacher is refused (12-14 May, while 10-12 May is approved)',
  pg_temp.leave_as(current_setting('t.teacher')::uuid, '2040-05-12', '2040-05-14') like 'refused%', 'QA12-LEAVE FIG-1433');
select pg_temp.check('the exact same dates as leave already approved are refused (10-12 May again)',
  pg_temp.leave_as(current_setting('t.teacher')::uuid, '2040-05-10', '2040-05-12') like 'refused%', 'QA12-LEAVE FIG-1433');
select set_config('t.lv2', coalesce((select id::text from leave_requests where teacher_id = current_setting('t.teacher')::uuid and starts_on = '2040-05-12' and ends_on = '2040-05-14' limit 1), ''), true);
select set_config('t.r', case when current_setting('t.lv2') = '' then 'no second request' else pg_temp.as_user(current_setting('t.admin')::uuid,
  format('update leave_requests set status = %L, reviewed_by = %L, reviewed_at = now() where id = %L', 'approved', current_setting('t.admin'), current_setting('t.lv2'))) end, true);
select pg_temp.check('the principal cannot approve a second request over days that are already approved (nothing in the review looks at the other requests)',
  current_setting('t.r') like 'refused%' or current_setting('t.r') = 'no second request', 'QA12-LEAVE FIG-1433');
select pg_temp.check('the school admin cannot file leave on behalf of a teacher through the request insert (42501)',
  pg_temp.as_user(current_setting('t.admin')::uuid, format('insert into leave_requests (tenant_id, teacher_id, starts_on, ends_on) values (%L, %L, %L, %L)', current_setting('t.a'), current_setting('t.teacher'), '2040-06-01', '2040-06-02')) = 'refused 42501');
select pg_temp.check('a cover can be recorded once for a class at a date and time; a second for the same slot is refused (unique date, class, start_time)',
  pg_temp.cover_as(current_setting('t.admin')::uuid, '2040-03-04', current_setting('t.c1')::uuid, '08:00', current_setting('t.teacher')::uuid, current_setting('t.admin')::uuid) = 'allowed'
  and pg_temp.cover_as(current_setting('t.admin')::uuid, '2040-03-04', current_setting('t.c1')::uuid, '08:00', current_setting('t.teacher')::uuid, current_setting('t.admin')::uuid) = 'refused 23505');
select pg_temp.check('one person cannot be asked to cover two classes at the same date and time',
  pg_temp.cover_as(current_setting('t.admin')::uuid, '2040-03-04', current_setting('t.c3')::uuid, '08:00', current_setting('t.teacher')::uuid, current_setting('t.admin')::uuid) like 'refused%', 'QA12-COVER FIG-1434');
select pg_temp.check('a teacher cannot be recorded as covering for themself',
  pg_temp.cover_as(current_setting('t.admin')::uuid, '2040-03-05', current_setting('t.c1')::uuid, '09:00', current_setting('t.teacher')::uuid, current_setting('t.teacher')::uuid) like 'refused%', 'QA12-COVER FIG-1434');
select pg_temp.info('cover can be recorded for a teacher who has no leave that day (the screen only offers leave days, the database does not tie them): '
  || pg_temp.cover_as(current_setting('t.admin')::uuid, '2040-03-06', current_setting('t.c1')::uuid, '10:00', current_setting('t.teacher')::uuid, current_setting('t.admin')::uuid));
select pg_temp.check('a teacher cannot assign cover (42501)',
  pg_temp.cover_as(current_setting('t.teacher')::uuid, '2040-03-07', current_setting('t.c1')::uuid, '08:00', current_setting('t.teacher')::uuid, current_setting('t.admin')::uuid) = 'refused 42501');

-- ---------------------------------------------------------------- deleting a piece of the setup that has records behind it
-- A class emptied by promotion (its learners moved up) is deleted at the end of the year. Its old attendance rows name it.
with c as (insert into classes (tenant_id, name, level, form_level) values (current_setting('t.a')::uuid, 'QA12 Old', 'secondary', 2) returning id)
  select set_config('t.old', (select id::text from c), true);
with s as (insert into students (tenant_id, admission_no, full_name, class_id, boarding, active, gender)
             values (current_setting('t.a')::uuid, 'QA12-OLD1', 'QA12 Old Learner', current_setting('t.old')::uuid, false, true, 'female') returning id)
  select set_config('t.oldkid', (select id::text from s), true);
insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
  values (current_setting('t.a')::uuid, current_setting('t.oldkid')::uuid, current_setting('t.old')::uuid, current_setting('t.term')::uuid, current_setting('t.teacher')::uuid, '2026-09-02', 'present');
-- Each action runs in its own statement, so the check after it sees the result (one statement would read the rows first).
select set_config('t.r', pg_temp.as_user(current_setting('t.admin')::uuid, format('update students set class_id = %L where id = %L', current_setting('t.c3'), current_setting('t.oldkid'))), true);
select pg_temp.check('the admin moves the learner up to another class (the Promote screen''s write)',
  current_setting('t.r') = 'allowed' and (select class_id from students where id = current_setting('t.oldkid')::uuid) = current_setting('t.c3')::uuid);
select set_config('t.r', pg_temp.as_user(current_setting('t.admin')::uuid, format('delete from classes where id = %L', current_setting('t.old'))), true);
select pg_temp.info('the admin deletes the emptied old class (the screen only stops a class that still has learners): ' || current_setting('t.r')
  || '; the class is ' || case when exists (select 1 from classes where id = current_setting('t.old')::uuid) then 'still there' else 'gone' end);
select pg_temp.check('deleting an emptied class keeps the attendance its former learner already has (1 row before)',
  (select count(*) from attendance where student_id = current_setting('t.oldkid')::uuid) = 1, 'QA12-DELETE FIG-1428');

-- A subject is deleted: every mark entered for it goes with it.
with sj as (insert into subjects (tenant_id, name, code) values (current_setting('t.a')::uuid, 'QA12 Gone', 'QX5') returning id)
  select set_config('t.gone', (select id::text from sj), true);
with ex as (insert into exams (tenant_id, term_id, name) values (current_setting('t.a')::uuid, current_setting('t.term')::uuid, 'QA12 exam') returning id)
  select set_config('t.exam', (select id::text from ex), true);
insert into marks (tenant_id, exam_id, student_id, subject_id, entered_by, score)
  values (current_setting('t.a')::uuid, current_setting('t.exam')::uuid, current_setting('t.faith')::uuid, current_setting('t.gone')::uuid, current_setting('t.teacher')::uuid, 55);
select set_config('t.r', pg_temp.as_user(current_setting('t.admin')::uuid, format('delete from subjects where id = %L', current_setting('t.gone'))), true);
select pg_temp.info('the admin deletes a subject that has marks (the subject screens have no delete; this is a direct write): ' || current_setting('t.r'));
select pg_temp.check('deleting a subject that has marks keeps the marks (1 mark entered before)',
  (select count(*) from marks where exam_id = current_setting('t.exam')::uuid and student_id = current_setting('t.faith')::uuid and subject_id = current_setting('t.gone')::uuid) = 1, 'QA12-DELETE FIG-1430');

-- A term is deleted: its attendance, exams, invoices and report cards go with it.
with tm as (insert into terms (tenant_id, name, year, index, starts_on, ends_on, is_current)
              values (current_setting('t.a')::uuid, 'QA12 gone term', 2043, 1, '2043-01-05', '2043-04-01', false) returning id)
  select set_config('t.goneterm', (select id::text from tm), true);
insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
  values (current_setting('t.a')::uuid, current_setting('t.faith')::uuid, current_setting('t.west')::uuid, current_setting('t.goneterm')::uuid, current_setting('t.teacher')::uuid, '2043-01-06', 'present');
select set_config('t.r', pg_temp.as_user(current_setting('t.admin')::uuid, format('delete from terms where id = %L', current_setting('t.goneterm'))), true);
select pg_temp.info('the admin deletes a term that has attendance (no screen deletes a term; this is a direct write): ' || current_setting('t.r'));
select pg_temp.check('deleting a term that has attendance keeps the attendance (1 row before)',
  (select count(*) from attendance where term_id = current_setting('t.goneterm')::uuid) = 1, 'QA12-DELETE FIG-1430');

-- ---------------------------------------------------------------- a class that has marks is moved to another level
with c as (insert into classes (tenant_id, name, level, form_level) values (current_setting('t.a')::uuid, 'QA12 Graded', 'secondary', 2) returning id)
  select set_config('t.graded', (select id::text from c), true);
with s as (insert into students (tenant_id, admission_no, full_name, class_id, boarding, active, gender)
             values (current_setting('t.a')::uuid, 'QA12-GRD1', 'QA12 Graded Learner', current_setting('t.graded')::uuid, false, true, 'male') returning id)
  select set_config('t.gradedkid', (select id::text from s), true);
insert into marks (tenant_id, exam_id, student_id, subject_id, entered_by, score)
  values (current_setting('t.a')::uuid, current_setting('t.exam')::uuid, current_setting('t.gradedkid')::uuid, current_setting('t.che')::uuid, current_setting('t.teacher')::uuid, 72);
select pg_temp.check('a class that already has marks cannot be moved to another level (the grade shown for each mark is worked out from the level, so every one would be re-graded)',
  pg_temp.as_user(current_setting('t.admin')::uuid, format('update classes set level = %L where id = %L', 'primary', current_setting('t.graded'))) like 'refused%', 'QA12-REGRADE FIG-1435');

-- ---------------------------------------------------------------- school status and who can sign in
-- The sign-in gate is the resolve-login-id function (active, trial and overdue; tests/integration/schoolSetup.test.ts). The database
-- only bans a school's users when the school is suspended.
create function pg_temp.banned_in_k() returns bigint language sql as $$
  select count(*) from auth.users u join profiles p on p.id = u.id where p.tenant_id = current_setting('t.k')::uuid and u.banned_until is not null and u.banned_until > now();
$$;
select pg_temp.check('Kijani Ridge starts with nobody banned', pg_temp.banned_in_k() = 0);
update tenants set status = 'trial' where id = current_setting('t.k')::uuid;
update tenants set status = 'overdue' where id = current_setting('t.k')::uuid;
select pg_temp.check('a trial school and an overdue school keep their users able to sign in (nobody banned)', pg_temp.banned_in_k() = 0);
update tenants set status = 'onboarding' where id = current_setting('t.k')::uuid;
select pg_temp.check('an onboarding school does not ban anyone either (the sign-in function does not look it up)', pg_temp.banned_in_k() = 0);
update tenants set status = 'suspended' where id = current_setting('t.k')::uuid;
select pg_temp.check('a suspended school bans every user', pg_temp.banned_in_k() > 0);
update tenants set status = 'active' where id = current_setting('t.k')::uuid;
select pg_temp.check('and making it active again lifts the ban', pg_temp.banned_in_k() = 0);

rollback;
