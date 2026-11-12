-- FIG-1514: the morning and the afternoon register, in the database.
--
-- attendance stays the morning register (unchanged: phones already installed write it); attendance_afternoon is the afternoon one;
-- attendance_settings says whether a school takes an afternoon register and how percentages count. See
-- supabase/migrations/20261106000200_afternoon_attendance.sql. Runs against a local database with `npm run db:seed` and `db:seed-org`
-- data, in one transaction that is rolled back. Every check prints PASS, FAIL or INFO.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/afternoon_attendance.sql
--
-- Registers are filed in a March 2020 term made up here (the database refuses a register after today or outside its term).

\set ON_ERROR_STOP 1
begin;

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when ok then 'PASS' else 'FAIL' end, label; end $$;
create function pg_temp.info(label text) returns void language plpgsql as $$ begin raise notice 'INFO %', label; end $$;

-- one statement as a signed-in user: 'allowed' or 'refused <sqlstate> <message>'
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
    return 'refused ' || sqlstate || ' ' || sqlerrm;
  end;
end $$;

-- a count as a signed-in user (what their read rule lets them see)
create function pg_temp.count_as(p_user uuid, p_query text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute p_query into n;
  reset role;
  return n;
end $$;

-- ---------------------------------------------------------------- what there is to work with
select set_config('t.a', (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.k', (select id::text from tenants where slug = 'kijani-ridge'), true);
select set_config('t.teacher', (select id::text from profiles where login_id = 'TC-0002' and tenant_id = current_setting('t.a')::uuid), true);
select set_config('t.admin', (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.a')::uuid order by id limit 1), true);
select set_config('t.kadmin', (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.k')::uuid order by id limit 1), true);
select set_config('t.cx', (select id::text from classes where tenant_id = current_setting('t.a')::uuid and name = 'Form 2 West'), true);
select set_config('t.kid1', (select id::text from students where class_id = current_setting('t.cx')::uuid and active order by id limit 1), true);
select set_config('t.kid2', (select id::text from students where class_id = current_setting('t.cx')::uuid and active order by id offset 1 limit 1), true);
select set_config('t.kid3', (select id::text from students where class_id = current_setting('t.cx')::uuid and active order by id offset 2 limit 1), true);
with tm as (insert into terms (tenant_id, name, year, index, starts_on, ends_on, is_current)
              values (current_setting('t.a')::uuid, 'FIG-1514 March 2020', 2020, 1, '2020-03-01', '2020-03-31', false) returning id)
  select set_config('t.term', (select id::text from tm), true);

select pg_temp.check('the seed has what these checks need (Alliance teacher and admin, Form 2 West with three learners, a Kijani Ridge admin)',
  current_setting('t.teacher') <> '' and current_setting('t.admin') <> '' and current_setting('t.kadmin') <> ''
  and current_setting('t.kid3') <> '');

-- an entry in either register, as the database owner
create function pg_temp.put(p_table text, p_student text, p_on date, p_mark text, p_at timestamptz default now()) returns void language plpgsql as $$
begin
  execute format($q$insert into %I (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark, marked_at)
                    values (%L, %L, %L, %L, %L, %L, %L, %L)
                    on conflict (student_id, taken_on) do update set mark = excluded.mark, marked_at = excluded.marked_at$q$,
                 p_table, current_setting('t.a'), current_setting(p_student), current_setting('t.cx'), current_setting('t.term'),
                 current_setting('t.teacher'), p_on, p_mark, p_at);
end $$;
create function pg_temp.mark_of(p_table text, p_student text, p_on date) returns text language plpgsql as $$
declare m text;
begin
  execute format('select mark::text from %I where student_id = %L and taken_on = %L', p_table, current_setting(p_student), p_on) into m;
  return m;
end $$;

-- ---------------------------------------------------------------- the morning register is untouched (decision A, AC 4)
select pg_temp.check('attendance keeps its key: unique (student_id, taken_on)',
  exists (select 1 from pg_constraint where conrelid = 'attendance'::regclass and contype = 'u'
           and conkey = array[(select attnum from pg_attribute where attrelid = 'attendance'::regclass and attname = 'student_id'),
                              (select attnum from pg_attribute where attrelid = 'attendance'::regclass and attname = 'taken_on')]::int2[]));
select pg_temp.check('attendance has no session column (every row in it is a morning row, nothing was rewritten)',
  not exists (select 1 from pg_attribute where attrelid = 'attendance'::regclass and attname in ('session', 'period') and not attisdropped));
select pg_temp.check('attendance_afternoon has the same key',
  exists (select 1 from pg_constraint where conrelid = 'attendance_afternoon'::regclass and contype = 'u' and cardinality(conkey) = 2));
select pg_temp.info('AC 4 (row count and checksum of attendance before and after the migration) is checked by the runner, not here: '
  || 'this file runs after the migration. attendance now: ' || (select count(*) from attendance) || ' rows, md5 '
  || (select md5(coalesce(string_agg(a::text, '|' order by a.id), '')) from attendance a));

-- ---------------------------------------------------------------- the afternoon off (the default)
select pg_temp.check('a school with no settings row takes no afternoon register and counts by session',
  not exists (select 1 from attendance_settings where tenant_id = current_setting('t.a')::uuid)
  and attendance_afternoon_enabled(current_setting('t.a')::uuid) = false
  and attendance_percentage_mode(current_setting('t.a')::uuid) = 'session');
select pg_temp.check('with the afternoon off, a new afternoon entry is refused, in words (23514)',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into attendance_afternoon (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, '2020-03-02', 'present')$q$, current_setting('t.a'), current_setting('t.kid1'), current_setting('t.cx'), current_setting('t.term'), current_setting('t.admin')))
  like 'refused 23514 This school does not take an afternoon register%');
select pg_temp.check('with the afternoon off, the morning register works as before',
  pg_temp.as_user(current_setting('t.teacher')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, '2020-03-02', 'present') on conflict (student_id, taken_on) do update set mark = excluded.mark$q$,
    current_setting('t.a'), current_setting('t.kid1'), current_setting('t.cx'), current_setting('t.term'), current_setting('t.teacher'))) = 'allowed');

-- ---------------------------------------------------------------- settings: who may change them
select pg_temp.check('a teacher without the attendance area cannot turn the afternoon register on',
  pg_temp.as_user(current_setting('t.teacher')::uuid, format($q$insert into attendance_settings (tenant_id, afternoon_enabled) values (%L, true)$q$, current_setting('t.a')))
  like 'refused 42501%');
select pg_temp.check('another school''s admin cannot change this school''s settings',
  pg_temp.as_user(current_setting('t.kadmin')::uuid, format($q$insert into attendance_settings (tenant_id, afternoon_enabled) values (%L, true)$q$, current_setting('t.a')))
  like 'refused 42501%');
select pg_temp.check('the school admin turns it on',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into attendance_settings (tenant_id, afternoon_enabled) values (%L, true)$q$, current_setting('t.a'))) = 'allowed');
select pg_temp.check('everyone at the school reads the settings (a teacher sees them; another school does not)',
  pg_temp.count_as(current_setting('t.teacher')::uuid, format('select count(*) from attendance_settings where tenant_id = %L', current_setting('t.a'))) = 1
  and pg_temp.count_as(current_setting('t.kadmin')::uuid, format('select count(*) from attendance_settings where tenant_id = %L', current_setting('t.a'))) = 0);
select pg_temp.check('a percentage mode other than session or day is refused',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$update attendance_settings set percentage_mode = 'week' where tenant_id = %L$q$, current_setting('t.a'))) like 'refused 23514%');

