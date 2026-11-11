-- Leave run by Figbloom HR: checks for 20261105800000_leave_via_hr.
--
-- Runs against a local database that has the migrations applied, inside one transaction that is rolled back.
-- It makes its own schools, organisation and people, so it needs no seed. Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/leave_via_hr.sql
--
-- What it shows:
--   - who may run what: hr_leave_access() for signed-in people (about themselves only), everything else the service
--     role's; HR_LEAVE_ENABLED is there and off;
--   - hr_leave_access(): not_staff / off / not_linked / not_enabled / available, and "approver" for the school's
--     admins and staff holding the leave or fees area only; a platform "no" holds until the next answer;
--   - leave_requests: nobody signed in (teacher or office) can insert an HR row, change one, or set HR's columns or
--     the export mark; while HR leave is on for a school its Schools-only form is refused there, and not elsewhere;
--     (tenant_id, hr_application_id) is unique; an HR row must name its application;
--   - platform_hr_leave_event(): an approval writes an approved row the teacher reads (what cover planning reads),
--     with the usual notice and its own audit line only; idempotent per delivery and per application; the
--     person's waiting Schools request gives way; overlapping approved leave is refused and not recorded; a date
--     change works in either order; an older event is stale; a cancel undoes the cover ahead and tells the
--     substitute; switched off it records and applies nothing; another school's person is refused;
--   - the history export lists approved Schools leave of staff HR knows, marks it, and lists nothing twice.

