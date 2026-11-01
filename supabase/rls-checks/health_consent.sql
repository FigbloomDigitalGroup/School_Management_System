-- Health consent checks for 20261103100000_health_consent: health details
-- need a parent's or guardian's consent (in the app, or a signed form the
-- office records); without it they can only be removed; withdrawing clears
-- them and keeps the contacts; who may decide and who reads the decision;
-- details saved before consent was asked for.
--
-- Runs against a local database that has the migrations applied, inside one
-- transaction that is rolled back. It makes its own two schools and people
-- (no seed data needed). Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/health_consent.sql

\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------- helpers
create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when coalesce(ok, false) then 'PASS' else 'FAIL' end, label; end $$;
create function pg_temp.expect_eq(label text, actual text, expected text) returns void language plpgsql as $$
begin
  if actual is not distinct from expected then raise notice 'PASS %', label;
  else raise notice 'FAIL %: got %, expected %', label, actual, expected; end if;
end $$;
create function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true)
$$;
-- Runs stmt as someone, answering 'ok' or the error's SQLSTATE.
create function pg_temp.as_user(p_who text, stmt text) returns text language plpgsql as $$
begin
  perform pg_temp.act_as(current_setting('t.' || p_who));
  begin
    execute 'set local role authenticated';
    execute stmt;
    execute 'reset role';
  exception when others then
    execute 'reset role';
    return 'error ' || sqlstate;
  end;
  return 'ok';