-- ---------------------------------------------------------------- two registers, side by side (AC 1, 5, 6)
select pg_temp.put('attendance', 't.kid1', '2020-03-03', 'present', '2020-03-03 08:00+03');
select pg_temp.check('the class teacher saves the afternoon register for a learner who has a morning one',
  pg_temp.as_user(current_setting('t.teacher')::uuid, format($q$insert into attendance_afternoon (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark, marked_at)
    values (%L, %L, %L, %L, %L, '2020-03-03', 'absent', '2020-03-03 13:00+03') on conflict (student_id, taken_on) do update set mark = excluded.mark, marked_at = excluded.marked_at$q$,
    current_setting('t.a'), current_setting('t.kid1'), current_setting('t.cx'), current_setting('t.term'), current_setting('t.teacher'))) = 'allowed');
select pg_temp.check('both registers stand for the learner and day: morning present, afternoon absent',
  pg_temp.mark_of('attendance', 't.kid1', '2020-03-03') = 'present' and pg_temp.mark_of('attendance_afternoon', 't.kid1', '2020-03-03') = 'absent');

-- an installed (old) build: the exact upsert it sends today, a newer whole-class morning register
select pg_temp.check('the old build''s upsert (attendance, on conflict student_id, taken_on) still works and is the morning register',
  pg_temp.as_user(current_setting('t.teacher')::uuid, format($q$insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark, note, marked_at)
    values (%L, %L, %L, %L, %L, '2020-03-03', 'late', null, '2020-03-03 14:00+03') on conflict (student_id, taken_on) do update
    set tenant_id = excluded.tenant_id, class_id = excluded.class_id, term_id = excluded.term_id, taken_by = excluded.taken_by, mark = excluded.mark, note = excluded.note, marked_at = excluded.marked_at$q$,
    current_setting('t.a'), current_setting('t.kid1'), current_setting('t.cx'), current_setting('t.term'), current_setting('t.teacher'))) = 'allowed'
  and pg_temp.mark_of('attendance', 't.kid1', '2020-03-03') = 'late');
