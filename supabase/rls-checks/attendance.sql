-- Attendance in the database (QA 10, FIG-1243): is every register stored once, on a sensible date, against the right class,
-- and what happens when someone changes it.
--
-- The screens and the offline queue are checked elsewhere: tests/integration/attendance.test.ts drives the app's own functions
-- as a teacher, a parent and the school admin, and e2e/attendance.spec.ts reads the Dashboard, Reports and parent screens against
-- the rows. This file asks the database directly. Runs against a local database with `npm run db:seed` and `db:seed-org` data,
-- in one transaction that is rolled back. Every check prints PASS, FAIL, KNOWN <bug> (a defect already filed: KNOWN until it is
-- fixed, then PASS) or INFO. Who may write at all (parent, student, driver, a teacher of another class) is in roles_in_school.sql.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/attendance.sql
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

-- ---------------------------------------------------------------- what is there to work with
select set_config('t.a', (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.k', (select id::text from tenants where slug = 'kijani-ridge'), true);
select set_config('t.teacher', (select id::text from profiles where login_id = 'TC-0002' and tenant_id = current_setting('t.a')::uuid), true);
select set_config('t.admin', (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.a')::uuid order by id limit 1), true);
select set_config('t.term', (select id::text from terms where tenant_id = current_setting('t.a')::uuid and is_current), true);
select set_config('t.kterm', (select id::text from terms where tenant_id = current_setting('t.k')::uuid and is_current), true);
select set_config('t.kclass', (select class_id::text from students where tenant_id = current_setting('t.k')::uuid and active group by class_id order by count(*) desc, class_id limit 1), true);
-- Form 2 West: the teacher is its class teacher and teaches in it. Form 1 East: the teacher is assigned to it but is not its class teacher.
select set_config('t.cx', (select id::text from classes where tenant_id = current_setting('t.a')::uuid and name = 'Form 2 West'), true);
select set_config('t.cy', (select id::text from classes where tenant_id = current_setting('t.a')::uuid and name = 'Form 1 East'), true);
select set_config('t.kid_x', (select id::text from students where class_id = current_setting('t.cx')::uuid and active order by id limit 1), true);
select set_config('t.kid_y', (select id::text from students where class_id = current_setting('t.cy')::uuid and active order by id limit 1), true);
select set_config('t.kid_k', (select id::text from students where tenant_id = current_setting('t.k')::uuid and active order by id limit 1), true);

select pg_temp.check('the seed has what these checks need (Alliance teacher, admin, term and two classes with learners; a Kijani Ridge class)',
  current_setting('t.teacher') <> '' and current_setting('t.admin') <> '' and current_setting('t.term') <> ''
  and current_setting('t.kid_x') <> '' and current_setting('t.kid_y') <> '' and current_setting('t.kclass') <> '' and current_setting('t.kterm') <> '');
select pg_temp.info('triggers on attendance: ' || (select string_agg(tgname, ', ' order by tgname) from pg_trigger where tgrelid = 'attendance'::regclass and not tgisinternal)
  || '. Columns: ' || (select string_agg(attname, ', ' order by attnum) from pg_attribute where attrelid = 'attendance'::regclass and attnum > 0 and not attisdropped)
  || ' (no updated_at, no editor, no history table)');

create function pg_temp.put(p_student uuid, p_class uuid, p_term uuid, p_by uuid, p_on date, p_mark text, p_tenant uuid default current_setting('t.a')::uuid)
returns void language sql as $$
  insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
  values (p_tenant, p_student, p_class, p_term, p_by, p_on, p_mark::attendance_mark)
  on conflict (student_id, taken_on) do update set mark = excluded.mark, taken_by = excluded.taken_by
$$;

-- ---------------------------------------------------------------- one record per learner per day
-- Dates on 2034-03-xx: no seeded register is anywhere near them.
select pg_temp.put(current_setting('t.kid_x')::uuid, current_setting('t.cx')::uuid, current_setting('t.term')::uuid, current_setting('t.teacher')::uuid, '2034-03-06', 'present');
create temp table qa_first as select id, created_at from attendance where student_id = current_setting('t.kid_x')::uuid and taken_on = '2034-03-06';
select pg_temp.put(current_setting('t.kid_x')::uuid, current_setting('t.cx')::uuid, current_setting('t.term')::uuid, current_setting('t.teacher')::uuid, '2034-03-06', 'absent');
select pg_temp.put(current_setting('t.kid_x')::uuid, current_setting('t.cx')::uuid, current_setting('t.term')::uuid, current_setting('t.teacher')::uuid, '2034-03-06', 'absent');
select pg_temp.check('the same register submitted three times leaves one row for the learner and day, and the last mark wins',
  (select count(*) from attendance where student_id = current_setting('t.kid_x')::uuid and taken_on = '2034-03-06') = 1
  and (select mark from attendance where student_id = current_setting('t.kid_x')::uuid and taken_on = '2034-03-06') = 'absent');
select pg_temp.check('a resubmit changes the row in place: same id, same created_at',
  (select count(*) from attendance a join qa_first f on f.id = a.id and f.created_at = a.created_at
    where a.student_id = current_setting('t.kid_x')::uuid and a.taken_on = '2034-03-06') = 1);

select pg_temp.check('a plain second insert for the same learner and day is refused (unique key student_id, taken_on)',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, '2034-03-06', 'late')$q$, current_setting('t.a'), current_setting('t.kid_x'), current_setting('t.cx'), current_setting('t.term'), current_setting('t.admin'))) = 'refused 23505');
select pg_temp.check('the same learner cannot have a second register that day under another class (the key ignores the class)',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, '2034-03-06', 'late')$q$, current_setting('t.a'), current_setting('t.kid_x'), current_setting('t.cy'), current_setting('t.term'), current_setting('t.admin'))) = 'refused 23505');
select pg_temp.info('so when a learner has changed class, whoever takes that day''s register second overwrites the first one''s mark and class_id');

