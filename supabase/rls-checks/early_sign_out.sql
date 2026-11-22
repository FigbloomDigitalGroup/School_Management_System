-- Early sign-out checks for 20261106000000_early_sign_out (FIG-1513, stage A): who may record, void and read a sign-out; that the
-- collector's ID number and phone are readable by few; that the record cannot be edited or written around the functions; the
-- audit event (without the ID number or phone); the learner delete guard; the same-school guard.
--
-- Runs against a local database that has the migrations applied, inside one transaction that is rolled back. It makes its own two
-- schools and people (no seed data needed). Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/early_sign_out.sql

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
-- Runs stmt as the database owner (no row-level security), answering 'ok' or the error's SQLSTATE.
create function pg_temp.as_owner(stmt text) returns text language plpgsql as $$
begin
  begin execute stmt; exception when others then return 'error ' || sqlstate; end;
  return 'ok';
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
-- record_early_sign_out as someone: the new id, or 'error <SQLSTATE>'. Defaults are a complete, valid sign-out.
create function pg_temp.rec(p_who text, p_student text, p_collector text default 'Jane Collector', p_phone text default '0712 345 678',
                            p_idnum text default '12345678', p_time time default null) returns text language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.act_as(current_setting('t.' || p_who));
  begin
    execute 'set local role authenticated';
    v := record_early_sign_out(current_setting('t.' || p_student)::uuid, 'Fever', 'Check Principal', p_collector, 'Aunt', p_idnum, p_phone, null, p_time);
    execute 'reset role';
  exception when others then
    execute 'reset role';
    return 'error ' || sqlstate;
  end;
  return v::text;
end $$;
create function pg_temp.rec_msg(p_who text, p_student text, p_time time default null) returns text language plpgsql as $$
declare v uuid;
begin
  perform pg_temp.act_as(current_setting('t.' || p_who));
  begin
    execute 'set local role authenticated';
    v := record_early_sign_out(current_setting('t.' || p_student)::uuid, 'Fever', 'Check Principal', 'Jane Collector', 'Aunt', '12345678', '0712 345 678', null, p_time);
    execute 'reset role';
  exception when others then
    execute 'reset role';
    return sqlstate || ' ' || sqlerrm;
  end;
  return 'ok';
end $$;
create function pg_temp.void(p_who text, p_id text, p_reason text) returns text language plpgsql as $$
begin
  perform pg_temp.act_as(current_setting('t.' || p_who));
  begin
    execute 'set local role authenticated';
    perform void_early_sign_out(p_id::uuid, p_reason);
    execute 'reset role';
  exception when others then
    execute 'reset role';
    return 'error ' || sqlstate;
  end;
  return 'ok';
end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- fixtures (as postgres)
create function pg_temp.person(p_key text, p_tenant uuid, p_role app_role, p_name text) returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v, 'signout-check-' || p_key || '-' || v || '@example.invalid');
  insert into profiles (id, tenant_id, role, full_name) values (v, p_tenant, p_role, p_name);
  perform set_config('t.' || p_key, v::text, true);
  return v;
end $$;
create function pg_temp.learner(p_key text, p_adm text, p_class text) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into students (tenant_id, admission_no, full_name, class_id)
  values (current_setting('t.a')::uuid, p_adm, 'Check Learner ' || p_key, current_setting('t.' || p_class)::uuid) returning id into v;
  perform set_config('t.' || p_key, v::text, true);
  return v;
end $$;

with x as (
  insert into tenants (name, slug, county) values ('Sign-out Check School', 'signout-check-a-' || substr(md5(random()::text), 1, 8), 'Nairobi') returning id
) select set_config('t.a', x.id::text, true) from x;
with x as (
  insert into tenants (name, slug, county) values ('Sign-out Check Other School', 'signout-check-b-' || substr(md5(random()::text), 1, 8), 'Nairobi') returning id
) select set_config('t.b', x.id::text, true) from x;