select pg_temp.check('... and never changes the afternoon register',
  pg_temp.mark_of('attendance_afternoon', 't.kid1', '2020-03-03') = 'absent');
select pg_temp.info('decision F, accepted: that old-build register, sent in the afternoon, replaced the morning mark (present -> late) by newest-wins');

-- held offline: an older afternoon register arriving late does not replace a newer one, and does not touch the morning
select pg_temp.put('attendance_afternoon', 't.kid1', '2020-03-03', 'present', '2020-03-03 12:30+03');
select pg_temp.check('an afternoon register held since before the stored one is ignored (newest wins, FIG-1410)',
  pg_temp.mark_of('attendance_afternoon', 't.kid1', '2020-03-03') = 'absent');
select pg_temp.put('attendance', 't.kid1', '2020-03-03', 'absent', '2020-03-03 07:00+03');
select pg_temp.check('a morning register held since before the stored one is ignored, and the afternoon is unchanged',
  pg_temp.mark_of('attendance', 't.kid1', '2020-03-03') = 'late' and pg_temp.mark_of('attendance_afternoon', 't.kid1', '2020-03-03') = 'absent');

-- The date is worked out here, as the owner: school_today() is not callable by a signed-in user (20261105100000), so naming it inside
-- the user's statement would be refused 42501 before the trigger ever ran. The future-date test comes before the term test in
-- attendance_day_and_order, so the refusal must be the future-date one, in the morning register's own words.
select pg_temp.check('an afternoon entry dated after today is refused, in the morning register''s words (FIG-1400)',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into attendance_afternoon (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, %L, 'present')$q$,
    current_setting('t.a'), current_setting('t.kid2'), current_setting('t.cx'), current_setting('t.term'), current_setting('t.admin'),
    school_today(current_setting('t.a')::uuid) + 3)) like 'refused 23514 This register is dated % but today is %'
  and not exists (select 1 from attendance_afternoon where student_id = current_setting('t.kid2')::uuid and taken_on > school_today(current_setting('t.a')::uuid)));
select pg_temp.check('an afternoon entry outside its term is refused (FIG-1400)',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into attendance_afternoon (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, '2020-04-15', 'present')$q$,
    current_setting('t.a'), current_setting('t.kid2'), current_setting('t.cx'), current_setting('t.term'), current_setting('t.admin'))) like 'refused 23514%');
select pg_temp.check('a plain second afternoon entry for the same learner and day is refused (the key, 23505)',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into attendance_afternoon (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, '2020-03-03', 'late')$q$,
    current_setting('t.a'), current_setting('t.kid1'), current_setting('t.cx'), current_setting('t.term'), current_setting('t.admin'))) like 'refused 23505%');

-- ---------------------------------------------------------------- other schools
select pg_temp.check('another school''s admin reads none of this school''s afternoon register',
  pg_temp.count_as(current_setting('t.kadmin')::uuid, format('select count(*) from attendance_afternoon where tenant_id = %L', current_setting('t.a'))) = 0);
select pg_temp.check('another school''s admin cannot write this school''s afternoon register',
  pg_temp.as_user(current_setting('t.kadmin')::uuid, format($q$insert into attendance_afternoon (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, '2020-03-04', 'present')$q$,
    current_setting('t.a'), current_setting('t.kid2'), current_setting('t.cx'), current_setting('t.term'), current_setting('t.kadmin'))) like 'refused%');
select pg_temp.check('the school''s own admin reads it',
  pg_temp.count_as(current_setting('t.admin')::uuid, format('select count(*) from attendance_afternoon where tenant_id = %L', current_setting('t.a'))) >= 1);

