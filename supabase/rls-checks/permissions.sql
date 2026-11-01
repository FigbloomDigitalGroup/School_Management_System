-- Admin area checks for 20261031000000_admin_areas and 20261031000001_admin_areas_policies.
--
-- Runs against a local database that has the migrations applied, inside one
-- transaction that is rolled back. It makes its own two schools and people
-- (no seed data needed), so it also runs on a fresh copy of production's
-- schema. Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/permissions.sql

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
-- Two schools; at the first: a principal (full admin), a bursar (other staff),
-- a deputy (teacher), a plain teacher, a receptionist and a nurse (other
-- staff), a parent and a learner with marks and an invoice.
create function pg_temp.person(p_key text, p_tenant uuid, p_role app_role, p_name text) returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v, 'perm-check-' || p_key || '-' || v || '@example.invalid');
  insert into profiles (id, tenant_id, role, full_name) values (v, p_tenant, p_role, p_name);
  perform set_config('t.' || p_key, v::text, true);
  return v;
end $$;

with insert_a as (
  insert into tenants (name, slug, county) values ('Permissions Check School', 'perm-check-a-' || substr(md5(random()::text), 1, 8), 'Nairobi') returning id
) select set_config('t.a', insert_a.id::text, true) from insert_a;
with insert_b as (
  insert into tenants (name, slug, county) values ('Permissions Check Other School', 'perm-check-b-' || substr(md5(random()::text), 1, 8), 'Nairobi') returning id
) select set_config('t.b', insert_b.id::text, true) from insert_b;

select pg_temp.person('admin',   current_setting('t.a')::uuid, 'school_admin', 'Check Principal');
select pg_temp.person('bursar',  current_setting('t.a')::uuid, 'staff',        'Check Bursar');
select pg_temp.person('deputy',  current_setting('t.a')::uuid, 'teacher',      'Check Deputy');
select pg_temp.person('teacher', current_setting('t.a')::uuid, 'teacher',      'Check Teacher');
select pg_temp.person('recep',   current_setting('t.a')::uuid, 'staff',        'Check Receptionist');
select pg_temp.person('nurse',   current_setting('t.a')::uuid, 'staff',        'Check Nurse');
select pg_temp.person('parent',  current_setting('t.a')::uuid, 'parent',       'Check Parent');
select pg_temp.person('other',   current_setting('t.b')::uuid, 'teacher',      'Check Other-School Teacher');

with x as (
  insert into terms (tenant_id, name, year, index, starts_on, ends_on, is_current)
  values (current_setting('t.a')::uuid, 'Check Term', 2026, 3, '2026-09-01', '2026-11-30', true) returning id
) select set_config('t.term', x.id::text, true) from x;
with x as (
  insert into classes (tenant_id, name, form_level) values (current_setting('t.a')::uuid, 'Check 2 West', 2) returning id
) select set_config('t.class', x.id::text, true) from x;
with x as (
  insert into subjects (tenant_id, name, code) values (current_setting('t.a')::uuid, 'Check Maths', 'CHKM') returning id
) select set_config('t.subject', x.id::text, true) from x;
with x as (
  insert into students (tenant_id, admission_no, full_name, class_id)
  values (current_setting('t.a')::uuid, 'CHK-1', 'Check Learner', current_setting('t.class')::uuid) returning id
) select set_config('t.student', x.id::text, true) from x;
insert into guardians (tenant_id, profile_id, student_id)
values (current_setting('t.a')::uuid, current_setting('t.parent')::uuid, current_setting('t.student')::uuid);
-- health details need consent first (20261103100000_health_consent)
insert into health_consents (student_id, tenant_id, status, method, signed_by)
values (current_setting('t.student')::uuid, current_setting('t.a')::uuid, 'given', 'paper', 'Check guardian');
insert into student_health (student_id, tenant_id, notes)
values (current_setting('t.student')::uuid, current_setting('t.a')::uuid, 'perm-check');
with x as (
  insert into exams (tenant_id, term_id, name) values (current_setting('t.a')::uuid, current_setting('t.term')::uuid, 'Check CAT') returning id
) select set_config('t.exam', x.id::text, true) from x;
insert into marks (tenant_id, exam_id, student_id, subject_id, score, entered_by)
values (current_setting('t.a')::uuid, current_setting('t.exam')::uuid, current_setting('t.student')::uuid,
        current_setting('t.subject')::uuid, 50, current_setting('t.admin')::uuid);
