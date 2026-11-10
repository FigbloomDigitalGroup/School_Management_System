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
--
-- Registers are filed in terms made up here (March 2020, and one around today), because the database refuses a register dated after
-- today in the school's time zone or outside its term (FIG-1400).

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

-- Runs one statement as the database owner and says whether the database took it.
create function pg_temp.run(p_stmt text) returns text language plpgsql as $$
begin execute p_stmt; return 'allowed'; exception when others then return 'refused ' || sqlstate; end $$;

-- Like as_user, but a refusal comes back with its message ("23514 This register is dated ..."), so the wording can be checked.
create function pg_temp.why(p_user uuid, p_stmt text) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    execute p_stmt;
    reset role;
    return 'allowed';
  exception when others then
    reset role;
    return sqlstate || ' ' || sqlerrm;
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

-- A register must lie inside its term and not be dated after today (FIG-1400), so the registers below are filed in terms made up for
-- these checks: March 2020 (in both schools) for the dated ones, and one around today for the checks about today.
select set_config('t.curterm', current_setting('t.term'), true);
with tm as (insert into terms (tenant_id, name, year, index, starts_on, ends_on, is_current)
              values (current_setting('t.a')::uuid, 'QA10 March 2020', 2020, 1, '2020-03-01', '2020-03-31', false) returning id)
  select set_config('t.term', (select id::text from tm), true);
with tm as (insert into terms (tenant_id, name, year, index, starts_on, ends_on, is_current)
              values (current_setting('t.k')::uuid, 'QA10 March 2020', 2020, 1, '2020-03-01', '2020-03-31', false) returning id)
  select set_config('t.kterm20', (select id::text from tm), true);
-- Around today: a term of the school's own that covers yesterday to tomorrow (the seeded current one, usually). Only when there is
-- none is one made up, after the school's last term: since 20261105550000 a school's terms may not overlap or run out of order.
select set_config('t.nowterm', coalesce(
  (select id::text from terms where tenant_id = current_setting('t.a')::uuid
      and starts_on <= school_today(current_setting('t.a')::uuid) - 1 and ends_on >= school_today(current_setting('t.a')::uuid) + 1
    order by starts_on desc limit 1), ''), true);
create function pg_temp.make_nowterm() returns text language plpgsql as $$
declare v uuid;
begin
  insert into terms (tenant_id, name, year, index, starts_on, ends_on, is_current)
  select current_setting('t.a')::uuid, 'QA10 around today', coalesce(max(year), 2020) + 1, 1,
         school_today(current_setting('t.a')::uuid) - 30, school_today(current_setting('t.a')::uuid) + 30, false
    from terms where tenant_id = current_setting('t.a')::uuid
  returning id into v;
  return v::text;
end $$;
select set_config('t.nowterm', pg_temp.make_nowterm(), true) where current_setting('t.nowterm') = '';