-- ---------------------------------------------------------------- the session of a moment (decision C, AC 8)
select pg_temp.check('Nairobi, afternoon on: 11:59 is the morning, 12:00 the afternoon',
  attendance_session_at(current_setting('t.a')::uuid, '2026-11-06 11:59+03') = 'morning'
  and attendance_session_at(current_setting('t.a')::uuid, '2026-11-06 12:00+03') = 'afternoon');
update tenants set timezone = 'Europe/London' where id = current_setting('t.a')::uuid;
select pg_temp.check('a school in London (November, UTC+0): 11:59 UTC is the morning, 12:00 UTC the afternoon (sessionAt agrees: attendanceSession.test.ts)',
  attendance_session_at(current_setting('t.a')::uuid, '2026-11-06 11:59+00') = 'morning'
  and attendance_session_at(current_setting('t.a')::uuid, '2026-11-06 12:00+00') = 'afternoon');
update tenants set timezone = 'Africa/Nairobi' where id = current_setting('t.a')::uuid;
select pg_temp.check('an unknown school id falls back to Nairobi and to no afternoon (morning)',
  attendance_session_at(gen_random_uuid(), '2026-11-06 15:00+03') = 'morning');

-- ---------------------------------------------------------------- counting (decisions D, J, K; AC 9)
-- In the term so far: kid1 03-02 morning present (above); kid1 03-03 morning late, afternoon absent. Added now: kid2 03-05 morning present
-- only; kid3 03-05 morning absent, afternoon absent.
select pg_temp.put('attendance', 't.kid2', '2020-03-05', 'present');
select pg_temp.put('attendance', 't.kid3', '2020-03-05', 'absent');
select pg_temp.put('attendance_afternoon', 't.kid3', '2020-03-05', 'absent');
create function pg_temp.fig() returns text language sql as $$
  select count(*) filter (where here) || '/' || count(*) from attendance_counted(current_setting('t.a')::uuid, current_setting('t.term')::uuid)
$$;
select pg_temp.check('by session: every entry counts, a morning-only date counts once (late counts as here): 3 of 6',
  pg_temp.fig() = '3/6');
update attendance_settings set percentage_mode = 'day' where tenant_id = current_setting('t.a')::uuid;
select pg_temp.check('by day (the current mode recounts the past): a learner-day once, here if here in either register: 3 of 4',
  pg_temp.fig() = '3/4');
update attendance_settings set percentage_mode = 'session' where tenant_id = current_setting('t.a')::uuid;

insert into early_sign_outs (tenant_id, student_id, class_id, student_name, taken_on, signed_out_at, signed_out_local, reason, collected_by_name, collected_by_relationship)
select current_setting('t.a')::uuid, s.id, s.class_id, s.full_name, '2020-03-03', '2020-03-03 11:00+03', '11:00', 'Clinic appointment', 'Jane Doe', 'Mother'
  from students s where s.id = current_setting('t.kid1')::uuid;
select pg_temp.check('a live early sign-out leaves that afternoon absence out of the figure altogether (not absent, not excused): 3 of 5',
  pg_temp.fig() = '3/5');
update early_sign_outs set voided_at = now() where student_id = current_setting('t.kid1')::uuid and taken_on = '2020-03-03';
select pg_temp.check('a voided sign-out does not: 3 of 6 again', pg_temp.fig() = '3/6');

select pg_temp.check('Reports'' per-class figures (term_class_figures) give the same count for the class',
  (select att_here || '/' || att_total from term_class_figures(current_setting('t.a')::uuid, current_setting('t.term')::uuid)
    where class_id = current_setting('t.cx')::uuid) = '3/6');

-- ---------------------------------------------------------------- the group summary
-- Today's registers for the three learners (the summary reads current_date: its date rule is a separate, out-of-scope finding), filed
-- in the school's own term covering today (terms may not overlap, so none is made up here). kid2 is absent in the morning and present in the
-- afternoon, so 'day' must count one learner more than 'session'. Other learners may have entries today (an earlier browser run), so
-- the expected figures are worked out from the live rows, independently of refresh_organization_tenant_summary().
select set_config('t.nowterm', coalesce(
  (select id::text from terms where tenant_id = current_setting('t.a')::uuid and current_date between starts_on and ends_on order by is_current desc limit 1), ''), true);
select pg_temp.check('the seed has an Alliance term covering today (the group-summary checks below need it)', current_setting('t.nowterm') <> '');
create function pg_temp.put_today(p_table text, p_student text, p_mark text) returns void language plpgsql as $$
begin
  execute format($q$insert into %I (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark, marked_at)
                    values (%L, %L, %L, %L, %L, current_date, %L, now())
                    on conflict (student_id, taken_on) do update set mark = excluded.mark, marked_at = excluded.marked_at$q$,
                 p_table, current_setting('t.a'), current_setting(p_student), current_setting('t.cx'), current_setting('t.nowterm'),
                 current_setting('t.teacher'), p_mark);