end $$;
-- set_health_consent as someone, answering what it returned (or the error's SQLSTATE).
create function pg_temp.consent(p_who text, p_student text, p_give boolean, p_signed text default null, p_date date default null)
returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.act_as(current_setting('t.' || p_who));
  begin
    execute 'set local role authenticated';
    v := set_health_consent(current_setting('t.' || p_student)::uuid, p_give, p_signed, p_date);
    execute 'reset role';
  exception when others then
    execute 'reset role';
    return 'error ' || sqlstate;
  end;
  return v;
end $$;
-- A count someone sees.
create function pg_temp.sees(p_who text, q text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform pg_temp.act_as(current_setting('t.' || p_who));
  execute 'set local role authenticated';
  execute q into n;
  execute 'reset role';
  return n;
end $$;
create function pg_temp.health(p_student text) returns student_health language sql as $$
  select * from student_health where student_id = current_setting('t.' || p_student)::uuid
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- fixtures (as postgres)
create function pg_temp.person(p_key text, p_tenant uuid, p_role app_role, p_name text) returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v, 'consent-check-' || p_key || '-' || v || '@example.invalid');
  insert into profiles (id, tenant_id, role, full_name) values (v, p_tenant, p_role, p_name);
  perform set_config('t.' || p_key, v::text, true);
  return v;
end $$;

with x as (
  insert into tenants (name, slug, county) values ('Consent Check School', 'consent-check-a-' || substr(md5(random()::text), 1, 8), 'Nairobi') returning id
) select set_config('t.a', x.id::text, true) from x;
with x as (
  insert into tenants (name, slug, county) values ('Consent Check Other School', 'consent-check-b-' || substr(md5(random()::text), 1, 8), 'Nairobi') returning id
) select set_config('t.b', x.id::text, true) from x;

select pg_temp.person('admin',    current_setting('t.a')::uuid, 'school_admin', 'Check Principal');
select pg_temp.person('nurse',    current_setting('t.a')::uuid, 'staff',        'Check Nurse');
select pg_temp.person('teacher',  current_setting('t.a')::uuid, 'teacher',      'Check Teacher');
select pg_temp.person('mum',      current_setting('t.a')::uuid, 'parent',       'Check Mum');
select pg_temp.person('dad',      current_setting('t.a')::uuid, 'parent',       'Check Dad');
select pg_temp.person('other',    current_setting('t.a')::uuid, 'parent',       'Check Other Parent');
select pg_temp.person('away',     current_setting('t.b')::uuid, 'parent',       'Check Other-School Parent');
insert into staff_permissions (tenant_id, profile_id, area) values (current_setting('t.a')::uuid, current_setting('t.nurse')::uuid, 'medical');

with x as (
  insert into classes (tenant_id, name, form_level) values (current_setting('t.a')::uuid, 'Check 3 North', 3) returning id
) select set_config('t.class', x.id::text, true) from x;
with x as (
  insert into students (tenant_id, admission_no, full_name, class_id)
  values (current_setting('t.a')::uuid, 'HCON-1', 'Check Learner', current_setting('t.class')::uuid) returning id
) select set_config('t.student', x.id::text, true) from x;
with x as (
  insert into students (tenant_id, admission_no, full_name, class_id)
  values (current_setting('t.a')::uuid, 'HCON-2', 'Check Older Learner', current_setting('t.class')::uuid) returning id
) select set_config('t.older', x.id::text, true) from x;
insert into guardians (tenant_id, profile_id, student_id) values
  (current_setting('t.a')::uuid, current_setting('t.mum')::uuid, current_setting('t.student')::uuid),
  (current_setting('t.a')::uuid, current_setting('t.dad')::uuid, current_setting('t.student')::uuid),
  (current_setting('t.a')::uuid, current_setting('t.other')::uuid, current_setting('t.older')::uuid);

-- The older learner's details were saved before consent was asked for.
alter table student_health disable trigger student_health_consent;
insert into student_health (student_id, tenant_id, allergies, medical_conditions, emergency_name)
values (current_setting('t.older')::uuid, current_setting('t.a')::uuid, array['Eggs', 'Peanuts'], array['Asthma'], 'Check Aunt');
alter table student_health enable trigger student_health_consent;

-- ---------------------------------------------------------------- no consent yet
select pg_temp.expect_eq('without consent a parent can''t add allergies',
  pg_temp.as_user('mum', format($q$insert into student_health (student_id, tenant_id, allergies) values (%L, %L, '{Milk}')$q$,
                                current_setting('t.student'), current_setting('t.a'))), 'error 42501');
select pg_temp.expect_eq('nor the office',
  pg_temp.as_user('admin', format($q$insert into student_health (student_id, tenant_id, notes) values (%L, %L, 'Faints in heat')$q$,
                                  current_setting('t.student'), current_setting('t.a'))), 'error 42501');
select pg_temp.expect_eq('but the emergency contact and doctor need no consent',
  pg_temp.as_user('mum', format($q$insert into student_health (student_id, tenant_id, emergency_name, doctor_name) values (%L, %L, 'Check Uncle', 'Check Clinic')$q$,
                                current_setting('t.student'), current_setting('t.a'))), 'ok');
select pg_temp.check('health_consent_status: no decision, nothing on file',
  pg_temp.sees('mum', format($q$select count(*) from health_consent_status(%L) where status is null and not has_details$q$, current_setting('t.student'))) = 1);

-- ---------------------------------------------------------------- who may decide
select pg_temp.expect_eq('a teacher can''t record consent', pg_temp.consent('teacher', 'student', true), 'error 42501');
select pg_temp.expect_eq('nor the nurse (medical reads, people records)', pg_temp.consent('nurse', 'student', true, 'Check Mum', current_date), 'error 42501');
select pg_temp.expect_eq('nor another child''s parent', pg_temp.consent('other', 'student', true), 'error 42501');
select pg_temp.expect_eq('nor a parent at another school', pg_temp.consent('away', 'student', true), 'error 42501');

-- ---------------------------------------------------------------- a parent agrees in the app
select pg_temp.expect_eq('mum agrees', pg_temp.consent('mum', 'student', true), 'given');
select pg_temp.check('recorded as the app, by mum',
  (select method = 'app' and guardian_id = current_setting('t.mum')::uuid and recorded_by = current_setting('t.mum')::uuid
     from health_consents where student_id = current_setting('t.student')::uuid));
select pg_temp.expect_eq('agreeing again changes nothing', pg_temp.consent('dad', 'student', true), 'given');
select pg_temp.expect_eq('and logs nothing more',
  (select count(*)::text from health_consent_log where student_id = current_setting('t.student')::uuid), '1');
select pg_temp.expect_eq('now mum adds allergies',
  pg_temp.as_user('mum', format($q$update student_health set allergies = '{Milk}', blood_group = 'O+', medical_conditions = '{Epilepsy}' where student_id = %L$q$,
                                current_setting('t.student'))), 'ok');
select pg_temp.check('and they are saved', (select allergies = '{Milk}' and blood_group = 'O+' from pg_temp.health('student')));

-- ---------------------------------------------------------------- who reads it
select pg_temp.check('dad reads the decision',
  pg_temp.sees('dad', 'select count(*) from health_consents') = 1);
select pg_temp.check('the nurse reads it',
  pg_temp.sees('nurse', 'select count(*) from health_consents') = 1);
select pg_temp.check('a teacher doesn''t',
  pg_temp.sees('teacher', 'select count(*) from health_consents') = 0);
select pg_temp.check('nor another child''s parent',
  pg_temp.sees('other', format('select count(*) from health_consents where student_id = %L', current_setting('t.student'))) = 0);
select pg_temp.check('health_consent_status answers mum, with her name',
  pg_temp.sees('mum', format($q$select count(*) from health_consent_status(%L) where status = 'given' and guardian_name = 'Check Mum' and has_details$q$,
                             current_setting('t.student'))) = 1);
select pg_temp.check('and gives a teacher no row',
  pg_temp.sees('teacher', format('select count(*) from health_consent_status(%L)', current_setting('t.student'))) = 0);
select pg_temp.check('nobody writes the table directly',
  pg_temp.as_user('mum', format($q$update health_consents set status = 'withdrawn' where student_id = %L$q$, current_setting('t.student'))) = 'ok'
  and (select status = 'given' from health_consents where student_id = current_setting('t.student')::uuid));

-- ---------------------------------------------------------------- withdrawing
select pg_temp.expect_eq('dad withdraws', pg_temp.consent('dad', 'student', false), 'withdrawn');
select pg_temp.check('the health details are gone',
  (select allergies = '{}' and medical_conditions = '{}' and blood_group is null from pg_temp.health('student')));
select pg_temp.check('the contacts are kept',
  (select emergency_name = 'Check Uncle' and doctor_name = 'Check Clinic' from pg_temp.health('student')));
select pg_temp.expect_eq('and nothing can be added again',
  pg_temp.as_user('admin', format($q$update student_health set allergies = '{Milk}' where student_id = %L$q$, current_setting('t.student'))), 'error 42501');
select pg_temp.check('the audit log names no health details',
  not exists (select 1 from audit_events where tenant_id = current_setting('t.a')::uuid
               and (event ilike '%milk%' or event ilike '%epilepsy%' or metadata::text ilike '%milk%')));

-- ---------------------------------------------------------------- the office, from a signed form
select pg_temp.expect_eq('a form needs who signed it', pg_temp.consent('admin', 'student', true, null, current_date), 'error 22023');
select pg_temp.expect_eq('and its date', pg_temp.consent('admin', 'student', true, 'Check Mum', null), 'error 22023');
select pg_temp.expect_eq('not in the future', pg_temp.consent('admin', 'student', true, 'Check Mum', current_date + 1), 'error 22023');
select pg_temp.expect_eq('the office records a signed form', pg_temp.consent('admin', 'student', true, 'Check Mum', current_date - 3), 'given');
select pg_temp.check('recorded as paper, by the office, naming the signer',
  (select method = 'paper' and guardian_id is null and recorded_by = current_setting('t.admin')::uuid
          and signed_by = 'Check Mum' and form_date = current_date - 3
     from health_consents where student_id = current_setting('t.student')::uuid));
select pg_temp.expect_eq('withdrawing for a parent needs who asked', pg_temp.consent('admin', 'student', false), 'error 22023');
select pg_temp.expect_eq('with a name it works', pg_temp.consent('admin', 'student', false, 'Check Dad'), 'withdrawn');
select pg_temp.expect_eq('every change is logged',
  (select count(*)::text from health_consent_log where student_id = current_setting('t.student')::uuid), '4');

-- ---------------------------------------------------------------- details from before consent
select pg_temp.check('the older learner''s parent is asked',
  pg_temp.sees('other', 'select count(*) from my_health_consent_requests()') = 1);
select pg_temp.check('mum isn''t asked about a child that isn''t hers',
  pg_temp.sees('mum', 'select count(*) from my_health_consent_requests()') = 0);
select pg_temp.check('staff still see the details',
  pg_temp.sees('teacher', format('select count(*) from student_health where student_id = %L and cardinality(allergies) = 2', current_setting('t.older'))) = 1);
select pg_temp.expect_eq('the office may take an allergy out',
  pg_temp.as_user('admin', format($q$update student_health set allergies = '{Peanuts}' where student_id = %L$q$, current_setting('t.older'))), 'ok');
select pg_temp.expect_eq('but not put a new one in',
  pg_temp.as_user('admin', format($q$update student_health set allergies = '{Peanuts,Soy}' where student_id = %L$q$, current_setting('t.older'))), 'error 42501');
select pg_temp.expect_eq('nor change a condition',
  pg_temp.as_user('admin', format($q$update student_health set medical_conditions = '{Diabetes}' where student_id = %L$q$, current_setting('t.older'))), 'error 42501');
select pg_temp.expect_eq('the contact can still change',
  pg_temp.as_user('admin', format($q$update student_health set emergency_phone = '0700 000 000' where student_id = %L$q$, current_setting('t.older'))), 'ok');
select pg_temp.expect_eq('the parent says no', pg_temp.consent('other', 'older', false), 'withdrawn');
select pg_temp.check('the details are deleted, the contact kept',
  (select allergies = '{}' and medical_conditions = '{}' and emergency_name = 'Check Aunt' from pg_temp.health('older')));
select pg_temp.check('and the parent isn''t asked again',
  pg_temp.sees('other', 'select count(*) from my_health_consent_requests()') = 0);

rollback;