with x as (
  insert into fee_invoices (tenant_id, student_id, term_id, total_cents, due_on)
  values (current_setting('t.a')::uuid, current_setting('t.student')::uuid, current_setting('t.term')::uuid, 1000000, '2026-10-31') returning id
) select set_config('t.invoice', x.id::text, true) from x;

-- ---------------------------------------------------------------- the visitor log moved to grants
select pg_temp.expect_eq('everyone who had handles_visitors holds the visitors area',
  (select count(*) from profiles p where p.handles_visitors
     and not exists (select 1 from staff_permissions sp where sp.profile_id = p.id and sp.area = 'visitors')), 0);

-- ---------------------------------------------------------------- the principal gives areas
select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;

select pg_temp.check('a full admin holds every area without a grant',
  has_perm(current_setting('t.a')::uuid, 'fees') and has_perm(current_setting('t.a')::uuid, 'academics')
  and has_perm(current_setting('t.a')::uuid, 'medical'));
select pg_temp.check('and settings, which no grant gives', has_perm(current_setting('t.a')::uuid, null));

select pg_temp.expect_ok('the principal makes the bursar a bursar',
  format($q$select set_staff_areas(%L, array['fees'])$q$, current_setting('t.bursar')));
select pg_temp.expect_ok('and the deputy a deputy principal',
  format($q$select set_staff_areas(%L, array['people','academics','attendance','communication','leave','activities'])$q$, current_setting('t.deputy')));
select pg_temp.expect_ok('and the receptionist the visitor log',
  format($q$select set_staff_areas(%L, array['visitors'])$q$, current_setting('t.recep')));
select pg_temp.expect_ok('and the nurse medical',
  format($q$select set_staff_areas(%L, array['medical'])$q$, current_setting('t.nurse')));
select pg_temp.expect_eq('each change is in the audit trail',
  (select count(*) from audit_events where tenant_id = current_setting('t.a')::uuid and category = 'access'
      and metadata->>'profile_id' in (current_setting('t.bursar'), current_setting('t.deputy'), current_setting('t.recep'), current_setting('t.nurse'))), 4);
select pg_temp.expect_eq('the principal sees the school''s grants',
  (select count(*) from staff_permissions where tenant_id = current_setting('t.a')::uuid), 9);

select pg_temp.expect_error('nobody grants themselves anything, not even a full admin',
  format($q$select set_staff_areas(%L, array['fees'])$q$, current_setting('t.admin')), '42501');
select pg_temp.expect_error('areas are for teachers and other staff, not parents',
  format($q$select set_staff_areas(%L, array['fees'])$q$, current_setting('t.parent')), '22023');
select pg_temp.expect_error('and only known areas (settings is not one)',
  format($q$select set_staff_areas(%L, array['settings'])$q$, current_setting('t.teacher')), '22023');
select pg_temp.expect_error('and only at your own school',
  format($q$select set_staff_areas(%L, array['fees'])$q$, current_setting('t.other')), '42501');
select pg_temp.expect_error('grants are never written directly',
  format($q$insert into staff_permissions (tenant_id, profile_id, area) values (%L, %L, 'fees')$q$,
         current_setting('t.a'), current_setting('t.teacher')), '42501');

-- ---------------------------------------------------------------- the bursar
reset role;
select pg_temp.act_as(current_setting('t.bursar'));
set local role authenticated;

select pg_temp.check('the bursar holds fees and nothing else',
  has_perm(current_setting('t.a')::uuid, 'fees') and not has_perm(current_setting('t.a')::uuid, 'academics')
  and not has_perm(current_setting('t.a')::uuid, 'people') and not has_perm(current_setting('t.a')::uuid, null));