select pg_temp.person('admin',    current_setting('t.a')::uuid, 'school_admin', 'Check Principal');
select pg_temp.person('clerk',    current_setting('t.a')::uuid, 'staff',        'Check Attendance Clerk');
select pg_temp.person('gate',     current_setting('t.a')::uuid, 'staff',        'Check Gate');
select pg_temp.person('nurse',    current_setting('t.a')::uuid, 'staff',        'Check Nurse');
select pg_temp.person('ct',       current_setting('t.a')::uuid, 'teacher',      'Check Class Teacher');
select pg_temp.person('other_t',  current_setting('t.a')::uuid, 'teacher',      'Check Other Teacher');
select pg_temp.person('mum',      current_setting('t.a')::uuid, 'parent',       'Check Mum');
select pg_temp.person('other_p',  current_setting('t.a')::uuid, 'parent',       'Check Other Parent');
select pg_temp.person('away',     current_setting('t.b')::uuid, 'parent',       'Check Other-School Parent');
select pg_temp.person('kid',      current_setting('t.a')::uuid, 'student',      'Check Learner Login');
select pg_temp.person('admin_b',  current_setting('t.b')::uuid, 'school_admin', 'Check Other Principal');
insert into staff_permissions (tenant_id, profile_id, area) values
  (current_setting('t.a')::uuid, current_setting('t.clerk')::uuid, 'attendance'),
  (current_setting('t.a')::uuid, current_setting('t.gate')::uuid, 'visitors'),
  (current_setting('t.a')::uuid, current_setting('t.nurse')::uuid, 'medical');

with x as (
  insert into classes (tenant_id, name, form_level, class_teacher_id)
  values (current_setting('t.a')::uuid, 'Sign-out Check 3 North', 3, current_setting('t.ct')::uuid) returning id
) select set_config('t.class', x.id::text, true) from x;
with x as (
  insert into classes (tenant_id, name, form_level) values (current_setting('t.a')::uuid, 'Sign-out Check 3 South', 3) returning id
) select set_config('t.class2', x.id::text, true) from x;

select pg_temp.learner('l_admin', 'SOC-1', 'class');
select pg_temp.learner('l_clerk', 'SOC-2', 'class');
select pg_temp.learner('l_ct',    'SOC-3', 'class');
select pg_temp.learner('l_deny',  'SOC-4', 'class');
select pg_temp.learner('l_other', 'SOC-5', 'class2');   -- in a class whose teacher is nobody we made
select pg_temp.learner('l_bad',   'SOC-6', 'class');
select pg_temp.learner('l_old',   'SOC-7', 'class');
select pg_temp.learner('l_multi', 'SOC-8', 'class');
insert into guardians (tenant_id, profile_id, student_id) values
  (current_setting('t.a')::uuid, current_setting('t.mum')::uuid, current_setting('t.l_ct')::uuid),
  (current_setting('t.a')::uuid, current_setting('t.other_p')::uuid, current_setting('t.l_deny')::uuid);
update students set active = false where id = current_setting('t.l_old')::uuid;
-- the learner's own login is linked to l_ct: the learner is not meant to read the sign-out record
update students set profile_id = current_setting('t.kid')::uuid where id = current_setting('t.l_ct')::uuid;

-- ---------------------------------------------------------------- who may record
select pg_temp.expect_eq('a teacher who is not the class teacher is refused', pg_temp.rec('other_t', 'l_deny'), 'error 42501');
select pg_temp.expect_eq('the gate (visitors area) is refused: it may read the list, not record', pg_temp.rec('gate', 'l_deny'), 'error 42501');
select pg_temp.expect_eq('the nurse (medical area) is refused', pg_temp.rec('nurse', 'l_deny'), 'error 42501');
select pg_temp.expect_eq('a parent is refused, even for their own child', pg_temp.rec('mum', 'l_ct'), 'error 42501');
select pg_temp.expect_eq('a parent at another school is refused', pg_temp.rec('away', 'l_deny'), 'error 42501');
select pg_temp.expect_eq('another school''s principal is refused', pg_temp.rec('admin_b', 'l_deny'), 'error 42501');
select pg_temp.expect_eq('the class teacher of another class is refused', pg_temp.rec('ct', 'l_other'), 'error 42501');
select pg_temp.expect_eq('nothing was recorded by the refusals',
  (select count(*)::text from early_sign_outs where tenant_id = current_setting('t.a')::uuid), '0');

