-- Learner records in the database (QA 11, FIG-1244): what a learner row may hold, what archiving and promoting leave behind, and
-- what a family still sees when a learner changes class.
--
-- learners.sql (23 checks) covers who may archive, restore and delete, and that archiving keeps fees, marks and attendance. This
-- file covers the rest of the checklist: the values a row accepts, one admission number per school, archive across schools, the
-- direct update the Promote screen uses to take learners off the roll, and results after a class change. The CSV parser is in
-- apps/web/src/lib/studentImport.test.ts, the app's own functions are in tests/integration/learners.test.ts, and the screens are in
-- e2e/learners.spec.ts. Runs against a local database with `npm run db:seed` and `db:seed-org` data, in one transaction that is
-- rolled back. Every check prints PASS, FAIL, KNOWN <bug> (a defect already filed: KNOWN until it is fixed, then PASS) or INFO.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/learner_records.sql
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

-- ---------------------------------------------------------------- what is there to work with
select set_config('t.a', (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.k', (select id::text from tenants where slug = 'kijani-ridge'), true);
select set_config('t.admin', (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.a')::uuid order by id limit 1), true);
select set_config('t.parent', (select id::text from profiles where login_id = 'PT-0002' and tenant_id = current_setting('t.a')::uuid), true);
select set_config('t.west', (select id::text from classes where tenant_id = current_setting('t.a')::uuid and name = 'Form 2 West'), true);
select set_config('t.up', (select id::text from classes where tenant_id = current_setting('t.a')::uuid and name = 'Form 3 East'), true);
-- Faith (admission 4102): in Form 2 West, whose Mock 1 results are published, with ten days of attendance and an invoice.
select set_config('t.faith', (select id::text from students where tenant_id = current_setting('t.a')::uuid and admission_no = '4102'), true);
select set_config('t.kid_k', (select id::text from students where tenant_id = current_setting('t.k')::uuid and active order by id limit 1), true);
select pg_temp.check('the seed has what these checks need (Alliance admin, parent PT-0002, Faith in Form 2 West, Form 3 East, a Kijani Ridge learner)',
  current_setting('t.admin') <> '' and current_setting('t.parent') <> '' and current_setting('t.west') <> '' and current_setting('t.up') <> ''
  and current_setting('t.faith') <> '' and current_setting('t.kid_k') <> ''
  and (select class_id from students where id = current_setting('t.faith')::uuid) = current_setting('t.west')::uuid);

-- ---------------------------------------------------------------- one admission number per school, not per database
insert into students (tenant_id, admission_no, full_name, class_id, boarding, active, gender)
  values (current_setting('t.a')::uuid, 'QA11-1', 'QA11 First', current_setting('t.west')::uuid, false, true, 'female');
select pg_temp.check('the same admission number twice in one school is refused (unique tenant_id, admission_no)',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into students (tenant_id, admission_no, full_name, class_id, boarding, active, gender)
    values (%L, 'QA11-1', 'QA11 Second', %L, false, true, 'male')$q$, current_setting('t.a'), current_setting('t.west'))) = 'refused 23505');
with ins as (
  insert into students (tenant_id, admission_no, full_name, class_id, boarding, active, gender)
  select current_setting('t.k')::uuid, 'QA11-1', 'QA11 Elsewhere', (select id from classes where tenant_id = current_setting('t.k')::uuid order by id limit 1), false, true, 'male'
  returning 1)
select pg_temp.check('the same number in another school is fine: admission numbers belong to the school', (select count(*) from ins) = 1);
update students set active = false where admission_no = 'QA11-1' and tenant_id = current_setting('t.a')::uuid;
select pg_temp.check('a number is still taken by an ARCHIVED learner: a new learner cannot reuse it',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into students (tenant_id, admission_no, full_name, class_id, boarding, active, gender)
    values (%L, 'QA11-1', 'QA11 Reuse', %L, false, true, 'male')$q$, current_setting('t.a'), current_setting('t.west'))) = 'refused 23505');
select pg_temp.info('the roster the People screen checks a new number against lists ACTIVE learners only, so it cannot see that number: the database refuses it with "duplicate key value" (tests/integration/learners.test.ts)');
select pg_temp.info('admission numbers are compared exactly: QA11-1 and qa11-1 are two numbers: '
  || pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into students (tenant_id, admission_no, full_name, class_id, boarding, active, gender)
    values (%L, 'qa11-1', 'QA11 Lower case', %L, false, true, 'male')$q$, current_setting('t.a'), current_setting('t.west'))));

-- ---------------------------------------------------------------- what a row may hold
select pg_temp.check('a gender other than male or female is refused (students_gender_check)',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into students (tenant_id, admission_no, full_name, class_id, boarding, active, gender)
    values (%L, 'QA11-2', 'QA11 Gender', %L, false, true, 'robot')$q$, current_setting('t.a'), current_setting('t.west'))) = 'refused 23514');
select pg_temp.check('a learner of a K-12 school with no class is refused (students_class_required_for_k12)',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into students (tenant_id, admission_no, full_name, boarding, active, gender)
    values (%L, 'QA11-3', 'QA11 No class', false, true, 'male')$q$, current_setting('t.a'))) like 'refused%');