select pg_temp.check('is_staff() is not widened: the bursar is still not in it', not is_staff());
select pg_temp.expect_eq('the bursar reads their own grants only', (select count(*) from staff_permissions), 1);
select pg_temp.expect_eq('the bursar lists learners to invoice them', (select count(*) from students where id = current_setting('t.student')::uuid), 1);
select pg_temp.expect_eq('and reads the invoices', (select count(*) from fee_invoices where id = current_setting('t.invoice')::uuid), 1);
select pg_temp.expect_ok('the bursar records a payment',
  format($q$select record_payment(%L, 250000, 'cash', null)$q$, current_setting('t.invoice')));
select pg_temp.expect_eq('the bursar can''t read marks', (select count(*) from marks where exam_id = current_setting('t.exam')::uuid), 0);
select pg_temp.expect_rows('or edit them',
  format($q$update marks set score = 99 where exam_id = %L$q$, current_setting('t.exam')), 0);
select pg_temp.expect_rows('or edit a learner''s record',
  format($q$update students set full_name = 'Changed' where id = %L$q$, current_setting('t.student')), 0);
select pg_temp.expect_eq('or read the audit trail', (select count(*) from audit_events), 0);
select pg_temp.expect_error('and can''t grant anyone anything',
  format($q$select set_staff_areas(%L, array['fees'])$q$, current_setting('t.teacher')), '42501');
select pg_temp.expect_error('least of all themselves',
  format($q$select set_staff_areas(%L, array['fees','people'])$q$, current_setting('t.bursar')), '42501');
select pg_temp.expect_rows('the school''s settings are out of reach',
  format($q$update terms set name = 'Changed' where id = %L$q$, current_setting('t.term')), 0);

-- ---------------------------------------------------------------- the deputy
reset role;
select pg_temp.act_as(current_setting('t.deputy'));
set local role authenticated;

select pg_temp.expect_rows('the deputy edits marks in a class they don''t teach',
  format($q$update marks set score = 61 where exam_id = %L$q$, current_setting('t.exam')), 1);
select pg_temp.expect_rows('and a learner''s record',
  format($q$update students set full_name = 'Check Learner Two' where id = %L$q$, current_setting('t.student')), 1);
select pg_temp.expect_error('but can''t record a payment',
  format($q$select record_payment(%L, 1000, 'cash', null)$q$, current_setting('t.invoice')), '42501');
select pg_temp.expect_rows('or change an invoice',
  format($q$update fee_invoices set due_on = '2026-12-01' where id = %L$q$, current_setting('t.invoice')), 0);
select pg_temp.expect_rows('people: the deputy changes a teacher''s title',
  format($q$update profiles set staff_title = 'Head of Maths' where id = %L$q$, current_setting('t.teacher')), 1);
select pg_temp.expect_rows('but not the principal''s record',
  format($q$update profiles set full_name = 'Changed' where id = %L$q$, current_setting('t.admin')), 0);
select pg_temp.expect_error('and can''t make anyone a full admin',
  format($q$update profiles set role = 'school_admin' where id = %L$q$, current_setting('t.teacher')), '42501');
select pg_temp.expect_error('or themselves one',
  format($q$update profiles set role = 'school_admin' where id = %L$q$, current_setting('t.deputy')), '42501');
select pg_temp.expect_error('or give themselves fees',
  format($q$select set_staff_areas(%L, array['fees'])$q$, current_setting('t.deputy')), '42501');
select pg_temp.check('the deputy holds attendance, so reads and corrects every register', has_perm(current_setting('t.a')::uuid, 'attendance'));
select pg_temp.expect_ok('and sends one person a direct note',
  format($q$insert into announcements (tenant_id, author_id, subject, body, audience, published_at)
            values (%L, %L, 'perm-check note', 'Your leave was approved.', jsonb_build_object('kind', 'user', 'user_id', %L), now())$q$,
         current_setting('t.a'), current_setting('t.deputy'), current_setting('t.teacher')));

-- ---------------------------------------------------------------- a teacher without areas is unchanged
reset role;
select pg_temp.act_as(current_setting('t.teacher'));
set local role authenticated;