end $$;
select pg_temp.put_today('attendance', 't.kid1', 'present'), pg_temp.put_today('attendance', 't.kid2', 'absent'), pg_temp.put_today('attendance', 't.kid3', 'present');
select pg_temp.put_today('attendance_afternoon', 't.kid1', 'absent'), pg_temp.put_today('attendance_afternoon', 't.kid2', 'present'), pg_temp.put_today('attendance_afternoon', 't.kid3', 'present');
create function pg_temp.summary(p_col text) returns bigint language plpgsql as $$
declare n bigint;
begin
  execute format('select %I from organization_tenant_summary where tenant_id = %L', p_col, current_setting('t.a')) into n;
  return n;
end $$;
select set_config('t.am_today', (select count(*)::text from attendance where tenant_id = current_setting('t.a')::uuid and taken_on = current_date and mark = 'present'), true);
select set_config('t.pm_today', (select count(*)::text from attendance_afternoon where tenant_id = current_setting('t.a')::uuid and taken_on = current_date and mark = 'present'), true);
select set_config('t.either_today', (select count(*)::text from (
    select student_id from attendance where tenant_id = current_setting('t.a')::uuid and taken_on = current_date and mark = 'present'
    union
    select student_id from attendance_afternoon where tenant_id = current_setting('t.a')::uuid and taken_on = current_date and mark = 'present') x), true);
select pg_temp.check('the group summary, by session: present_today is the morning register, present_today_pm the afternoon one',
  pg_temp.summary('present_today') = current_setting('t.am_today')::bigint
  and pg_temp.summary('present_today_pm') = current_setting('t.pm_today')::bigint
  and current_setting('t.pm_today')::bigint >= 2);
update attendance_settings set percentage_mode = 'day' where tenant_id = current_setting('t.a')::uuid;
select pg_temp.check('the group summary, by day (refreshed by the settings change): each learner present in either register once, so kid2 now counts',
  pg_temp.summary('present_today') = current_setting('t.either_today')::bigint
  and pg_temp.summary('present_today') > current_setting('t.am_today')::bigint
  and pg_temp.summary('present_today_pm') = current_setting('t.pm_today')::bigint);
update attendance_settings set percentage_mode = 'session' where tenant_id = current_setting('t.a')::uuid;
select pg_temp.check('back to by session: present_today is the morning register again',
  pg_temp.summary('present_today') = current_setting('t.am_today')::bigint);

-- ---------------------------------------------------------------- the sick bay (decisions E, L; AC 11)
with v as (insert into sick_bay_visits (tenant_id, student_id, complaint, outcome, time_in, time_out)
           values (current_setting('t.a')::uuid, current_setting('t.kid2')::uuid, 'Fever', 'home', '2020-03-10 08:30+03', '2020-03-10 09:30+03') returning id)
  select set_config('t.vam', (select id::text from v), true);
with v as (insert into sick_bay_visits (tenant_id, student_id, complaint, outcome, time_in, time_out)
           values (current_setting('t.a')::uuid, current_setting('t.kid3')::uuid, 'Fever', 'hospital', '2020-03-10 13:00+03', '2020-03-10 14:00+03') returning id)
  select set_config('t.vpm', (select id::text from v), true);
select pg_temp.check('the nurse marks a learner sent home in the morning',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$select medical_mark_attendance(%L, 'excused')$q$, current_setting('t.vam'))) = 'allowed');
select pg_temp.check('... it goes to the morning register and is carried into the afternoon register (the school takes one)',
  pg_temp.mark_of('attendance', 't.kid2', '2020-03-10') = 'excused' and pg_temp.mark_of('attendance_afternoon', 't.kid2', '2020-03-10') = 'excused');
select pg_temp.check('a mark about the afternoon goes to the afternoon register only',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$select medical_mark_attendance(%L, 'absent')$q$, current_setting('t.vpm'))) = 'allowed'
  and pg_temp.mark_of('attendance_afternoon', 't.kid3', '2020-03-10') = 'absent' and pg_temp.mark_of('attendance', 't.kid3', '2020-03-10') is null);