select pg_temp.check('the seed has what these checks need (Alliance teacher, admin, term and two classes with learners; a Kijani Ridge class)',
  current_setting('t.teacher') <> '' and current_setting('t.admin') <> '' and current_setting('t.curterm') <> ''
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
-- Dates on 2020-03-xx, in the March 2020 term made up above: no seeded register is anywhere near them.
select pg_temp.put(current_setting('t.kid_x')::uuid, current_setting('t.cx')::uuid, current_setting('t.term')::uuid, current_setting('t.teacher')::uuid, '2020-03-06', 'present');
create temp table qa_first as select id, created_at from attendance where student_id = current_setting('t.kid_x')::uuid and taken_on = '2020-03-06';
select pg_temp.put(current_setting('t.kid_x')::uuid, current_setting('t.cx')::uuid, current_setting('t.term')::uuid, current_setting('t.teacher')::uuid, '2020-03-06', 'absent');
select pg_temp.put(current_setting('t.kid_x')::uuid, current_setting('t.cx')::uuid, current_setting('t.term')::uuid, current_setting('t.teacher')::uuid, '2020-03-06', 'absent');
select pg_temp.check('the same register submitted three times leaves one row for the learner and day, and the last mark wins',
  (select count(*) from attendance where student_id = current_setting('t.kid_x')::uuid and taken_on = '2020-03-06') = 1
  and (select mark from attendance where student_id = current_setting('t.kid_x')::uuid and taken_on = '2020-03-06') = 'absent');
select pg_temp.check('a resubmit changes the row in place: same id, same created_at',
  (select count(*) from attendance a join qa_first f on f.id = a.id and f.created_at = a.created_at
    where a.student_id = current_setting('t.kid_x')::uuid and a.taken_on = '2020-03-06') = 1);

select pg_temp.check('a plain second insert for the same learner and day is refused (unique key student_id, taken_on)',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, '2020-03-06', 'late')$q$, current_setting('t.a'), current_setting('t.kid_x'), current_setting('t.cx'), current_setting('t.term'), current_setting('t.admin'))) = 'refused 23505');
select pg_temp.check('the same learner cannot have a second register that day under another class: refused as not their class (FIG-1407), before the key (which ignores the class) is reached',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, '2020-03-06', 'late')$q$, current_setting('t.a'), current_setting('t.kid_x'), current_setting('t.cy'), current_setting('t.term'), current_setting('t.admin'))) = 'refused 23514');
select pg_temp.info('so when a learner has changed class, whoever takes that day''s register second overwrites the first one''s mark and class_id');

-- ---------------------------------------------------------------- what a row may hold
select pg_temp.check('a mark outside present / absent / late / excused is refused',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, '2020-03-07', 'sick')$q$, current_setting('t.a'), current_setting('t.kid_x'), current_setting('t.cx'), current_setting('t.term'), current_setting('t.admin'))) = 'refused 22P02');
insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on)
  values (current_setting('t.a')::uuid, current_setting('t.kid_x')::uuid, current_setting('t.cx')::uuid, current_setting('t.term')::uuid, current_setting('t.teacher')::uuid, '2020-03-08');
select pg_temp.check('a row with no mark is stored as present',
  (select mark from attendance where student_id = current_setting('t.kid_x')::uuid and taken_on = '2020-03-08') = 'present');
select pg_temp.check('a learner of another school is refused (trigger attendance_student_tenant)',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, '2020-03-09', 'present')$q$, current_setting('t.a'), current_setting('t.kid_k'), current_setting('t.cx'), current_setting('t.term'), current_setting('t.admin'))) = 'refused 42501');

-- ---------------------------------------------------------------- the date of a register (FIG-1400)
-- A register is dated in the school's own time zone (tenants.timezone, Africa/Nairobi unless set). It may not be dated after today
-- there, it must lie inside the term it names, and one sent with no date is filed under today. A refusal says why in words, and the
-- phone keeps the register. (The database used to take any date: 2034, the day before the term began, a phone with the wrong date;
-- this is why the dates in the rest of this file are in the March 2020 term made up above.)
create function pg_temp.file(p_on date, p_term uuid) returns text language sql as $$
  select pg_temp.why(current_setting('t.teacher')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, %L, 'present')$q$, current_setting('t.a'), current_setting('t.kid_x'), current_setting('t.cx'), p_term, current_setting('t.teacher'), p_on))