select pg_temp.check('a date of birth in the future (2090) is refused',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into students (tenant_id, admission_no, full_name, class_id, boarding, active, gender, date_of_birth)
    values (%L, 'QA11-4', 'QA11 Future', %L, false, true, 'male', '2090-01-01')$q$, current_setting('t.a'), current_setting('t.west'))) like 'refused%',
  'QA11-DOB FIG-1421');
select pg_temp.check('a date of birth in 1800 is refused',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into students (tenant_id, admission_no, full_name, class_id, boarding, active, gender, date_of_birth)
    values (%L, 'QA11-5', 'QA11 Old', %L, false, true, 'male', '1800-01-01')$q$, current_setting('t.a'), current_setting('t.west'))) like 'refused%',
  'QA11-DOB FIG-1421');
select pg_temp.info('the Add form and the CSV import need a name, but the database takes an empty or blank full_name: '
  || pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into students (tenant_id, admission_no, full_name, class_id, boarding, active, gender)
    values (%L, 'QA11-6', '   ', %L, false, true, 'male')$q$, current_setting('t.a'), current_setting('t.west'))));

-- ---------------------------------------------------------------- archive across schools
select pg_temp.check('the admin of one school cannot archive a learner of another (42501)',
  pg_temp.as_user(current_setting('t.admin')::uuid, format('select archive_learners(array[%L]::uuid[])', current_setting('t.kid_k'))) = 'refused 42501');
select pg_temp.check('and that learner is still active',
  (select active from students where id = current_setting('t.kid_k')::uuid));

-- ---------------------------------------------------------------- the Promote screen takes learners off the roll with a direct update
-- PromoteClass.tsx marks "Graduating" and "Leaving" learners with students.update({ active: false }) and not with archive_learners(),
-- which is the one that stamps archived_at and archived_by and writes the audit event ("N learners archived").
insert into students (tenant_id, admission_no, full_name, class_id, boarding, active, gender)
  values (current_setting('t.a')::uuid, 'QA11-7', 'QA11 Graduating', current_setting('t.west')::uuid, false, true, 'female');
create temp table qa_audit_before as select count(*) as n from audit_events where tenant_id = current_setting('t.a')::uuid;
create temp table qa_promote as
  select pg_temp.as_user(current_setting('t.admin')::uuid, format($q$update students set active = false where admission_no = 'QA11-7' and tenant_id = %L$q$, current_setting('t.a'))) as outcome;
select pg_temp.check('the Promote screen''s own write (update students set active = false) is allowed for the school admin and takes the learner off the roll',
  (select outcome from qa_promote) = 'allowed' and not (select active from students where admission_no = 'QA11-7' and tenant_id = current_setting('t.a')::uuid));
select pg_temp.check('a learner taken off the roll that way is stamped with when and by whom (archived_at, archived_by) and the audit log says so',
  (select archived_at is not null and archived_by is not null from students where admission_no = 'QA11-7' and tenant_id = current_setting('t.a')::uuid)
  and (select count(*) from audit_events where tenant_id = current_setting('t.a')::uuid) > (select n from qa_audit_before),
  'QA11-PROMOTE FIG-1420');

-- ---------------------------------------------------------------- a class change, and what the family still sees
-- Faith's parent reads her marks through mark_read, which asks marks_published(exam, the learner's CURRENT class, subject): a mark
-- is shown only if the class she is in NOW has published it.
create temp table qa_before as select
  pg_temp.count_as(current_setting('t.parent')::uuid, format('select count(*) from marks where student_id = %L', current_setting('t.faith'))) as marks,
  pg_temp.count_as(current_setting('t.parent')::uuid, format('select count(*) from attendance where student_id = %L', current_setting('t.faith'))) as attendance,
  pg_temp.count_as(current_setting('t.parent')::uuid, format('select count(*) from fee_invoices where student_id = %L', current_setting('t.faith'))) as invoices;
select pg_temp.check('before the move: the parent sees the marks published for Faith, her attendance and her invoice',
  (select marks > 0 and attendance > 0 and invoices > 0 from qa_before));
update students set class_id = current_setting('t.up')::uuid where id = current_setting('t.faith')::uuid;
create temp table qa_after as select
  pg_temp.count_as(current_setting('t.parent')::uuid, format('select count(*) from marks where student_id = %L', current_setting('t.faith'))) as marks,
  pg_temp.count_as(current_setting('t.parent')::uuid, format('select count(*) from attendance where student_id = %L', current_setting('t.faith'))) as attendance,
  pg_temp.count_as(current_setting('t.parent')::uuid, format('select count(*) from fee_invoices where student_id = %L', current_setting('t.faith'))) as invoices;
select pg_temp.check('after moving Faith up a class: her attendance is still there',
  (select attendance from qa_after) = (select attendance from qa_before));
select pg_temp.check('after moving Faith up a class: her invoice is still there',
  (select invoices from qa_after) = (select invoices from qa_before));
select pg_temp.check('after moving Faith up a class: the marks that were published for her are still there for her parent',
  (select marks from qa_after) = (select marks from qa_before), 'QA11-RESULTS FIG-1418');
select pg_temp.info('marks the parent could read before the move: ' || (select marks from qa_before) || ', after: ' || (select marks from qa_after)
  || ' (the new class has published nothing)');

rollback;