select set_config('t.so_admin', pg_temp.rec('admin', 'l_admin'), true);
select set_config('t.so_clerk', pg_temp.rec('clerk', 'l_clerk'), true);
select set_config('t.so_ct',    pg_temp.rec('ct', 'l_ct'), true);
select pg_temp.check('the school admin can record', current_setting('t.so_admin') !~ '^error');
select pg_temp.check('the attendance area can record', current_setting('t.so_clerk') !~ '^error');
select pg_temp.check('the class teacher can record their own class', current_setting('t.so_ct') !~ '^error');

-- ---------------------------------------------------------------- what is stored
select pg_temp.check('the record carries who, which class and the school day',
  (select recorded_by = current_setting('t.ct')::uuid and class_id = current_setting('t.class')::uuid
          and taken_on = school_today(current_setting('t.a')::uuid)
          and student_name = 'Check Learner l_ct' and class_name = 'Sign-out Check 3 North'
     from early_sign_outs where id = current_setting('t.so_ct')::uuid));
select pg_temp.check('the time shown is the school''s clock at the moment it was recorded',
  (select signed_out_local = date_trunc('second', signed_out_at at time zone coalesce((select timezone from tenants where id = tenant_id), 'Africa/Nairobi'))::time(0)
     from early_sign_outs where id = current_setting('t.so_ct')::uuid));
select pg_temp.check('the collector''s ID number and phone are kept in their own table',
  (select id_number = '12345678' and phone = '0712 345 678' from early_sign_out_collectors where sign_out_id = current_setting('t.so_ct')::uuid));

-- ---------------------------------------------------------------- the rules
select pg_temp.expect_eq('the same learner again within five minutes is refused as a double click', pg_temp.rec('admin', 'l_admin'), 'error 23505');
select pg_temp.check('the refusal says it is the five-minute rule, names the time of the existing sign-out, and says what to do',
  (select m like '23505 Check Learner l_admin already has a sign-out recorded at __:__, within five minutes of this time.%'
      and m like '%left, came back and left again, enter a time at least five minutes apart.'
      and m not like '%moment ago%'
      and substr(m, position(' at ' in m) + 4, 5) = (select to_char(signed_out_local, 'HH24:MI') from early_sign_outs where id = current_setting('t.so_admin')::uuid)
   from (select pg_temp.rec_msg('admin', 'l_admin') as m) q));
select pg_temp.expect_eq('the refusal leaves no second live record behind',
  (select count(*)::text from early_sign_outs where student_id = current_setting('t.l_admin')::uuid and voided_at is null), '1');
do $$
declare v_local time := (now() at time zone coalesce((select timezone from tenants where id = current_setting('t.a')::uuid), 'Africa/Nairobi'))::time;
begin
  if v_local < time '00:30' then
    raise notice 'INFO the "several a day" check was skipped: too close to midnight at the school';
  else
    perform pg_temp.check('a learner can leave, return and leave again: a second sign-out 30 minutes apart is accepted',
      pg_temp.rec('admin', 'l_multi', p_time => (v_local - interval '30 minutes')::time) !~ '^error'
      and pg_temp.rec('admin', 'l_multi') !~ '^error');
    perform pg_temp.expect_eq('both departures are kept as live records',
      (select count(*)::text from early_sign_outs where student_id = current_setting('t.l_multi')::uuid and voided_at is null), '2');
    perform pg_temp.expect_eq('a double click on the second one is still refused', pg_temp.rec('admin', 'l_multi'), 'error 23505');
  end if;