select pg_temp.check('a teacher without areas holds none',
  not has_perm(current_setting('t.a')::uuid, 'fees') and not has_perm(current_setting('t.a')::uuid, 'academics')
  and not has_perm(current_setting('t.a')::uuid, 'people') and not has_office_perm(current_setting('t.a')::uuid));
select pg_temp.check('and is staff, as before', is_staff());
select pg_temp.expect_eq('reads learners school-wide, as before', (select count(*) from students where id = current_setting('t.student')::uuid), 1);
select pg_temp.expect_rows('but can''t edit marks in a class they don''t teach',
  format($q$update marks set score = 1 where exam_id = %L$q$, current_setting('t.exam')), 0);
select pg_temp.expect_error('or record a payment',
  format($q$select record_payment(%L, 1000, 'cash', null)$q$, current_setting('t.invoice')), '42501');
select pg_temp.expect_rows('or edit a colleague',
  format($q$update profiles set staff_title = 'Changed' where id = %L$q$, current_setting('t.deputy')), 0);
select pg_temp.expect_eq('and sees nobody''s grants', (select count(*) from staff_permissions), 0);
select pg_temp.expect_eq('nor the visitor log', (select count(*) from visit_hosts(current_setting('t.a')::uuid)), 0);

-- ---------------------------------------------------------------- the receptionist (visitors only)
reset role;
select pg_temp.act_as(current_setting('t.recep'));
set local role authenticated;

select pg_temp.check('is_front_desk() follows the visitors area', is_front_desk());
select pg_temp.expect_rows('the receptionist records a visitor',
  format($q$insert into visits (tenant_id, visitor_name, purpose, host_kind) values (%L, 'Check Visitor', 'perm-check', 'office')$q$,
         current_setting('t.a')), 1);
select pg_temp.check('and picks a host', (select count(*) from visit_hosts(current_setting('t.a')::uuid)) > 0);
select pg_temp.expect_eq('the visitor log doesn''t open the learner list', (select count(*) from students), 0);
select pg_temp.expect_rows('only a full admin deletes from the log',
  $q$delete from visits where purpose = 'perm-check'$q$, 0);

-- ---------------------------------------------------------------- the nurse (medical)
reset role;
select pg_temp.act_as(current_setting('t.nurse'));
set local role authenticated;

select pg_temp.expect_eq('the nurse reads learners'' health records',
  (select count(*) from student_health where student_id = current_setting('t.student')::uuid), 1);
select pg_temp.expect_rows('but doesn''t edit them (people does)',
  format($q$update student_health set notes = 'changed' where student_id = %L$q$, current_setting('t.student')), 0);
select pg_temp.expect_eq('and reads no fees', (select count(*) from fee_invoices), 0);

-- ---------------------------------------------------------------- a grant that no longer applies
reset role;
select pg_temp.act_as(current_setting('t.admin'));
update profiles set role = 'driver' where id = current_setting('t.bursar')::uuid;
reset role;
select pg_temp.act_as(current_setting('t.bursar'));
set local role authenticated;
select pg_temp.check('a grant stops counting once its holder is no longer a teacher or other staff',
  not has_perm(current_setting('t.a')::uuid, 'fees'));

-- ---------------------------------------------------------------- the principal takes areas away
reset role;
select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
select pg_temp.expect_ok('the principal takes the deputy''s areas away',
  format($q$select set_staff_areas(%L, array[]::text[])$q$, current_setting('t.deputy')));
select pg_temp.check('and that is in the audit trail too',
  exists (select 1 from audit_events where metadata->>'profile_id' = current_setting('t.deputy')
             and jsonb_array_length(metadata->'revoked') = 6));
reset role;
select pg_temp.act_as(current_setting('t.deputy'));
set local role authenticated;
select pg_temp.expect_rows('the deputy is a plain teacher again',
  format($q$update marks set score = 2 where exam_id = %L$q$, current_setting('t.exam')), 0);