select pg_temp.as_user(current_setting('t.admin')::uuid, format($q$select medical_mark_attendance(%L, 'absent')$q$, current_setting('t.vam')));
select pg_temp.check('marking again updates, never duplicates: one entry per learner per register',
  (select count(*) from attendance where student_id = current_setting('t.kid2')::uuid and taken_on = '2020-03-10') = 1
  and (select count(*) from attendance_afternoon where student_id = current_setting('t.kid2')::uuid and taken_on = '2020-03-10') = 1
  and pg_temp.mark_of('attendance_afternoon', 't.kid2', '2020-03-10') = 'absent');

-- ---------------------------------------------------------------- the afternoon turned off again (decision G, AC 3a, 7)
update attendance_settings set afternoon_enabled = false where tenant_id = current_setting('t.a')::uuid;
select pg_temp.check('turned off: the afternoon entries already stored are all still there',
  (select count(*) from attendance_afternoon where tenant_id = current_setting('t.a')::uuid and term_id = current_setting('t.term')::uuid) = 4);
select pg_temp.check('turned off: a new afternoon entry is refused',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into attendance_afternoon (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, '2020-03-12', 'present')$q$,
    current_setting('t.a'), current_setting('t.kid1'), current_setting('t.cx'), current_setting('t.term'), current_setting('t.admin'))) like 'refused 23514%');
select pg_temp.check('turned off: the apps'' upsert of a stored afternoon entry is refused too (the trigger fires on INSERT ... ON CONFLICT)',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$insert into attendance_afternoon (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
    values (%L, %L, %L, %L, %L, '2020-03-05', 'late') on conflict (student_id, taken_on) do update set mark = excluded.mark$q$,
    current_setting('t.a'), current_setting('t.kid3'), current_setting('t.cx'), current_setting('t.term'), current_setting('t.admin'))) like 'refused 23514%'
  and pg_temp.mark_of('attendance_afternoon', 't.kid3', '2020-03-05') is distinct from 'late');
select pg_temp.check('turned off: a past afternoon entry can still be corrected by a plain UPDATE (no app does this)',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$update attendance_afternoon set mark = 'excused', marked_at = now() where student_id = %L and taken_on = '2020-03-05'$q$,
    current_setting('t.kid3'))) = 'allowed' and pg_temp.mark_of('attendance_afternoon', 't.kid3', '2020-03-05') = 'excused');
select pg_temp.check('turned off: past afternoon entries still count (decision I)',
  (select count(*) from attendance_counted(current_setting('t.a')::uuid, current_setting('t.term')::uuid)) > 3);
select pg_temp.check('turned off: the sick bay marks only the morning register',
  attendance_session_at(current_setting('t.a')::uuid, '2020-03-10 15:00+03') = 'morning');

-- ---------------------------------------------------------------- registration
select pg_temp.check('attendance_afternoon has RLS on, one read and one write policy',
  (select relrowsecurity from pg_class where oid = 'attendance_afternoon'::regclass)
  and (select count(*) from pg_policies where tablename = 'attendance_afternoon') = 2);
select pg_temp.check('both new tables have the three audit triggers',
  (select count(*) from pg_trigger where tgrelid = 'attendance_afternoon'::regclass and tgname like '%audit%') = 3
  and (select count(*) from pg_trigger where tgrelid = 'attendance_settings'::regclass and tgname like '%audit%') = 3);
select pg_temp.check('attendance_afternoon has the day-and-order, same-school and learner-school triggers',
  (select count(*) from pg_trigger where tgrelid = 'attendance_afternoon'::regclass
     and tgname in ('attendance_afternoon_day_and_order', 'zz_attendance_afternoon_same_school', 'attendance_afternoon_student_tenant', 'attendance_afternoon_allowed')) = 4);
select pg_temp.check('a signed-in user cannot call the helpers (they answer for any school)',
  pg_temp.as_user(current_setting('t.admin')::uuid, format($q$select * from attendance_counted(%L)$q$, current_setting('t.k'))) like 'refused 42501%'
  and pg_temp.as_user(current_setting('t.admin')::uuid, format($q$select attendance_session_at(%L)$q$, current_setting('t.k'))) like 'refused 42501%');
create function pg_temp.why_owner(p_stmt text) returns text language plpgsql as $$
begin execute p_stmt; return 'allowed'; exception when others then return 'refused ' || sqlstate || ' ' || sqlerrm; end $$;
select pg_temp.check('a learner with an afternoon entry cannot be deleted: the delete guard names it (it finds the table by its foreign key)',
  pg_temp.why_owner(format('delete from students where id = %L', current_setting('t.kid3'))) like 'refused 23001%attendance afternoon%');

rollback;