-- ---------------------------------------------------------------- what a row may hold
select pg_temp.check('a mark outside present / absent / late / excused is refused',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, '2034-03-07', 'sick')$q$, current_setting('t.a'), current_setting('t.kid_x'), current_setting('t.cx'), current_setting('t.term'), current_setting('t.admin'))) = 'refused 22P02');
insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on)
  values (current_setting('t.a')::uuid, current_setting('t.kid_x')::uuid, current_setting('t.cx')::uuid, current_setting('t.term')::uuid, current_setting('t.teacher')::uuid, '2034-03-08');
select pg_temp.check('a row with no mark is stored as present',
  (select mark from attendance where student_id = current_setting('t.kid_x')::uuid and taken_on = '2034-03-08') = 'present');
select pg_temp.check('a learner of another school is refused (trigger attendance_student_tenant)',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, '2034-03-09', 'present')$q$, current_setting('t.a'), current_setting('t.kid_k'), current_setting('t.cx'), current_setting('t.term'), current_setting('t.admin'))) = 'refused 42501');

-- ---------------------------------------------------------------- the date of a register
-- The screens always send today's date from the phone's clock (packages/shared/src/attendance.ts today(), the UTC date). The
-- database takes whatever date it is given.
select pg_temp.check('a teacher can file a register dated years in the future (2034), and the database does not default or check the date',
  pg_temp.as_user(current_setting('t.teacher')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, '2034-04-05', 'present')$q$, current_setting('t.a'), current_setting('t.kid_x'), current_setting('t.cx'), current_setting('t.term'), current_setting('t.teacher'))) like 'refused%',
  'QA10-DATE FIG-1400');
select pg_temp.check('a register dated outside its term (the current term does not run into 2034) is refused',
  not exists (select 1 from attendance a join terms t on t.id = a.term_id where a.taken_on = '2034-04-05' and (a.taken_on < t.starts_on or a.taken_on > t.ends_on)),
  'QA10-DATE FIG-1400');
delete from attendance where taken_on = '2034-04-05';