end $$;
select pg_temp.expect_eq('an archived learner is refused', pg_temp.rec('admin', 'l_old'), 'error 23514');
select pg_temp.expect_eq('a collector with no name is refused', pg_temp.rec('admin', 'l_bad', p_collector => '  '), 'error 23514');
select pg_temp.expect_eq('a collector phone that is not a phone number is refused', pg_temp.rec('admin', 'l_bad', p_phone => 'call me'), 'error 23514');
select pg_temp.expect_eq('an ID number that is too short is refused', pg_temp.rec('admin', 'l_bad', p_idnum => '12'), 'error 23514');
do $$
declare v_local time := (now() at time zone coalesce((select timezone from tenants where id = current_setting('t.a')::uuid), 'Africa/Nairobi'))::time;
begin
  if v_local > time '23:50' then
    raise notice 'INFO the "future time" check was skipped: too close to midnight at the school';
  else
    perform pg_temp.expect_eq('a time later than now is refused', pg_temp.rec('admin', 'l_bad', p_time => (v_local + interval '10 minutes')::time), 'error 23514');
  end if;
  if v_local < time '00:10' then
    raise notice 'INFO the "earlier time" check was skipped: too close to midnight at the school';
  else
    perform set_config('t.so_early', pg_temp.rec('admin', 'l_bad', p_time => time '00:05'), true);
    perform pg_temp.expect_eq('an earlier time today is kept as given on the school''s clock',
      (select signed_out_local::text from early_sign_outs where id::text = current_setting('t.so_early')), '00:05:00');
  end if;
end $$;

-- ---------------------------------------------------------------- who reads the sign-out
select pg_temp.expect_eq('mum reads her child''s sign-out',
  pg_temp.sees('mum', format('select count(*) from early_sign_outs where id = %L', current_setting('t.so_ct')))::text, '1');
select pg_temp.expect_eq('another child''s parent reads nothing of it',
  pg_temp.sees('other_p', format('select count(*) from early_sign_outs where id = %L', current_setting('t.so_ct')))::text, '0');
select pg_temp.expect_eq('the learner does not read the record, even their own',
  pg_temp.sees('kid', 'select count(*) from early_sign_outs')::text, '0');
select pg_temp.check('the main record has no authorised-by or note column: those are in the restricted table',
  not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'early_sign_outs' and column_name in ('authorised_by', 'note'))
  and (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'early_sign_out_collectors' and column_name in ('authorised_by', 'note', 'id_number', 'phone')) = 4);
select pg_temp.expect_eq('a parent at another school reads nothing',
  pg_temp.sees('away', 'select count(*) from early_sign_outs')::text, '0');
select pg_temp.expect_eq('the class teacher reads the sign-out they recorded',
  pg_temp.sees('ct', format('select count(*) from early_sign_outs where id = %L', current_setting('t.so_ct')))::text, '1');
select pg_temp.expect_eq('and one of their class''s learners that the attendance clerk recorded',
  pg_temp.sees('ct', format('select count(*) from early_sign_outs where id = %L', current_setting('t.so_clerk')))::text, '1');
select pg_temp.expect_eq('the attendance area reads the day''s list',
  pg_temp.sees('clerk', 'select count(*) from early_sign_outs')::text, (select count(*)::text from early_sign_outs where tenant_id = current_setting('t.a')::uuid));
select pg_temp.expect_eq('the gate (visitors area) reads the day''s list',
  pg_temp.sees('gate', 'select count(*) from early_sign_outs')::text, (select count(*)::text from early_sign_outs where tenant_id = current_setting('t.a')::uuid));
select pg_temp.expect_eq('a teacher who is not the class teacher reads nothing',
  pg_temp.sees('other_t', format('select count(*) from early_sign_outs where id = %L', current_setting('t.so_ct')))::text, '0');
select pg_temp.expect_eq('the nurse reads nothing',
  pg_temp.sees('nurse', 'select count(*) from early_sign_outs')::text, '0');

-- ---------------------------------------------------------------- who reads the collector's ID number and phone
select pg_temp.expect_eq('the attendance area reads the collector details',
  pg_temp.sees('clerk', 'select count(*) from early_sign_out_collectors')::text, (select count(*)::text from early_sign_out_collectors where tenant_id = current_setting('t.a')::uuid));
select pg_temp.expect_eq('the school admin reads the collector details',
  pg_temp.sees('admin', 'select count(*) from early_sign_out_collectors')::text, (select count(*)::text from early_sign_out_collectors where tenant_id = current_setting('t.a')::uuid));
select pg_temp.expect_eq('the class teacher who recorded one reads that one''s details only',
  pg_temp.sees('ct', 'select count(*) from early_sign_out_collectors')::text, '1');
select pg_temp.expect_eq('the attendance area reads who authorised each sign-out',
  pg_temp.sees('clerk', 'select count(*) from early_sign_out_collectors where authorised_by = ''Check Principal''')::text,
  (select count(*)::text from early_sign_out_collectors where tenant_id = current_setting('t.a')::uuid and authorised_by = 'Check Principal'));
