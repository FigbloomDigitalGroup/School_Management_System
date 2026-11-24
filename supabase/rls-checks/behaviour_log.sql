-- Behaviour log checks for 20261124400000_behaviour_log.
--
-- Runs against a local database that has the migrations applied, inside one transaction that is rolled back.
-- It makes its own schools, people and entries, so it needs no seed. Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/behaviour_log.sql
--
-- What it shows: a class teacher and a subject teacher (through a teaching assignment) record for and read the
-- learners they teach and no one else; the 'discipline' area and full admins see the whole school and change the
-- settings; a teacher can't; a guardian and the learner see merits always, demerits and incidents only as the
-- school's settings allow, never voided entries, never staff-only notes; another school sees nothing; entries are
-- never updated or deleted (void and incident record go through their functions); and behaviour_points counts all
-- three modes, the starting balance and the term / year / never resets, refusing learners the caller may not see.

\set ON_ERROR_STOP 1
begin;

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when coalesce(ok, false) then 'PASS' else 'FAIL' end, label; end $$;
create function pg_temp.person(p_id uuid, p_tenant uuid, p_role app_role, p_name text) returns void
language sql as $$
  insert into auth.users (id, email) values (p_id, p_id::text || '@login.behaviourcheck.figbloom.internal');
  insert into profiles (id, tenant_id, role, full_name) values (p_id, p_tenant, p_role, p_name);