-- ---------------------------------------------------------------- changing a register: who may, and what is kept
-- A seeded register of Form 2 West from 2026-09-01 (eight weeks old). The teacher is its class teacher; the Form 1 East checks use
-- a learner of a class the teacher is assigned to but is NOT the class teacher of.
create temp table qa_audit_before as select count(*) as n from audit_events;
select pg_temp.put(current_setting('t.kid_y')::uuid, current_setting('t.cy')::uuid, current_setting('t.term')::uuid, current_setting('t.admin')::uuid, '2034-03-10', 'present');
-- (An action and the read that checks it go in separate statements: a subquery in the same statement runs before the action.)
create temp table qa_rewrite as
  select pg_temp.as_user(current_setting('t.teacher')::uuid, format($q$update attendance set mark = 'absent' where student_id = %L and taken_on = '2034-03-10'$q$, current_setting('t.kid_y'))) as outcome;
select pg_temp.check('a teacher assigned to a class (not its class teacher) can rewrite that class''s register for any date, here one of another day',
  (select outcome from qa_rewrite) = 'allowed'
  and (select mark from attendance where student_id = current_setting('t.kid_y')::uuid and taken_on = '2034-03-10') = 'absent');
select pg_temp.info('who may rewrite a register: the school admin, any teacher assigned to the class for any subject, and its class teacher. There is no time limit: the screen only offers today, the API takes any date');
-- The screen's own write is an upsert that sends taken_by, so a correction replaces whoever took the register with whoever corrected it.
create temp table qa_upsert as
  select pg_temp.as_user(current_setting('t.teacher')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
      values (%L, %L, %L, %L, %L, '2034-03-10', 'late')
      on conflict (student_id, taken_on) do update set mark = excluded.mark, taken_by = excluded.taken_by$q$,
      current_setting('t.a'), current_setting('t.kid_y'), current_setting('t.cy'), current_setting('t.term'), current_setting('t.teacher'))) as outcome;
select pg_temp.check('the row still says who took the register after someone else corrected it (taken_by is not replaced by the editor)',
  (select outcome from qa_upsert) = 'allowed'
  and (select taken_by from attendance where student_id = current_setting('t.kid_y')::uuid and taken_on = '2034-03-10') = current_setting('t.admin')::uuid,
  'QA10-TRACE FIG-1406');
select pg_temp.check('changing a register leaves a trace: an audit event or a history row (the table has neither, and no trigger writes one)',
  (select count(*) from audit_events) > (select n from qa_audit_before)
  or exists (select 1 from information_schema.tables where table_name in ('attendance_history', 'attendance_audit', 'attendance_changes')),
  'QA10-TRACE FIG-1406');

-- ---------------------------------------------------------------- a learner filed in another class's register
-- The policy checks the class on the ROW (is the teacher assigned to it?) and the trigger checks the learner's school. Nothing checks
-- that the learner belongs to that class.
select pg_temp.check('a teacher cannot file a learner of another class in their own class''s register',
  pg_temp.as_user(current_setting('t.teacher')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, '2034-03-13', 'absent')$q$, current_setting('t.a'), current_setting('t.kid_y'), current_setting('t.cx'), current_setting('t.term'), current_setting('t.teacher'))) like 'refused%',
  'QA10-CLASS FIG-1407');
-- Whatever the row above did, make the stray row exist, so the next check shows what it does to the learner's own class teacher.
select pg_temp.put(current_setting('t.kid_y')::uuid, current_setting('t.cx')::uuid, current_setting('t.term')::uuid, current_setting('t.teacher')::uuid, '2034-03-13', 'absent');
-- The teacher is now the teacher of the learner's real class (Form 1 East) only.
delete from teaching_assignments where teacher_id = current_setting('t.teacher')::uuid and class_id = current_setting('t.cx')::uuid;
update classes set class_teacher_id = null where id = current_setting('t.cx')::uuid;
create temp table qa_blocked as
  select pg_temp.as_user(current_setting('t.teacher')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
      values (%L, %L, %L, %L, %L, '2034-03-13', 'present')
      on conflict (student_id, taken_on) do update set mark = excluded.mark, class_id = excluded.class_id$q$,
      current_setting('t.a'), current_setting('t.kid_y'), current_setting('t.cy'), current_setting('t.term'), current_setting('t.teacher'))) as outcome;