\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------- helpers
create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when coalesce(ok, false) then 'PASS' else 'FAIL' end, label; end $$;
create function pg_temp.act_as(uid uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.signed_out() returns void language sql as $$ select set_config('request.jwt.claims', '', true) $$;
-- a statement as this signed-in person: 'ok' or the SQLSTATE it was refused with
create function pg_temp.try_as(uid uuid, stmt text) returns text language plpgsql as $$
declare r text;
begin
  perform pg_temp.act_as(uid);
  set local role authenticated;
  begin
    execute stmt;
    r := 'ok';
  exception when others then
    r := sqlstate;
  end;
  reset role;
  perform pg_temp.signed_out();
  return r;
end $$;
create function pg_temp.access_as(uid uuid) returns jsonb language plpgsql as $$
declare a jsonb;
begin
  perform pg_temp.act_as(uid);
  set local role authenticated;
  a := hr_leave_access();
  reset role;
  perform pg_temp.signed_out();
  return a;
end $$;
-- platform_hr_leave_event as the service role (platform-events)
create function pg_temp.ev(p_delivery text, p_type text, p_tenant uuid, p_person uuid, p_app text, p_start date, p_end date,
                           p_at timestamptz default now(), p_apply boolean default true) returns jsonb language plpgsql as $$
declare a jsonb;
begin
  set local role service_role;
  a := platform_hr_leave_event(p_delivery, 'evt-' || p_delivery, p_type, p_tenant, p_person, p_app, 'EMP-7', 'Annual leave',
                               p_start, p_end, false, (p_end - p_start + 1)::numeric, p_at, p_apply);
  reset role;
  return a;
end $$;
-- the event, in a statement of its own (a check in the same statement would read from before it); its answer in t.r
create function pg_temp.run(a jsonb) returns text language sql as $$ select set_config('t.r', a::text, true) $$;
create function pg_temp.r() returns jsonb language sql as $$ select current_setting('t.r')::jsonb $$;
create function pg_temp.person(p_id uuid, p_tenant uuid, p_role app_role, p_name text) returns void
language sql as $$
  insert into auth.users (id, email) values (p_id, p_id::text || '@login.leavecheck.figbloom.internal');
  insert into profiles (id, tenant_id, role, full_name) values (p_id, p_tenant, p_role, p_name);
$$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

-- ---------------------------------------------------------------- fixtures (as postgres)
insert into organizations (id, name, slug, kind, status) values
  ('00000000-0000-4000-8000-00000000c8f1', 'Leave Check Group', 'leavecheck-group-' || substr(md5(random()::text), 1, 8), 'group_owner', 'active');
insert into tenants (id, name, slug, county, organization_id) values
  ('00000000-0000-4000-8000-00000000c801', 'Leave Check School', 'leavecheck-a-' || substr(md5(random()::text), 1, 8), 'Nairobi', '00000000-0000-4000-8000-00000000c8f1'),
  ('00000000-0000-4000-8000-00000000c802', 'Leave Check Other School', 'leavecheck-b-' || substr(md5(random()::text), 1, 8), 'Nairobi', '00000000-0000-4000-8000-00000000c8f1');

select pg_temp.person('00000000-0000-4000-8000-00000000c8a1', '00000000-0000-4000-8000-00000000c801', 'school_admin', 'Leave Check Principal');
select pg_temp.person('00000000-0000-4000-8000-00000000c8a2', '00000000-0000-4000-8000-00000000c801', 'teacher', 'Leave Check Sketch');
select pg_temp.person('00000000-0000-4000-8000-00000000c8a3', '00000000-0000-4000-8000-00000000c801', 'teacher', 'Leave Check Deputy');
select pg_temp.person('00000000-0000-4000-8000-00000000c8a4', '00000000-0000-4000-8000-00000000c801', 'staff', 'Leave Check Bursar');
select pg_temp.person('00000000-0000-4000-8000-00000000c8a5', '00000000-0000-4000-8000-00000000c801', 'staff', 'Leave Check Cook');
select pg_temp.person('00000000-0000-4000-8000-00000000c8a6', '00000000-0000-4000-8000-00000000c801', 'parent', 'Leave Check Parent');
select pg_temp.person('00000000-0000-4000-8000-00000000c8a7', '00000000-0000-4000-8000-00000000c801', 'teacher', 'Leave Check Substitute');
select pg_temp.person('00000000-0000-4000-8000-00000000c8b1', '00000000-0000-4000-8000-00000000c802', 'teacher', 'Leave Check Other Teacher');
update profiles set created_at = now() - interval '1 year' where id = '00000000-0000-4000-8000-00000000c8a1';
insert into staff_permissions (tenant_id, profile_id, area) values
  ('00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c8a3', 'leave'),
  ('00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c8a4', 'fees'),
  ('00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c8a5', 'inventory');
insert into platform_links (kind, local_id, platform_id) values
  ('tenant', '00000000-0000-4000-8000-00000000c801', 'pt-leavecheck-a') on conflict (kind, local_id) do nothing;
delete from platform_module_status where tenant_id in ('00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c802');
insert into classes (id, tenant_id, name, form_level) values
  ('00000000-0000-4000-8000-00000000c8c1', '00000000-0000-4000-8000-00000000c801', 'Leave Check Form 2 East', 2);
insert into subjects (id, tenant_id, name, code) values
  ('00000000-0000-4000-8000-00000000c8d1', '00000000-0000-4000-8000-00000000c801', 'Leave Check Maths', 'LCMATH');

-- ---------------------------------------------------------------- who may run what
select pg_temp.check('signed-in people can ask hr_leave_access; anon can''t',
  has_function_privilege('authenticated', 'hr_leave_access()', 'execute')
  and not has_function_privilege('anon', 'hr_leave_access()', 'execute'));
select pg_temp.check('only the service role runs ' || f, not has_function_privilege('authenticated', f, 'execute')
  and not has_function_privilege('anon', f, 'execute') and has_function_privilege('service_role', f, 'execute'))
  from unnest(array['hr_leave_enabled()', 'hr_leave_on(uuid)', 'hr_leave_notice(uuid, uuid, text, text)',
    'platform_hr_leave_event(text, text, text, uuid, uuid, text, text, text, date, date, boolean, numeric, timestamptz, boolean)',
    'platform_leave_history(uuid)', 'platform_leave_history_mark(uuid, uuid[])']) f;
select pg_temp.check('HR_LEAVE_ENABLED is there and off by default',
  exists (select 1 from platform_settings where key = 'HR_LEAVE_ENABLED') and not hr_leave_enabled());

-- ---------------------------------------------------------------- hr_leave_access
select pg_temp.check('switched off: a teacher gets off', pg_temp.access_as('00000000-0000-4000-8000-00000000c8a2') ->> 'status' = 'off');
select pg_temp.check('a parent is not_staff, and no approver', pg_temp.access_as('00000000-0000-4000-8000-00000000c8a6') = '{"status": "not_staff", "approver": false}'::jsonb);
select pg_temp.check('nobody signed in: not_staff', hr_leave_access() ->> 'status' = 'not_staff');
select pg_temp.check('switched off, a teacher may still use the old form',
  pg_temp.try_as('00000000-0000-4000-8000-00000000c8a2', $q$insert into leave_requests (tenant_id, teacher_id, starts_on, ends_on, reason)
     values ('00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c8a2', current_date + 200, current_date + 201, 'leavecheck old form')$q$) = 'ok');

update platform_settings set value = 'true', updated_at = now() where key = 'HR_LEAVE_ENABLED';

select pg_temp.check('switched on: available at a school the platform knows', pg_temp.access_as('00000000-0000-4000-8000-00000000c8a2') ->> 'status' = 'available');
select pg_temp.check('switched on: not_linked at a school it doesn''t', pg_temp.access_as('00000000-0000-4000-8000-00000000c8b1') ->> 'status' = 'not_linked');
select pg_temp.check('approver: the school''s admin', (pg_temp.access_as('00000000-0000-4000-8000-00000000c8a1') ->> 'approver')::boolean);
select pg_temp.check('approver: a teacher holding the leave area (deputy)', (pg_temp.access_as('00000000-0000-4000-8000-00000000c8a3') ->> 'approver')::boolean);
select pg_temp.check('approver: staff holding the fees area (bursar)', (pg_temp.access_as('00000000-0000-4000-8000-00000000c8a4') ->> 'approver')::boolean);
select pg_temp.check('not an approver: a teacher with no area, staff with another area',
  not (pg_temp.access_as('00000000-0000-4000-8000-00000000c8a2') ->> 'approver')::boolean
  and not (pg_temp.access_as('00000000-0000-4000-8000-00000000c8a5') ->> 'approver')::boolean);

set local role service_role;
select platform_record_module_status('00000000-0000-4000-8000-00000000c801', 'hr', false, 'target_not_enabled');
reset role;
update platform_module_status set checked_at = now() - interval '3 hours' where tenant_id = '00000000-0000-4000-8000-00000000c801';
select pg_temp.check('a platform "no" (target_not_enabled) holds, even after an hour: not_enabled',
  pg_temp.access_as('00000000-0000-4000-8000-00000000c8a2') ->> 'status' = 'not_enabled');
set local role service_role;
select platform_record_module_status('00000000-0000-4000-8000-00000000c801', 'hr', false, 'target_no_handoff_url');
reset role;
select pg_temp.check('target_no_handoff_url doesn''t turn it off', pg_temp.access_as('00000000-0000-4000-8000-00000000c8a2') ->> 'status' = 'available');
set local role service_role;
select platform_record_module_status('00000000-0000-4000-8000-00000000c801', 'hr', true, null);
reset role;
select pg_temp.check('a "yes": available', pg_temp.access_as('00000000-0000-4000-8000-00000000c8a2') ->> 'status' = 'available');

-- ---------------------------------------------------------------- leave_requests: HR's rows are HR's
select pg_temp.check('while HR leave is on, a teacher can''t file a Schools-only request (42501)',
  pg_temp.try_as('00000000-0000-4000-8000-00000000c8a2', $q$insert into leave_requests (tenant_id, teacher_id, starts_on, ends_on)
     values ('00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c8a2', current_date + 210, current_date + 211)$q$) = '42501');
select pg_temp.check('at a school where it isn''t on, the old form still works',
  pg_temp.try_as('00000000-0000-4000-8000-00000000c8b1', $q$insert into leave_requests (tenant_id, teacher_id, starts_on, ends_on)
     values ('00000000-0000-4000-8000-00000000c802', '00000000-0000-4000-8000-00000000c8b1', current_date + 210, current_date + 211)$q$) = 'ok');
select pg_temp.check('a teacher can''t insert a row as HR''s (42501)',
  pg_temp.try_as('00000000-0000-4000-8000-00000000c8b1', $q$insert into leave_requests (tenant_id, teacher_id, starts_on, ends_on, source, hr_application_id)
     values ('00000000-0000-4000-8000-00000000c802', '00000000-0000-4000-8000-00000000c8b1', current_date + 220, current_date + 221, 'hr', 'forged')$q$) = '42501');
select pg_temp.check('the office can''t either (42501)',
  pg_temp.try_as('00000000-0000-4000-8000-00000000c8a1', $q$insert into leave_requests (tenant_id, teacher_id, starts_on, ends_on, status, source, hr_application_id)
     values ('00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c8a2', current_date + 220, current_date + 221, 'approved', 'hr', 'forged')$q$) = '42501');
select pg_temp.check('nobody signed in can set the export mark on a Schools row (42501)',
  pg_temp.try_as('00000000-0000-4000-8000-00000000c8a1', $q$update leave_requests set hr_exported_at = now() where reason = 'leavecheck old form'$q$) = '42501');
select pg_temp.check('(tenant_id, hr_application_id) is unique',
  exists (select 1 from pg_index i where i.indisunique and i.indrelid = 'public.leave_requests'::regclass
           and (select array_agg(a.attname::text order by a.attname) from pg_attribute a where a.attrelid = i.indrelid and a.attnum = any (i.indkey))
               = array['hr_application_id', 'tenant_id']));
do $$ begin
  insert into leave_requests (tenant_id, teacher_id, starts_on, ends_on, source)
  values ('00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c8a2', current_date + 230, current_date + 231, 'hr');
  raise notice 'FAIL an HR row without its application id: allowed';
exception when check_violation then raise notice 'PASS an HR row must name its application (%)', sqlstate; end $$;

-- ---------------------------------------------------------------- hr.leave.approved
select set_config('t.s', (current_date + 10)::text, true);
select set_config('t.e', (current_date + 11)::text, true);
insert into leave_requests (tenant_id, teacher_id, starts_on, ends_on, reason)
  values ('00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c8a2', current_date + 11, current_date + 12, 'leavecheck waiting');
select set_config('t.audit_before', (select count(*)::text from audit_events where tenant_id = '00000000-0000-4000-8000-00000000c801'), true);

select pg_temp.run(pg_temp.ev('lc-1', 'hr.leave.approved', '00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c8a2', 'lc-app-1',
             current_setting('t.s')::date, current_setting('t.e')::date));
select pg_temp.check('an approval is applied',
  pg_temp.r() ->> 'outcome' = 'approved');
select pg_temp.check('the row is approved, source hr, with its application',
  exists (select 1 from leave_requests where hr_application_id = 'lc-app-1' and status = 'approved' and source = 'hr'
           and teacher_id = '00000000-0000-4000-8000-00000000c8a2' and starts_on = current_setting('t.s')::date and days = 2));
select pg_temp.check('the teacher reads it (as cover planning and their leave list do)',
  pg_temp.try_as('00000000-0000-4000-8000-00000000c8a2', $q$do $d$ begin
    if not exists (select 1 from leave_requests where hr_application_id = 'lc-app-1' and status = 'approved') then raise exception 'not visible'; end if;
  end $d$$q$) = 'ok');
select pg_temp.check('the teacher got the usual notice, from the school''s admin',
  exists (select 1 from announcements where tenant_id = '00000000-0000-4000-8000-00000000c801' and subject = 'Your leave request was approved'
           and audience = jsonb_build_object('kind', 'user', 'user_id', '00000000-0000-4000-8000-00000000c8a2')
           and author_id = '00000000-0000-4000-8000-00000000c8a1' and published_at is not null));
select pg_temp.check('their waiting Schools request for those days gave way',
  (select status from leave_requests where reason = 'leavecheck waiting') = 'cancelled');
select pg_temp.check('one audit line, its own (no generic Leave requests line)',
  (select count(*) from audit_events where tenant_id = '00000000-0000-4000-8000-00000000c801')
    = current_setting('t.audit_before')::int + 1
  and exists (select 1 from audit_events where actor_label = 'Figbloom HR (via Figbloom platform)' and metadata ->> 'application_id' = 'lc-app-1'));
select pg_temp.run(pg_temp.ev('lc-1', 'hr.leave.approved', '00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c8a2', 'lc-app-1',
             current_setting('t.s')::date, current_setting('t.e')::date));
select pg_temp.check('the same delivery again: duplicate',
  pg_temp.r() ->> 'outcome' = 'duplicate');
select pg_temp.run(pg_temp.ev('lc-2', 'hr.leave.approved', '00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c8a2', 'lc-app-1',
             current_setting('t.s')::date, current_setting('t.e')::date));
select pg_temp.check('the same approval in a new delivery: already_approved, no second notice',
  pg_temp.r() ->> 'outcome' = 'already_approved'
  and (select count(*) from announcements where subject = 'Your leave request was approved'
        and audience ->> 'user_id' = '00000000-0000-4000-8000-00000000c8a2') = 1);
select pg_temp.check('nobody signed in can change it, not even the office (42501)',
  pg_temp.try_as('00000000-0000-4000-8000-00000000c8a1', $q$update leave_requests set status = 'rejected' where hr_application_id = 'lc-app-1'$q$) = '42501');
select pg_temp.run(pg_temp.ev('lc-3', 'hr.leave.approved', '00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c8a2', 'lc-app-2',
             current_setting('t.e')::date, current_setting('t.e')::date + 1));
select pg_temp.check('another approved application on those days: overlaps, and not recorded',
  pg_temp.r() ->> 'outcome' = 'overlaps'
  and not exists (select 1 from platform_event_deliveries where delivery_id = 'lc-3')
  and not exists (select 1 from leave_requests where hr_application_id = 'lc-app-2'));
select pg_temp.run(pg_temp.ev('lc-4', 'hr.leave.approved', '00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c8b1', 'lc-app-9',
             current_date + 50, current_date + 51));
select pg_temp.check('another school''s person: tenant_mismatch, nothing recorded',
  pg_temp.r() ->> 'outcome' = 'tenant_mismatch'
  and not exists (select 1 from platform_event_deliveries where delivery_id = 'lc-4'));

-- ---------------------------------------------------------------- a date change, both orders; staleness
select pg_temp.run(pg_temp.ev('lc-5', 'hr.leave.approved', '00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c8a2', 'lc-app-1',
             current_setting('t.s')::date + 7, current_setting('t.e')::date + 7, now() + interval '1 minute'));
select pg_temp.check('new dates first (approved new)',
  pg_temp.r() ->> 'outcome' = 'updated');
select pg_temp.run(pg_temp.ev('lc-6', 'hr.leave.cancelled', '00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c8a2', 'lc-app-1',
             current_setting('t.s')::date, current_setting('t.e')::date, now() + interval '1 minute'));
select pg_temp.check('then the cancel of the old dates: stale, the row keeps the new dates',
  pg_temp.r() ->> 'outcome' = 'stale'
  and (select status = 'approved' and starts_on = current_setting('t.s')::date + 7 from leave_requests where hr_application_id = 'lc-app-1'));
select pg_temp.run(pg_temp.ev('lc-7', 'hr.leave.approved', '00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c8a2', 'lc-app-1',
             current_setting('t.s')::date, current_setting('t.e')::date, now() - interval '1 day'));
select pg_temp.check('an event older than the last one applied: stale',
  pg_temp.r() ->> 'outcome' = 'stale');

-- ---------------------------------------------------------------- hr.leave.cancelled: the cover ahead
insert into coverage_assignments (tenant_id, date, class_id, subject_id, start_time, absent_teacher_id, covering_teacher_id, assigned_by) values
  ('00000000-0000-4000-8000-00000000c801', current_setting('t.s')::date + 7, '00000000-0000-4000-8000-00000000c8c1', '00000000-0000-4000-8000-00000000c8d1',
   '08:00', '00000000-0000-4000-8000-00000000c8a2', '00000000-0000-4000-8000-00000000c8a7', '00000000-0000-4000-8000-00000000c8a1');
select pg_temp.run(pg_temp.ev('lc-8', 'hr.leave.cancelled', '00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c8a2', 'lc-app-1',
             current_setting('t.s')::date + 7, current_setting('t.e')::date + 7, now() + interval '2 minutes'));
select pg_temp.check('the cancel of the current dates is applied',
  pg_temp.r() ->> 'outcome' = 'cancelled'
  and (select status from leave_requests where hr_application_id = 'lc-app-1') = 'cancelled');
select pg_temp.check('the cover ahead is undone and the substitute told',
  not exists (select 1 from coverage_assignments where absent_teacher_id = '00000000-0000-4000-8000-00000000c8a2')
  and exists (select 1 from announcements where subject like 'Cover cancelled%' and audience ->> 'user_id' = '00000000-0000-4000-8000-00000000c8a7'));
select pg_temp.check('the teacher told it was cancelled',
  exists (select 1 from announcements where subject = 'Your leave was cancelled' and audience ->> 'user_id' = '00000000-0000-4000-8000-00000000c8a2'));
select pg_temp.run(pg_temp.ev('lc-9', 'hr.leave.cancelled', '00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c8a2', 'lc-app-3',
             current_date + 60, current_date + 61));
select pg_temp.check('a cancel Schools never saw approved is kept as cancelled',
  pg_temp.r() ->> 'outcome' = 'cancelled_unseen'
  and (select status from leave_requests where hr_application_id = 'lc-app-3') = 'cancelled');

-- ---------------------------------------------------------------- the switch
update platform_settings set value = 'false', updated_at = now() where key = 'HR_LEAVE_ENABLED';
select pg_temp.run(pg_temp.ev('lc-10', 'hr.leave.approved', '00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c8a2', 'lc-app-4',
             current_date + 80, current_date + 81));
select pg_temp.check('HR_LEAVE_ENABLED off: recorded as not_enabled, nothing applied',
  pg_temp.r() ->> 'outcome' = 'not_enabled'
  and not exists (select 1 from leave_requests where hr_application_id = 'lc-app-4')
  and (select outcome from platform_event_deliveries where delivery_id = 'lc-10') = 'not_enabled');
select pg_temp.run(pg_temp.ev('lc-11', 'hr.leave.approved', '00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c8a2', 'lc-app-5',
             current_date + 90, current_date + 91, now(), false));
select pg_temp.check('p_apply false (PLATFORM_EVENTS_ENABLED off): the same',
  pg_temp.r() ->> 'outcome' = 'not_enabled');

-- ---------------------------------------------------------------- the history export
insert into leave_requests (id, tenant_id, teacher_id, starts_on, ends_on, status, reviewed_at, reason) values
  ('00000000-0000-4000-8000-00000000c8e1', '00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c8a3', '2026-03-02', '2026-03-06', 'approved', now(), 'leavecheck history'),
  ('00000000-0000-4000-8000-00000000c8e2', '00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c8a5', '2026-04-01', '2026-04-01', 'approved', now(), 'leavecheck history'),
  ('00000000-0000-4000-8000-00000000c8e3', '00000000-0000-4000-8000-00000000c801', '00000000-0000-4000-8000-00000000c8a3', '2026-05-04', '2026-05-05', 'rejected', now(), 'leavecheck history');
insert into platform_sync_queue (kind, local_id, tenant_id, event, event_id, occurred_at, done_at, version) values
  ('staff', '00000000-0000-4000-8000-00000000c8a3', '00000000-0000-4000-8000-00000000c801', 'created', gen_random_uuid(), now(), now(), 1);
set local role service_role;
select set_config('t.hist', platform_leave_history('00000000-0000-4000-8000-00000000c801')::text, true);
reset role;
select pg_temp.check('the export lists approved Schools leave of staff HR knows, with weekdays as days',
  (select jsonb_agg(r ->> 'source_id') from jsonb_array_elements(current_setting('t.hist')::jsonb -> 'records') r)
    = '["00000000-0000-4000-8000-00000000c8e1"]'::jsonb
  and (current_setting('t.hist')::jsonb -> 'records' -> 0 ->> 'days')::int = 5
  and current_setting('t.hist')::jsonb -> 'records' -> 0 ->> 'leave_type_name' = 'Imported from Schools');
select pg_temp.check('staff HR doesn''t know yet are listed as not linked',
  exists (select 1 from jsonb_array_elements(current_setting('t.hist')::jsonb -> 'not_linked') r
           where r ->> 'source_id' = '00000000-0000-4000-8000-00000000c8e2'));
set local role service_role;
select pg_temp.check('marking: only the school''s own Schools rows, once',
  platform_leave_history_mark('00000000-0000-4000-8000-00000000c801',
    array['00000000-0000-4000-8000-00000000c8e1', (select id from leave_requests where hr_application_id = 'lc-app-3')]::uuid[]) = 1
  and platform_leave_history_mark('00000000-0000-4000-8000-00000000c801', array['00000000-0000-4000-8000-00000000c8e1']::uuid[]) = 0
  and platform_leave_history_mark('00000000-0000-4000-8000-00000000c802', array['00000000-0000-4000-8000-00000000c8e2']::uuid[]) = 0);
select pg_temp.check('a second listing has nothing left to send',
  jsonb_array_length(platform_leave_history('00000000-0000-4000-8000-00000000c801') -> 'records') = 0);
reset role;

rollback;