$$;
create function pg_temp.as_user(uid uuid, stmt text) returns text language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    execute stmt;
    get diagnostics n = row_count;
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    return 'error ' || sqlstate;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return 'ok ' || n;
end $$;
create function pg_temp.count_as(uid uuid, q text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute 'select count(*) from (' || q || ') x' into n;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return n;
end $$;
create function pg_temp.int_as(uid uuid, q text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute q into n;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return n;
end $$;
-- runs a statement as this person and keeps the outcome, for a check that then reads what it wrote
-- (a check's own subqueries may run before a call in the same statement)
create temp table last_run (v text);
create function pg_temp.run(uid uuid, stmt text) returns void language sql as $$
  delete from last_run; insert into last_run select pg_temp.as_user(uid, stmt);
$$;
create function pg_temp.last() returns text language sql as $$ select v from last_run $$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- fixtures
-- ids: school A ...b101, school B ...b102; people ...b2xx; classes ...b3xx; learners ...b4xx; categories ...b5xx
insert into tenants (id, name, slug, county) values
  ('00000000-0000-4000-8000-00000000b101', 'Behaviour Check School', 'bhcheck-a-' || substr(md5(random()::text), 1, 8), 'Nairobi'),
  ('00000000-0000-4000-8000-00000000b102', 'Behaviour Check Other', 'bhcheck-b-' || substr(md5(random()::text), 1, 8), 'Nairobi');

select pg_temp.person('00000000-0000-4000-8000-00000000b201', '00000000-0000-4000-8000-00000000b101', 'school_admin', 'BH Principal');
select pg_temp.person('00000000-0000-4000-8000-00000000b202', '00000000-0000-4000-8000-00000000b101', 'teacher', 'BH Class Teacher');
select pg_temp.person('00000000-0000-4000-8000-00000000b203', '00000000-0000-4000-8000-00000000b101', 'teacher', 'BH Subject Teacher');
select pg_temp.person('00000000-0000-4000-8000-00000000b204', '00000000-0000-4000-8000-00000000b101', 'teacher', 'BH Other Teacher');
select pg_temp.person('00000000-0000-4000-8000-00000000b205', '00000000-0000-4000-8000-00000000b101', 'teacher', 'BH Discipline Master');
select pg_temp.person('00000000-0000-4000-8000-00000000b206', '00000000-0000-4000-8000-00000000b101', 'staff', 'BH Bursar');
select pg_temp.person('00000000-0000-4000-8000-00000000b207', '00000000-0000-4000-8000-00000000b101', 'parent', 'BH Parent');
select pg_temp.person('00000000-0000-4000-8000-00000000b208', '00000000-0000-4000-8000-00000000b101', 'student', 'BH Learner One');
select pg_temp.person('00000000-0000-4000-8000-00000000b209', '00000000-0000-4000-8000-00000000b102', 'school_admin', 'BH Other Principal');
select pg_temp.person('00000000-0000-4000-8000-00000000b210', '00000000-0000-4000-8000-00000000b101', 'parent', 'BH Other Parent');
insert into staff_permissions (tenant_id, profile_id, area) values
  ('00000000-0000-4000-8000-00000000b101', '00000000-0000-4000-8000-00000000b205', 'discipline'),
  ('00000000-0000-4000-8000-00000000b101', '00000000-0000-4000-8000-00000000b206', 'fees');

insert into classes (id, tenant_id, name, form_level, class_teacher_id) values
  ('00000000-0000-4000-8000-00000000b301', '00000000-0000-4000-8000-00000000b101', 'BH 1', 1, '00000000-0000-4000-8000-00000000b202'),
  ('00000000-0000-4000-8000-00000000b302', '00000000-0000-4000-8000-00000000b101', 'BH 2', 2, null),
  ('00000000-0000-4000-8000-00000000b303', '00000000-0000-4000-8000-00000000b101', 'BH 3', 3, null),
  ('00000000-0000-4000-8000-00000000b304', '00000000-0000-4000-8000-00000000b102', 'Other 1', 1, null);
insert into subjects (id, tenant_id, name, code) values
  ('00000000-0000-4000-8000-00000000b601', '00000000-0000-4000-8000-00000000b101', 'BH Maths', 'BHM');
-- the subject teacher teaches BH 2 (not BH 1, not BH 3)
insert into teaching_assignments (tenant_id, teacher_id, class_id, subject_id) values
  ('00000000-0000-4000-8000-00000000b101', '00000000-0000-4000-8000-00000000b203', '00000000-0000-4000-8000-00000000b302', '00000000-0000-4000-8000-00000000b601');

insert into students (id, tenant_id, admission_no, full_name, class_id, profile_id) values
  ('00000000-0000-4000-8000-00000000b401', '00000000-0000-4000-8000-00000000b101', 'BH1', 'BH Learner One', '00000000-0000-4000-8000-00000000b301', '00000000-0000-4000-8000-00000000b208'),
  ('00000000-0000-4000-8000-00000000b402', '00000000-0000-4000-8000-00000000b101', 'BH2', 'BH Learner Two', '00000000-0000-4000-8000-00000000b302', null),
  ('00000000-0000-4000-8000-00000000b403', '00000000-0000-4000-8000-00000000b101', 'BH3', 'BH Learner Three', '00000000-0000-4000-8000-00000000b303', null),
  ('00000000-0000-4000-8000-00000000b404', '00000000-0000-4000-8000-00000000b102', 'OT1', 'Other Learner', '00000000-0000-4000-8000-00000000b304', null);
insert into guardians (tenant_id, profile_id, student_id) values
  ('00000000-0000-4000-8000-00000000b101', '00000000-0000-4000-8000-00000000b207', '00000000-0000-4000-8000-00000000b401');

-- terms: 2025 T3, 2026 T1..T3 for school A
insert into terms (tenant_id, name, year, index, starts_on, ends_on) values
  ('00000000-0000-4000-8000-00000000b101', 'T3 2025', 2025, 3, '2025-09-01', '2025-11-28'),
  ('00000000-0000-4000-8000-00000000b101', 'T1 2026', 2026, 1, '2026-01-05', '2026-03-27'),
  ('00000000-0000-4000-8000-00000000b101', 'T2 2026', 2026, 2, '2026-05-04', '2026-08-01'),
  ('00000000-0000-4000-8000-00000000b101', 'T3 2026', 2026, 3, '2026-08-31', '2026-11-27');

-- ---------------------------------------------------------------- the area
select pg_temp.check('discipline is an admin area', is_admin_area('discipline'));
select pg_temp.check('set_staff_areas can give discipline',
  pg_temp.as_user('00000000-0000-4000-8000-00000000b201',
    $$select set_staff_areas('00000000-0000-4000-8000-00000000b204', array['discipline'])$$) = 'ok 1');
select pg_temp.check('... and take it away again',
  pg_temp.as_user('00000000-0000-4000-8000-00000000b201',
    $$select set_staff_areas('00000000-0000-4000-8000-00000000b204', array[]::text[])$$) = 'ok 1');

-- ---------------------------------------------------------------- settings and categories
select pg_temp.check('a teacher cannot change the settings',
  pg_temp.as_user('00000000-0000-4000-8000-00000000b202',
    $$insert into behaviour_settings (tenant_id) values ('00000000-0000-4000-8000-00000000b101')$$) like 'error%');
select pg_temp.check('the discipline area saves the settings',
  pg_temp.as_user('00000000-0000-4000-8000-00000000b205',
    $$insert into behaviour_settings (tenant_id, mode, reset) values ('00000000-0000-4000-8000-00000000b101', 'both', 'term')$$) = 'ok 1');
select pg_temp.check('the bursar (fees only) cannot',
  pg_temp.as_user('00000000-0000-4000-8000-00000000b206',
    $$update behaviour_settings set mode = 'merits_only' where tenant_id = '00000000-0000-4000-8000-00000000b101'$$) = 'ok 0');
select pg_temp.check('bad thresholds are refused',
  pg_temp.as_user('00000000-0000-4000-8000-00000000b205',
    $$update behaviour_settings set thresholds = '[{"points": 0, "label": "x"}]' where tenant_id = '00000000-0000-4000-8000-00000000b101'$$) like 'error%');
select pg_temp.check('the default categories are added once (14)',
  pg_temp.int_as('00000000-0000-4000-8000-00000000b205', $$select add_default_behaviour_categories('00000000-0000-4000-8000-00000000b101')$$) = 14
  and pg_temp.int_as('00000000-0000-4000-8000-00000000b205', $$select add_default_behaviour_categories('00000000-0000-4000-8000-00000000b101')$$) = 0);
select pg_temp.check('a teacher cannot add categories',
  pg_temp.as_user('00000000-0000-4000-8000-00000000b202', $$select add_default_behaviour_categories('00000000-0000-4000-8000-00000000b101')$$) like 'error%');
select pg_temp.check('a parent reads the categories (names on entries)',
  pg_temp.count_as('00000000-0000-4000-8000-00000000b207', $$select 1 from behaviour_categories$$) = 14);
select pg_temp.check('another school reads none of them',
  pg_temp.count_as('00000000-0000-4000-8000-00000000b209', $$select 1 from behaviour_categories$$) = 0);
select pg_temp.check('categories are never deleted',
  pg_temp.as_user('00000000-0000-4000-8000-00000000b201', $$delete from behaviour_categories$$) = 'ok 0'
  and (select count(*) from behaviour_categories where tenant_id = '00000000-0000-4000-8000-00000000b101') = 14);

-- ---------------------------------------------------------------- recording
create temp table cat as
  select name, id from behaviour_categories where tenant_id = '00000000-0000-4000-8000-00000000b101';
grant select on cat to authenticated;

select pg_temp.check('the class teacher records a merit for their learner',
  pg_temp.as_user('00000000-0000-4000-8000-00000000b202', format(
    $$select record_behaviour(array['00000000-0000-4000-8000-00000000b401']::uuid[], 'merit', %L, null, 'Helped a new learner', 'Quiet lately at home')$$,
    (select id from cat where name = 'Helping others'))) = 'ok 1');
select pg_temp.check('... signed +2 from the category, class and recorder filled in',
  (select points = 2 and class_id = '00000000-0000-4000-8000-00000000b301' and recorded_by = '00000000-0000-4000-8000-00000000b202'
     from behaviour_entries where student_id = '00000000-0000-4000-8000-00000000b401'));
select pg_temp.check('the class teacher cannot record for a learner they do not teach',
  pg_temp.as_user('00000000-0000-4000-8000-00000000b202', format(
    $$select record_behaviour(array['00000000-0000-4000-8000-00000000b402']::uuid[], 'merit', %L)$$,
    (select id from cat where name = 'Leadership'))) like 'error%');
select pg_temp.check('the subject teacher records a demerit through the teaching assignment',
  pg_temp.as_user('00000000-0000-4000-8000-00000000b203', format(
    $$select record_behaviour(array['00000000-0000-4000-8000-00000000b402']::uuid[], 'demerit', %L, 2, 'Talking in class', null, null, '00000000-0000-4000-8000-00000000b601')$$,
    (select id from cat where name = 'Disrupting class'))) = 'ok 1');
select pg_temp.check('a teacher with no tie to the learner cannot',
  pg_temp.as_user('00000000-0000-4000-8000-00000000b204', format(
    $$select record_behaviour(array['00000000-0000-4000-8000-00000000b403']::uuid[], 'merit', %L)$$,
    (select id from cat where name = 'Leadership'))) like 'error%');
select pg_temp.check('a direct insert for an untaught learner is refused too',
  pg_temp.as_user('00000000-0000-4000-8000-00000000b204', format(
    $$insert into behaviour_entries (tenant_id, student_id, category_id, kind, points) values ('00000000-0000-4000-8000-00000000b101', '00000000-0000-4000-8000-00000000b403', %L, 'merit', 2)$$,
    (select id from cat where name = 'Leadership'))) like 'error%');
select pg_temp.check('points over the school limit are refused',
  pg_temp.as_user('00000000-0000-4000-8000-00000000b202', format(
    $$select record_behaviour(array['00000000-0000-4000-8000-00000000b401']::uuid[], 'merit', %L, 11)$$,
    (select id from cat where name = 'Leadership'))) like 'error%');
select pg_temp.check('a merit category cannot be recorded as a demerit',
  pg_temp.as_user('00000000-0000-4000-8000-00000000b202', format(
    $$select record_behaviour(array['00000000-0000-4000-8000-00000000b401']::uuid[], 'demerit', %L)$$,
    (select id from cat where name = 'Leadership'))) like 'error%');
select pg_temp.check('a future date is refused',
  pg_temp.as_user('00000000-0000-4000-8000-00000000b202', format(
    $$select record_behaviour(array['00000000-0000-4000-8000-00000000b401']::uuid[], 'merit', %L, null, null, null, current_date + 3)$$,
    (select id from cat where name = 'Leadership'))) like 'error%');
select pg_temp.run('00000000-0000-4000-8000-00000000b205', format(
    $$select record_behaviour(array['00000000-0000-4000-8000-00000000b401', '00000000-0000-4000-8000-00000000b402', '00000000-0000-4000-8000-00000000b403']::uuid[], 'merit', %L, 1)$$,
    (select id from cat where name = 'Clean classroom duty')));
select pg_temp.check('the discipline master records for any learner, several at once (class merit)',
  pg_temp.last() = 'ok 1'
  and (select count(*) from behaviour_entries where category_id = (select id from cat where name = 'Clean classroom duty')) = 3);
select pg_temp.check('another school''s admin cannot record for this school''s learner',
  pg_temp.as_user('00000000-0000-4000-8000-00000000b209', format(
    $$insert into behaviour_entries (tenant_id, student_id, category_id, kind, points) values ('00000000-0000-4000-8000-00000000b101', '00000000-0000-4000-8000-00000000b401', %L, 'merit', 2)$$,
    (select id from cat where name = 'Leadership'))) like 'error%');

-- a serious one by the subject teacher for learner one? not taught: the discipline master records it
select pg_temp.run('00000000-0000-4000-8000-00000000b205', format(
    $$select record_behaviour(array['00000000-0000-4000-8000-00000000b401']::uuid[], 'demerit', %L, null, 'Fight at break', 'Other boy started it per witnesses')$$,
    (select id from cat where name = 'Fighting')));
select pg_temp.check('a serious demerit opens a follow-up and tells the class teacher (in-app)',
  pg_temp.last() = 'ok 1'
  and (select follow_up_status = 'open' and severity = 'serious' and points = -5 from behaviour_entries
        where category_id = (select id from cat where name = 'Fighting'))
  and exists (select 1 from announcements where audience ->> 'user_id' = '00000000-0000-4000-8000-00000000b202'
                and subject like 'Serious incident%' and channels = array['in_app'] and body not like '%witnesses%'));
select pg_temp.check('... the parent is not told while demerits are hidden from families',
  not exists (select 1 from announcements where audience ->> 'user_id' = '00000000-0000-4000-8000-00000000b207'));
select pg_temp.check('an incident with no points needs a note or category, and starts open',
  pg_temp.as_user('00000000-0000-4000-8000-00000000b205',
    $$select record_behaviour(array['00000000-0000-4000-8000-00000000b401']::uuid[], 'incident', null, 0, 'Left school without permission')$$) = 'ok 1'
  and pg_temp.as_user('00000000-0000-4000-8000-00000000b205',
    $$select record_behaviour(array['00000000-0000-4000-8000-00000000b401']::uuid[], 'incident', null, 0, null)$$) like 'error%');

-- ---------------------------------------------------------------- reading
-- learner one: merit +2 (class teacher), class merit +1, Fighting -5, incident 0
select pg_temp.check('the class teacher reads their learner''s 4 entries, not learner two''s',
  pg_temp.count_as('00000000-0000-4000-8000-00000000b202', $$select 1 from behaviour_entries$$) = 4);
select pg_temp.check('the subject teacher reads learner two''s 2 entries only',
  pg_temp.count_as('00000000-0000-4000-8000-00000000b203', $$select 1 from behaviour_entries$$) = 2);
select pg_temp.check('a teacher with no ties reads none',
  pg_temp.count_as('00000000-0000-4000-8000-00000000b204', $$select 1 from behaviour_entries$$) = 0);
select pg_temp.check('the discipline master and the principal read all 7',
  pg_temp.count_as('00000000-0000-4000-8000-00000000b205', $$select 1 from behaviour_entries$$) = 7
  and pg_temp.count_as('00000000-0000-4000-8000-00000000b201', $$select 1 from behaviour_entries$$) = 7);
select pg_temp.check('the bursar (fees only) reads none',
  pg_temp.count_as('00000000-0000-4000-8000-00000000b206', $$select 1 from behaviour_entries$$) = 0);
select pg_temp.check('another school reads none',
  pg_temp.count_as('00000000-0000-4000-8000-00000000b209', $$select 1 from behaviour_entries$$) = 0);
select pg_temp.check('the parent sees only the merits by default (2)',
  pg_temp.count_as('00000000-0000-4000-8000-00000000b207', $$select 1 from behaviour_entries$$) = 2
  and pg_temp.count_as('00000000-0000-4000-8000-00000000b207', $$select 1 from behaviour_entries where kind <> 'merit'$$) = 0);
select pg_temp.check('the learner sees what the parent sees (2)',
  pg_temp.count_as('00000000-0000-4000-8000-00000000b208', $$select 1 from behaviour_entries$$) = 2);
select pg_temp.check('another parent at the school sees none',
  pg_temp.count_as('00000000-0000-4000-8000-00000000b210', $$select 1 from behaviour_entries$$) = 0);
update behaviour_settings set parents_see_demerits = true where tenant_id = '00000000-0000-4000-8000-00000000b101';
select pg_temp.check('with demerits on, the parent sees the demerit too (3), not the incident',
  pg_temp.count_as('00000000-0000-4000-8000-00000000b207', $$select 1 from behaviour_entries$$) = 3);
update behaviour_settings set parents_see_incidents = true where tenant_id = '00000000-0000-4000-8000-00000000b101';
select pg_temp.check('with incidents on as well, all 4',
  pg_temp.count_as('00000000-0000-4000-8000-00000000b207', $$select 1 from behaviour_entries$$) = 4
  and pg_temp.count_as('00000000-0000-4000-8000-00000000b208', $$select 1 from behaviour_entries$$) = 4);
select pg_temp.check('staff-only notes: never to the parent or the learner',
  pg_temp.count_as('00000000-0000-4000-8000-00000000b207', $$select 1 from behaviour_staff_notes$$) = 0
  and pg_temp.count_as('00000000-0000-4000-8000-00000000b208', $$select 1 from behaviour_staff_notes$$) = 0);
select pg_temp.check('staff-only notes: the class teacher reads the 2 on their learner''s entries, the office both',
  pg_temp.count_as('00000000-0000-4000-8000-00000000b202', $$select 1 from behaviour_staff_notes$$) = 2
  and pg_temp.count_as('00000000-0000-4000-8000-00000000b205', $$select 1 from behaviour_staff_notes$$) = 2
  and pg_temp.count_as('00000000-0000-4000-8000-00000000b203', $$select 1 from behaviour_staff_notes$$) = 0
  and pg_temp.count_as('00000000-0000-4000-8000-00000000b209', $$select 1 from behaviour_staff_notes$$) = 0);

-- ---------------------------------------------------------------- never changed or deleted
select pg_temp.check('nobody updates an entry directly, not even the principal',
  pg_temp.as_user('00000000-0000-4000-8000-00000000b201', $$update behaviour_entries set points = 9 where kind = 'merit'$$) = 'ok 0');
select pg_temp.check('nobody deletes an entry',
  pg_temp.as_user('00000000-0000-4000-8000-00000000b201', $$delete from behaviour_entries$$) = 'ok 0'
  and (select count(*) from behaviour_entries where tenant_id = '00000000-0000-4000-8000-00000000b101') = 7);
select pg_temp.run('00000000-0000-4000-8000-00000000b205', format($$select set_behaviour_incident(%L, 'parent_meeting', 'resolved', true)$$,
    (select id from behaviour_entries where category_id = (select id from cat where name = 'Fighting'))));
select pg_temp.check('the office records the incident''s action and resolves it',
  pg_temp.last() = 'ok 1'
  and (select action_taken = 'parent_meeting' and follow_up_status = 'resolved' and resolved_at is not null and parent_notified_at is not null
         from behaviour_entries where category_id = (select id from cat where name = 'Fighting')));
select pg_temp.check('a teacher cannot record the incident''s action',
  pg_temp.as_user('00000000-0000-4000-8000-00000000b202', format($$select set_behaviour_incident(%L, 'warning', 'open')$$,
    (select id from behaviour_entries where category_id = (select id from cat where name = 'Fighting')))) like 'error%');
select pg_temp.check('another teacher cannot void the class teacher''s entry',
  pg_temp.as_user('00000000-0000-4000-8000-00000000b203', format($$select void_behaviour_entry(%L, 'Wrong learner')$$,
    (select id from behaviour_entries where category_id = (select id from cat where name = 'Helping others')))) like 'error%');
select pg_temp.run('00000000-0000-4000-8000-00000000b202', format($$select void_behaviour_entry(%L, 'Wrong learner')$$,
    (select id from behaviour_entries where category_id = (select id from cat where name = 'Helping others'))));
select pg_temp.check('the recorder voids their own entry with a reason; it stays, hidden from the family',
  pg_temp.last() = 'ok 1'
  and pg_temp.count_as('00000000-0000-4000-8000-00000000b207', $$select 1 from behaviour_entries$$) = 3
  and pg_temp.count_as('00000000-0000-4000-8000-00000000b202', $$select 1 from behaviour_entries$$) = 4);

-- ---------------------------------------------------------------- points
-- learner three: build a history as the server (the seed's way) across periods
insert into behaviour_entries (tenant_id, student_id, category_id, kind, points, occurred_on) values
  ('00000000-0000-4000-8000-00000000b101', '00000000-0000-4000-8000-00000000b403', (select id from cat where name = 'Leadership'), 'merit', 3, '2025-10-01'),
  ('00000000-0000-4000-8000-00000000b101', '00000000-0000-4000-8000-00000000b403', (select id from cat where name = 'Leadership'), 'merit', 3, '2026-02-01'),
  ('00000000-0000-4000-8000-00000000b101', '00000000-0000-4000-8000-00000000b403', (select id from cat where name = 'Late to class'), 'demerit', -1, '2026-02-02'),
  ('00000000-0000-4000-8000-00000000b101', '00000000-0000-4000-8000-00000000b403', (select id from cat where name = 'Sportsmanship'), 'merit', 2, '2026-05-10'),
  ('00000000-0000-4000-8000-00000000b101', '00000000-0000-4000-8000-00000000b403', (select id from cat where name = 'Disrespect'), 'demerit', -3, '2026-05-11'),
  ('00000000-0000-4000-8000-00000000b101', '00000000-0000-4000-8000-00000000b403', (select id from cat where name = 'Disrespect'), 'demerit', -3, '2026-04-15');
-- (and the 2026 class merit +1 from today, which falls in term 3 2026 if today is in it; read as of fixed dates below)

create function pg_temp.pts(p_on date)
  returns table (student_id uuid, period_start date, period_end date, merit_points int, demerit_points int, balance int)
  language sql as $$
  select * from behaviour_points(array['00000000-0000-4000-8000-00000000b403']::uuid[], p_on)
$$;
-- mode both, reset term
update behaviour_settings set mode = 'both', reset = 'term', starting_points = 100 where tenant_id = '00000000-0000-4000-8000-00000000b101';
select pg_temp.check('term, both: T1 2026 = +3 -1 = 2',
  (select balance = 2 and merit_points = 3 and demerit_points = -1 and period_start = '2026-01-05' and period_end = '2026-05-03' from pg_temp.pts('2026-03-01')));
select pg_temp.check('term, both: the April holiday belongs to T1 (+3 -1 -3 = -1)',
  (select balance = -1 from pg_temp.pts('2026-04-20')));
select pg_temp.check('term, both: T2 starts again (+2 -3 = -1)',
  (select balance = -1 and period_start = '2026-05-04' from pg_temp.pts('2026-06-01')));
update behaviour_settings set mode = 'merits_only' where tenant_id = '00000000-0000-4000-8000-00000000b101';
select pg_temp.check('term, merits_only: T1 = 3',
  (select balance = 3 from pg_temp.pts('2026-04-20')));
update behaviour_settings set mode = 'demerits_only', starting_points = 50 where tenant_id = '00000000-0000-4000-8000-00000000b101';
select pg_temp.check('term, demerits_only from 50: T1 = 50 -1 -3 = 46',
  (select balance = 46 from pg_temp.pts('2026-04-20')));
update behaviour_settings set reset = 'year' where tenant_id = '00000000-0000-4000-8000-00000000b101';
select pg_temp.check('year, demerits_only from 50: 2026 to June = 50 -1 -3 -3 = 43, from the first 2026 term',
  (select balance = 43 and period_start = '2026-01-05' from pg_temp.pts('2026-06-01')));
select pg_temp.check('year: the December holiday belongs to 2025 (merits only: 3)',
  (select merit_points = 3 and period_end = '2026-01-04' from pg_temp.pts('2025-12-20')));
update behaviour_settings set reset = 'never', mode = 'both' where tenant_id = '00000000-0000-4000-8000-00000000b101';
select pg_temp.check('never, both: everything to June = 3+3-1+2-3-3 = 1',
  (select balance = 1 and period_start is null and period_end is null from pg_temp.pts('2026-06-01')));
update behaviour_settings set points_enabled = false where tenant_id = '00000000-0000-4000-8000-00000000b101';
select pg_temp.check('points off: no balance',
  (select balance is null from pg_temp.pts('2026-06-01')));
update behaviour_settings set points_enabled = true, reset = 'term' where tenant_id = '00000000-0000-4000-8000-00000000b101';
select pg_temp.check('voided entries do not count (learner one: only the class merit, the fight and the incident)',
  (select merit_points from behaviour_points(array['00000000-0000-4000-8000-00000000b401']::uuid[])) = 1);

select pg_temp.check('the parent gets their child''s total, counting the demerits they may not see',
  pg_temp.count_as('00000000-0000-4000-8000-00000000b207',
    $$select 1 from behaviour_points(array['00000000-0000-4000-8000-00000000b401', '00000000-0000-4000-8000-00000000b403']::uuid[])$$) = 1);
select pg_temp.check('the subject teacher gets learner two only; the office the whole school (null = all)',
  pg_temp.count_as('00000000-0000-4000-8000-00000000b203', $$select 1 from behaviour_points(null)$$) = 1
  and pg_temp.count_as('00000000-0000-4000-8000-00000000b205', $$select 1 from behaviour_points(null)$$) = 3);
select pg_temp.check('another school gets nothing',
  pg_temp.count_as('00000000-0000-4000-8000-00000000b209',
    $$select 1 from behaviour_points(array['00000000-0000-4000-8000-00000000b401']::uuid[])$$) = 0);

-- ---------------------------------------------------------------- policies use the once-per-query form
select pg_temp.check('no behaviour policy calls has_perm / has_office_perm / may_administer per row',
  not exists (select 1 from pg_policies where tablename like 'behaviour%'
               and (coalesce(qual, '') ~ '(has_perm|has_office_perm|may_administer|is_guardian_of)\('
                    or coalesce(with_check, '') ~ '(has_perm|has_office_perm|may_administer|is_guardian_of)\(')));
select pg_temp.check('every behaviour policy is for signed-in users only',
  not exists (select 1 from pg_policies where tablename like 'behaviour%' and roles <> '{authenticated}'));

rollback;