select pg_temp.expect_eq('the class teacher and the parent cannot read who authorised it, nor the note',
  (pg_temp.sees('mum', 'select count(*) from early_sign_out_collectors where authorised_by is not null')
   + pg_temp.sees('other_t', 'select count(*) from early_sign_out_collectors where authorised_by is not null'))::text, '0');
select pg_temp.expect_eq('the parent does not read the collector''s ID number or phone',
  pg_temp.sees('mum', 'select count(*) from early_sign_out_collectors')::text, '0');
select pg_temp.expect_eq('the gate does not read them either',
  pg_temp.sees('gate', 'select count(*) from early_sign_out_collectors')::text, '0');
select pg_temp.expect_eq('nor another teacher',
  pg_temp.sees('other_t', 'select count(*) from early_sign_out_collectors')::text, '0');

-- ---------------------------------------------------------------- no way round the functions
select pg_temp.expect_eq('a direct insert is refused, even for the principal',
  pg_temp.as_user('admin', format($q$insert into early_sign_outs (tenant_id, student_id, student_name, taken_on, signed_out_at, signed_out_local, reason, collected_by_name, collected_by_relationship)
    values (%L, %L, 'x', current_date, now(), now()::time, 'x', 'x', 'x')$q$, current_setting('t.a'), current_setting('t.l_deny'))), 'error 42501');
select pg_temp.as_user('admin', format($q$update early_sign_outs set reason = 'changed' where id = %L$q$, current_setting('t.so_ct')));
select pg_temp.expect_eq('a direct update by the principal changes nothing',
  (select reason from early_sign_outs where id = current_setting('t.so_ct')::uuid), 'Fever');
select pg_temp.as_user('admin', format($q$delete from early_sign_outs where id = %L$q$, current_setting('t.so_ct')));
select pg_temp.expect_eq('a direct delete removes nothing',
  (select count(*)::text from early_sign_outs where id = current_setting('t.so_ct')::uuid), '1');
select pg_temp.expect_eq('even the database owner cannot edit the restricted details',
  pg_temp.as_owner(format($q$update early_sign_out_collectors set authorised_by = 'Someone Else' where sign_out_id = %L$q$, current_setting('t.so_ct'))), 'error 42501');
select pg_temp.expect_eq('even the database owner cannot edit what was recorded',
  pg_temp.as_owner(format($q$update early_sign_outs set collected_by_name = 'Someone Else' where id = %L$q$, current_setting('t.so_ct'))), 'error 42501');

-- ---------------------------------------------------------------- void
select pg_temp.expect_eq('a teacher who did not record it cannot void it', pg_temp.void('other_t', current_setting('t.so_ct'), 'Wrong learner'), 'error 42501');
select pg_temp.expect_eq('the gate cannot void', pg_temp.void('gate', current_setting('t.so_ct'), 'Wrong learner'), 'error 42501');
select pg_temp.expect_eq('a void needs a reason', pg_temp.void('ct', current_setting('t.so_ct'), '  '), 'error 23514');
select pg_temp.expect_eq('whoever recorded it can void it', pg_temp.void('ct', current_setting('t.so_ct'), 'Wrong learner'), 'ok');
select pg_temp.expect_eq('it cannot be voided twice', pg_temp.void('ct', current_setting('t.so_ct'), 'Wrong learner'), 'error 23514');
select pg_temp.check('a voided sign-out stays on record; its reason is in the restricted table',
  (select e.voided_at is not null and c.void_reason = 'Wrong learner' and e.voided_by = current_setting('t.ct')::uuid
     from early_sign_outs e join early_sign_out_collectors c on c.sign_out_id = e.id where e.id = current_setting('t.so_ct')::uuid));
select pg_temp.check('the void reason is not a column of the main record, which the family and the class teacher can read',
  not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'early_sign_outs' and column_name = 'void_reason')
  and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'early_sign_out_collectors' and column_name = 'void_reason'));
select pg_temp.expect_eq('the parent cannot read the void reason',
  pg_temp.sees('mum', 'select count(*) from early_sign_out_collectors where void_reason is not null')::text, '0');