-- ---------------------------------------------------------------- school roles
-- a role at the other school, made directly, for the cross-school check below
reset role;
with x as (
  insert into school_roles (tenant_id, name, areas) values (current_setting('t.b')::uuid, 'Check Other Role', array['fees']) returning id
) select set_config('t.role_b', x.id::text, true) from x;

select pg_temp.act_as(current_setting('t.nurse'));
set local role authenticated;
select pg_temp.expect_error('someone who isn''t a full admin can''t create a role',
  format($q$select save_school_role(null, %L, 'Check Sneaky', array['fees'])$q$, current_setting('t.a')), '42501');

reset role;
select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
select set_config('t.role', save_school_role(null, current_setting('t.a')::uuid, 'Check Exams officer', array['academics', 'attendance'])::text, true);
select pg_temp.check('the principal makes an Exams officer role', current_setting('t.role', true) <> '');
select pg_temp.expect_error('two roles can''t share a name',
  format($q$select save_school_role(null, %L, ' check exams OFFICER ', array['fees'])$q$, current_setting('t.a')), '23505');
select pg_temp.expect_error('a role holds only known areas',
  format($q$select save_school_role(null, %L, 'Check Settings', array['settings'])$q$, current_setting('t.a')), '22023');
select pg_temp.expect_ok('and gives it to the plain teacher',
  format($q$select set_staff_roles(%L, array[%L]::uuid[])$q$, current_setting('t.teacher'), current_setting('t.role')));
select pg_temp.expect_error('roles are for teachers and other staff, not parents',
  format($q$select set_staff_roles(%L, array[%L]::uuid[])$q$, current_setting('t.parent'), current_setting('t.role')), '22023');
select pg_temp.expect_error('nobody gives themselves a role',
  format($q$select set_staff_roles(%L, array[%L]::uuid[])$q$, current_setting('t.admin'), current_setting('t.role')), '42501');
select pg_temp.expect_error('only this school''s roles',
  format($q$select set_staff_roles(%L, array[%L]::uuid[])$q$, current_setting('t.teacher'), current_setting('t.role_b')), '22023');
select pg_temp.check('each role change is in the audit trail',
  exists (select 1 from audit_events where metadata->>'role_id' = current_setting('t.role'))
  and exists (select 1 from audit_events where metadata->>'profile_id' = current_setting('t.teacher') and metadata ? 'roles_granted'));

reset role;
select pg_temp.act_as(current_setting('t.teacher'));
set local role authenticated;
select pg_temp.check('the teacher now holds the role''s areas', my_admin_areas() = array['academics', 'attendance']);
select pg_temp.expect_rows('and edits marks in a class they don''t teach',
  format($q$update marks set score = 70 where exam_id = %L$q$, current_setting('t.exam')), 1);
select pg_temp.expect_error('a role holder can''t change the role',
  format($q$select save_school_role(%L, %L, 'Check Exams officer', array['academics', 'fees'])$q$, current_setting('t.role'), current_setting('t.a')), '42501');
select pg_temp.expect_error('or hand it to anyone',
  format($q$select set_staff_roles(%L, array[%L]::uuid[])$q$, current_setting('t.recep'), current_setting('t.role')), '42501');

reset role;
select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
select pg_temp.expect_ok('the principal takes academics out of the role',
  format($q$select save_school_role(%L, %L, 'Check Exams officer', array['attendance'])$q$, current_setting('t.role'), current_setting('t.a')));

reset role;
select pg_temp.act_as(current_setting('t.teacher'));
set local role authenticated;
select pg_temp.expect_rows('editing the role changes the holder''s access at once: no more marks',
  format($q$update marks set score = 71 where exam_id = %L$q$, current_setting('t.exam')), 0);
select pg_temp.check('but attendance is still theirs', has_perm(current_setting('t.a')::uuid, 'attendance'));

reset role;
select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
select pg_temp.expect_eq('deleting the role says how many people held it',
  (select delete_school_role(current_setting('t.role')::uuid)), 1);

reset role;
select pg_temp.act_as(current_setting('t.teacher'));
set local role authenticated;
select pg_temp.check('and takes its areas away from them', not has_perm(current_setting('t.a')::uuid, 'attendance'));

rollback;