$$;
-- (Seeded registers may already stand for today; these checks use the learners' days around today themselves.)
delete from attendance where student_id in (current_setting('t.kid_x')::uuid, current_setting('t.kid_y')::uuid)
  and taken_on >= school_today(current_setting('t.a')::uuid) - 1;

select pg_temp.check('the school''s time zone is Africa/Nairobi unless it says otherwise (both schools, and the column default)',
  (select count(*) from tenants where slug in ('alliance', 'kijani-ridge') and timezone = 'Africa/Nairobi') = 2
  and (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'tenants' and column_name = 'timezone') like '''Africa/Nairobi''%');
select pg_temp.check('a register dated today in the school''s time zone, inside its term, is taken',
  pg_temp.file(school_today(current_setting('t.a')::uuid), current_setting('t.nowterm')::uuid) = 'allowed');
select pg_temp.check('a register dated tomorrow is refused, and the message says why in words',
  pg_temp.file(school_today(current_setting('t.a')::uuid) + 1, current_setting('t.nowterm')::uuid) like '23514 This register is dated % but today is %: check the date on this phone');
select pg_temp.check('a register dated years in the future (2034) is refused',
  pg_temp.file(date '2034-04-05', current_setting('t.nowterm')::uuid) like '23514 This register is dated 05 Apr 2034 but today is %');
select pg_temp.check('a register dated before its term began is refused, naming the term and its dates',
  pg_temp.file(date '2020-02-29', current_setting('t.term')::uuid) like '23514 This register is dated 29 Feb 2020, which is outside the term "QA10 March 2020" (01 Mar 2020 to 31 Mar 2020)');
select pg_temp.check('a register dated after its term ended is refused',
  pg_temp.file(date '2020-04-01', current_setting('t.term')::uuid) like '23514 This register is dated 01 Apr 2020, which is outside the term %');
select pg_temp.check('the first and the last day of the term are taken',
  pg_temp.file(date '2020-03-01', current_setting('t.term')::uuid) = 'allowed'
  and pg_temp.file(date '2020-03-31', current_setting('t.term')::uuid) = 'allowed');
select pg_temp.check('moving a saved register to a date outside its term is refused too',
  pg_temp.as_user(current_setting('t.teacher')::uuid, format($q$update attendance set taken_on = '2020-04-02' where student_id = %L and taken_on = '2020-03-31'$q$, current_setting('t.kid_x'))) = 'refused 23514');

-- A register sent with no date (an older phone, a direct write): under today in the school's time zone.
create temp table qa_nodate as
  select pg_temp.as_user(current_setting('t.teacher')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, mark)
    values (%L, %L, %L, %L, %L, 'present')$q$, current_setting('t.a'), current_setting('t.kid_y'), current_setting('t.cy'), current_setting('t.nowterm'), current_setting('t.teacher'))) as outcome;
select pg_temp.check('a register sent with no date is filed under today in the school''s time zone',
  (select outcome from qa_nodate) = 'allowed'
  and (select taken_on from attendance where student_id = current_setting('t.kid_y')::uuid and term_id = current_setting('t.nowterm')::uuid) = school_today(current_setting('t.a')::uuid));

-- The time zone is the school's: 14 hours ahead of UTC (Kiritimati) and 11 behind (Pago Pago) are never on the same date.
update tenants set timezone = 'Pacific/Kiritimati' where id = current_setting('t.a')::uuid;
create temp table qa_tz_east as select school_today(current_setting('t.a')::uuid) as d, (now() at time zone 'Pacific/Kiritimati')::date as want;
update tenants set timezone = 'Pacific/Pago_Pago' where id = current_setting('t.a')::uuid;
create temp table qa_tz_west as select school_today(current_setting('t.a')::uuid) as d, (now() at time zone 'Pacific/Pago_Pago')::date as want;
select pg_temp.check('school_today follows the school''s time zone (UTC+14 and UTC-11 are on different dates, each its own)',
  (select d = want from qa_tz_east) and (select d = want from qa_tz_west) and (select e.d > w.d from qa_tz_east e, qa_tz_west w));
delete from attendance where student_id = current_setting('t.kid_x')::uuid and taken_on >= (select d from qa_tz_west);
select pg_temp.check('a school at UTC-11 refuses a register dated for the day that has already begun at UTC+14',
  pg_temp.file((select d from qa_tz_east), current_setting('t.nowterm')::uuid) like '23514 This register is dated % but today is %');
update tenants set timezone = 'Pacific/Kiritimati' where id = current_setting('t.a')::uuid;
select pg_temp.check('the same register is taken once the school is at UTC+14',
  pg_temp.file((select d from qa_tz_east), current_setting('t.nowterm')::uuid) = 'allowed');
select pg_temp.check('an unknown time zone is refused when a school is set up or changed',
  pg_temp.run(format('update tenants set timezone = %L where id = %L', 'Mars/Olympus', current_setting('t.a'))) = 'refused 22023'
  and pg_temp.run(format('update tenants set timezone = %L where id = %L', '', current_setting('t.a'))) = 'refused 22023');
update tenants set timezone = 'Africa/Nairobi' where id = current_setting('t.a')::uuid;

-- ---------------------------------------------------------------- two registers for one learner and day: the newest stands (FIG-1410)
-- Every row carries marked_at, the time the register was taken (the apps stamp it when the teacher submits). A phone with no signal
-- sends its register when the signal returns, as an upsert, so the last one to ARRIVE used to win and a correction made meanwhile was
-- lost. Now an update stamped earlier than the stored row is ignored. The stamps below are relative to now(), which is the start of
-- this transaction and what the database compares with.
create function pg_temp.send(p_user uuid, p_mark text, p_stamp timestamptz) returns text language sql as $$
  select pg_temp.as_user(p_user, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark, marked_at)
    values (%L, %L, %L, %L, %L, '2020-03-20', %L, %L)
    on conflict (student_id, taken_on) do update set mark = excluded.mark, taken_by = excluded.taken_by, marked_at = excluded.marked_at$q$,
    current_setting('t.a'), current_setting('t.kid_x'), current_setting('t.cx'), current_setting('t.term'), p_user, p_mark, p_stamp))
$$;
select pg_temp.check('a register saved with no time of its own is stamped with the moment it was saved',
  (select a.marked_at from attendance a join qa_first f on f.id = a.id) = now());

create temp table qa_s1 as select pg_temp.send(current_setting('t.teacher')::uuid, 'present', now() - interval '2 hours') as outcome;
create temp table qa_s2 as select pg_temp.send(current_setting('t.admin')::uuid, 'absent', now() - interval '1 hour') as outcome;
select pg_temp.check('the office''s correction, stamped later than the teacher''s register, replaces it',
  (select outcome from qa_s1) = 'allowed' and (select outcome from qa_s2) = 'allowed'
  and (select mark from attendance where student_id = current_setting('t.kid_x')::uuid and taken_on = '2020-03-20') = 'absent'
  and (select marked_at from attendance where student_id = current_setting('t.kid_x')::uuid and taken_on = '2020-03-20') = now() - interval '1 hour');

create temp table qa_s3 as select pg_temp.send(current_setting('t.teacher')::uuid, 'present', now() - interval '2 hours') as outcome;
select pg_temp.check('the teacher''s register, held on a phone and sent later, is accepted without an error but does not replace the newer correction (mark, who took it and time all stay)',
  (select outcome from qa_s3) = 'allowed'
  and (select mark from attendance where student_id = current_setting('t.kid_x')::uuid and taken_on = '2020-03-20') = 'absent'
  and (select taken_by from attendance where student_id = current_setting('t.kid_x')::uuid and taken_on = '2020-03-20') = current_setting('t.admin')::uuid
  and (select marked_at from attendance where student_id = current_setting('t.kid_x')::uuid and taken_on = '2020-03-20') = now() - interval '1 hour');

create temp table qa_s4 as select pg_temp.send(current_setting('t.teacher')::uuid, 'late', now() - interval '30 minutes') as outcome;
select pg_temp.check('a register taken after the stored one replaces it, whoever sends it',
  (select outcome from qa_s4) = 'allowed'
  and (select mark from attendance where student_id = current_setting('t.kid_x')::uuid and taken_on = '2020-03-20') = 'late'
  and (select taken_by from attendance where student_id = current_setting('t.kid_x')::uuid and taken_on = '2020-03-20') = current_setting('t.teacher')::uuid);

create temp table qa_s5 as select pg_temp.send(current_setting('t.teacher')::uuid, 'late', now() - interval '30 minutes') as outcome;
select pg_temp.check('sending the very same register again (a reply that was lost) changes nothing and keeps its time',
  (select outcome from qa_s5) = 'allowed'
  and (select mark from attendance where student_id = current_setting('t.kid_x')::uuid and taken_on = '2020-03-20') = 'late'
  and (select marked_at from attendance where student_id = current_setting('t.kid_x')::uuid and taken_on = '2020-03-20') = now() - interval '30 minutes');

create temp table qa_s6 as
  select pg_temp.as_user(current_setting('t.admin')::uuid, format($q$update attendance set mark = 'present' where student_id = %L and taken_on = '2020-03-20'$q$, current_setting('t.kid_x'))) as outcome;
select pg_temp.check('a change that carries no time of its own was made now: it stands, and the row takes the time of the change',
  (select outcome from qa_s6) = 'allowed'
  and (select mark from attendance where student_id = current_setting('t.kid_x')::uuid and taken_on = '2020-03-20') = 'present'
  and (select marked_at from attendance where student_id = current_setting('t.kid_x')::uuid and taken_on = '2020-03-20') = now());

create temp table qa_s7 as select pg_temp.send(current_setting('t.teacher')::uuid, 'excused', now() + interval '3 hours') as outcome;
select pg_temp.check('a register stamped in the future (a phone whose clock is ahead) is taken as made now, so it cannot beat a later correction',
  (select outcome from qa_s7) = 'allowed'
  and (select mark from attendance where student_id = current_setting('t.kid_x')::uuid and taken_on = '2020-03-20') = 'excused'
  and (select marked_at from attendance where student_id = current_setting('t.kid_x')::uuid and taken_on = '2020-03-20') = now());
select pg_temp.check('no register in the database is stamped in the future',
  not exists (select 1 from attendance where marked_at > now()));

-- ---------------------------------------------------------------- changing a register: who may, and what is kept
-- A seeded register of Form 2 West (the first ten school days of the term, to 2026-09-11). The teacher is its class teacher; the Form 1 East checks use
-- a learner of a class the teacher is assigned to but is NOT the class teacher of.
create temp table qa_audit_before as select count(*) as n from audit_events;
select pg_temp.put(current_setting('t.kid_y')::uuid, current_setting('t.cy')::uuid, current_setting('t.term')::uuid, current_setting('t.admin')::uuid, '2020-03-10', 'present');
-- (An action and the read that checks it go in separate statements: a subquery in the same statement runs before the action.)
create temp table qa_rewrite as
  select pg_temp.as_user(current_setting('t.teacher')::uuid, format($q$update attendance set mark = 'absent' where student_id = %L and taken_on = '2020-03-10'$q$, current_setting('t.kid_y'))) as outcome;
select pg_temp.check('a teacher assigned to a class (not its class teacher) can rewrite that class''s register for any date, here one of another day',
  (select outcome from qa_rewrite) = 'allowed'
  and (select mark from attendance where student_id = current_setting('t.kid_y')::uuid and taken_on = '2020-03-10') = 'absent');
select pg_temp.info('who may rewrite a register: the school admin, any teacher assigned to the class for any subject, and its class teacher. There is no time limit: the screen only offers today, the API takes any date');
-- The screen's own write is an upsert that sends taken_by, so a correction replaces whoever took the register with whoever corrected it.
create temp table qa_upsert as
  select pg_temp.as_user(current_setting('t.teacher')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
      values (%L, %L, %L, %L, %L, '2020-03-10', 'late')
      on conflict (student_id, taken_on) do update set mark = excluded.mark, taken_by = excluded.taken_by$q$,
      current_setting('t.a'), current_setting('t.kid_y'), current_setting('t.cy'), current_setting('t.term'), current_setting('t.teacher'))) as outcome;
select pg_temp.check('the row still says who took the register after someone else corrected it (taken_by is not replaced by the editor)',
  (select outcome from qa_upsert) = 'allowed'
  and (select taken_by from attendance where student_id = current_setting('t.kid_y')::uuid and taken_on = '2020-03-10') = current_setting('t.admin')::uuid,
  'QA10-TRACE FIG-1406');
select pg_temp.check('changing a register leaves a trace: an audit event or a history row (the table has neither, and no trigger writes one)',
  (select count(*) from audit_events) > (select n from qa_audit_before)
  or exists (select 1 from information_schema.tables where table_name in ('attendance_history', 'attendance_audit', 'attendance_changes')),
  'QA10-TRACE FIG-1406');

-- ---------------------------------------------------------------- a learner filed in another class's register (FIG-1407)
-- The policy checks the class on the ROW (is the teacher assigned to it?); attendance_class_is_learners_class checks that the learner belongs
-- to that class. Without it a teacher could put a Form 1 East learner into the Form 2 West register, and the stray row (the key is learner and
-- day) then stopped the learner's own teacher from taking that learner's register.
select pg_temp.check('a teacher cannot file a learner of another class in their own class''s register',
  pg_temp.as_user(current_setting('t.teacher')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, '2020-03-13', 'absent')$q$, current_setting('t.a'), current_setting('t.kid_y'), current_setting('t.cx'), current_setting('t.term'), current_setting('t.teacher'))) = 'refused 23514');
select pg_temp.check('nor can the school admin: the rule is the database''s, not the policy''s',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, '2020-03-13', 'absent')$q$, current_setting('t.a'), current_setting('t.kid_y'), current_setting('t.cx'), current_setting('t.term'), current_setting('t.admin'))) = 'refused 23514');
select pg_temp.check('and the refused rows were not saved',
  (select count(*) from attendance where student_id = current_setting('t.kid_y')::uuid and taken_on = '2020-03-13') = 0);
-- The learner's own register (their real class) goes in, as ever.
select pg_temp.put(current_setting('t.kid_y')::uuid, current_setting('t.cy')::uuid, current_setting('t.term')::uuid, current_setting('t.teacher')::uuid, '2020-03-13', 'absent');
select pg_temp.check('a saved row cannot be moved into another class than the learner''s',
  pg_temp.as_user(current_setting('t.admin')::uuid, format('update attendance set class_id = %L where student_id = %L and taken_on = %L', current_setting('t.cx'), current_setting('t.kid_y'), '2020-03-13')) = 'refused 23514');
-- The teacher is now the teacher of the learner's real class (Form 1 East) only.
delete from teaching_assignments where teacher_id = current_setting('t.teacher')::uuid and class_id = current_setting('t.cx')::uuid;
update classes set class_teacher_id = null where id = current_setting('t.cx')::uuid;
create temp table qa_blocked as
  select pg_temp.as_user(current_setting('t.teacher')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
      values (%L, %L, %L, %L, %L, '2020-03-13', 'present')
      on conflict (student_id, taken_on) do update set mark = excluded.mark, class_id = excluded.class_id$q$,
      current_setting('t.a'), current_setting('t.kid_y'), current_setting('t.cy'), current_setting('t.term'), current_setting('t.teacher'))) as outcome;
select pg_temp.check('the learner''s own teacher can take that learner''s register: no stray row can stand in the way any more',
  (select outcome from qa_blocked) = 'allowed');

-- ---------------------------------------------------------------- a row that names another school's class or term
select pg_temp.check('the school admin cannot save a register row that points at another school''s class and term',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, '2020-03-14', 'present')$q$, current_setting('t.a'), current_setting('t.kid_x'), current_setting('t.kclass'), current_setting('t.kterm20'), current_setting('t.admin'))) like 'refused%',
  'QA10-SCHOOL FIG-1407');

-- ---------------------------------------------------------------- an archived learner
update students set active = false where id = current_setting('t.kid_y')::uuid;
select pg_temp.info('a learner archived after the register was taken keeps their old rows (the Dashboard counts them: e2e/attendance.spec.ts); the database also still takes a new row for an archived learner: '
  || pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, '2020-03-15', 'present')$q$, current_setting('t.a'), current_setting('t.kid_y'), current_setting('t.cy'), current_setting('t.term'), current_setting('t.admin'))));
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
  (select present_today from organization_tenant_summary where tenant_id = current_setting('t.k')::uuid) = 7);
-- (the summary's "today" is current_date, the UTC date, and it is refreshed when something is written: FIG-1444, a separate issue)

rollback;