select pg_temp.check('the learner''s own teacher can still take that learner''s register after a stray row for the day was filed under another class',
  (select outcome from qa_blocked) = 'allowed', 'QA10-CLASS FIG-1407');
select pg_temp.info('that teacher''s attempt to take their own learner''s register was: ' || (select outcome from qa_blocked) || ' (42501 is the row-level security refusal)');

-- ---------------------------------------------------------------- a row that names another school's class or term
select pg_temp.check('the school admin cannot save a register row that points at another school''s class and term',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, '2034-03-14', 'present')$q$, current_setting('t.a'), current_setting('t.kid_x'), current_setting('t.kclass'), current_setting('t.kterm'), current_setting('t.admin'))) like 'refused%',
  'QA10-SCHOOL FIG-1407');

-- ---------------------------------------------------------------- an archived learner
update students set active = false where id = current_setting('t.kid_y')::uuid;
select pg_temp.info('a learner archived after the register was taken keeps their old rows (the Dashboard counts them: e2e/attendance.spec.ts); the database also still takes a new row for an archived learner: '
  || pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, '2034-03-15', 'present')$q$, current_setting('t.a'), current_setting('t.kid_y'), current_setting('t.cy'), current_setting('t.term'), current_setting('t.admin'))));
update students set active = true where id = current_setting('t.kid_y')::uuid;

-- ---------------------------------------------------------------- three counts of "here" on the same rows
-- Kijani Ridge belongs to a group, so its row in organization_tenant_summary (the group dashboard's "present today") is kept by a
-- trigger on attendance. Today's register is made up here: 5 present, 2 late, 2 absent, 1 excused (ten learners of one class).
-- The school Dashboard, Reports, the parent screen and report cards all call a late arrival "here" (the Dashboard's own comment:
-- "A late arrival still attended"). The group dashboard should agree.
delete from attendance where tenant_id = current_setting('t.k')::uuid and taken_on = current_date;
create temp table qa_ten as
  select id, row_number() over (order by id) as n from students
  where class_id = current_setting('t.kclass')::uuid and active order by id limit 10;
insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
  select current_setting('t.k')::uuid, k.id, current_setting('t.kclass')::uuid, current_setting('t.kterm')::uuid,
    (select id from profiles where tenant_id = current_setting('t.k')::uuid and role = 'teacher' order by id limit 1), current_date,
    (case when k.n <= 5 then 'present' when k.n <= 7 then 'late' when k.n <= 9 then 'absent' else 'excused' end)::attendance_mark
  from qa_ten k;
select pg_temp.check('the ten made-up marks are what the counts below start from (5 present, 2 late, 2 absent, 1 excused)',
  (select count(*) from attendance where tenant_id = current_setting('t.k')::uuid and taken_on = current_date) = 10
  and (select count(*) filter (where mark = 'present') from attendance where tenant_id = current_setting('t.k')::uuid and taken_on = current_date) = 5);
select pg_temp.check('the share of those ten that were here, the way the school screens count it (present + late), is 7 of 10 = 70%',
  (select count(*) filter (where mark in ('present', 'late')) from attendance where tenant_id = current_setting('t.k')::uuid and taken_on = current_date) = 7);
select pg_temp.check('the group dashboard''s "present today" for the school (organization_tenant_summary.present_today) counts the 7 who were here, late arrivals included',
  (select present_today from organization_tenant_summary where tenant_id = current_setting('t.k')::uuid) = 7,
  'QA10-GROUP FIG-1408');
select pg_temp.info('present_today is ' || (select present_today from organization_tenant_summary where tenant_id = current_setting('t.k')::uuid)
  || ' for those ten (current_date is the UTC date, and only mark = present is counted)');

rollback;