select pg_temp.expect_eq('a voided sign-out cannot be changed back',
  pg_temp.as_owner(format($q$update early_sign_outs set voided_at = null where id = %L$q$, current_setting('t.so_ct'))), 'error 42501');
select pg_temp.expect_eq('the void reason is final once set',
  pg_temp.as_owner(format($q$update early_sign_out_collectors set void_reason = 'changed my mind' where sign_out_id = %L$q$, current_setting('t.so_ct'))), 'error 42501');
select pg_temp.expect_eq('the attendance area can void one it did not record', pg_temp.void('clerk', current_setting('t.so_admin'), 'Collected by the other parent'), 'ok');
select pg_temp.check('after a void the right sign-out can be recorded for the same learner and day',
  pg_temp.rec('ct', 'l_ct') !~ '^error');
-- a voided record never blocks: l_admin's only live sign-out was voided just above, seconds ago, well inside the five minutes
select pg_temp.expect_eq('after a void, a new sign-out is recorded at once for the same learner (the voided one does not count)',
  (select count(*)::text from early_sign_outs where student_id = current_setting('t.l_admin')::uuid and voided_at is null), '0');
select pg_temp.check('the new sign-out for that learner is accepted within five minutes of the voided one',
  pg_temp.rec('admin', 'l_admin') !~ '^error');
select pg_temp.expect_eq('the voided record is kept and the new one is the only live record',
  (select count(*) filter (where voided_at is null)::text || '/' || count(*)::text from early_sign_outs where student_id = current_setting('t.l_admin')::uuid), '1/2');
select pg_temp.check('and now a double click on the new one is refused again',
  pg_temp.rec_msg('admin', 'l_admin') like '23505 %within five minutes of this time.%');

-- ---------------------------------------------------------------- audit
select pg_temp.check('recording is in the audit trail, as an operations event',
  exists (select 1 from audit_events where tenant_id = current_setting('t.a')::uuid and category = 'operations'
            and event like 'Check Learner l_ct signed out early at %, collected by Jane Collector (Aunt)'));
select pg_temp.check('so is the void, but the audit event does not carry the free-text void reason',
  exists (select 1 from audit_events where tenant_id = current_setting('t.a')::uuid and event = 'Early sign-out of Check Learner l_ct voided')
  and not exists (select 1 from audit_events where tenant_id = current_setting('t.a')::uuid and event like 'Early sign-out of % voided%'
                    and (event || metadata::text) like '%Wrong learner%'));
select pg_temp.check('the recording event leaves out the free-text reason and who authorised it',
  not exists (select 1 from audit_events where tenant_id = current_setting('t.a')::uuid and event like '% signed out early at %'
                and (metadata ? 'reason' or metadata ? 'authorised_by' or metadata ? 'note')));
select pg_temp.check('no audit event carries a collector ID number or phone',
  not exists (select 1 from audit_events where tenant_id = current_setting('t.a')::uuid
                and (event || metadata::text) ~ '(12345678|0712 345 678)'));

-- ---------------------------------------------------------------- guards
do $$
declare v_msg text;
begin
  begin
    delete from students where id = current_setting('t.l_clerk')::uuid;
    v_msg := 'deleted';
  exception when others then v_msg := sqlstate || ' ' || sqlerrm;
  end;
  perform pg_temp.check('a learner with a sign-out cannot be deleted, only archived (the delete guard finds the table by itself)',
    v_msg like '23001%' and v_msg like '%early sign outs%');
end $$;
select pg_temp.expect_eq('a sign-out cannot point at a learner of another school',
  pg_temp.as_owner(format($q$insert into early_sign_outs (tenant_id, student_id, student_name, taken_on, signed_out_at, signed_out_local, reason, collected_by_name, collected_by_relationship)
    values (%L, %L, 'x', current_date, now(), now()::time, 'x', 'x', 'x')$q$, current_setting('t.b'), current_setting('t.l_deny'))), 'error 42501');
select pg_temp.check('registers are untouched: no attendance row was written by any sign-out',
  not exists (select 1 from attendance where tenant_id = current_setting('t.a')::uuid));

rollback;
