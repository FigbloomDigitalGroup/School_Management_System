-- Schools + HR phase 1 checks for 20261105600000_platform_staff_events.
--
-- Runs against a local database that has the migrations applied, inside one transaction that is rolled back.
-- It makes its own school and people, so it needs no seed. Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/platform_staff_events.sql
--
-- What it shows: hiring, renaming, re-titling, re-roling, a new real email, archiving, restoring and removing a
-- teacher, driver, other staff member or school admin queue one staff event in the outbox, merged while pending,
-- with a new event id for every change; parents, learners and unrelated edits queue nothing; a synthetic login
-- address is no email; the old platform_sync_claim(int) never hands out staff rows; archiving bans the login and
-- restoring lifts it (and reactivating a suspended school does not); nobody archives themselves with a plain
-- update; hr.employee.left is applied once, only to a profile of the school the delivery names, never echoed back,
-- and only once PLATFORM_EVENTS_ENABLED is on; the staff backfill lists or queues the school's current staff;
-- sending is gated by PLATFORM_STAFF_EVENTS_ENABLED and by the school being registered on the platform; a 404 ends a row as
-- skipped_unlinked; and only the service role can run the platform side.

\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------- fixtures (as postgres)
create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when coalesce(ok, false) then 'PASS' else 'FAIL' end, label; end $$;
create function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.staff_row(p_id uuid) returns platform_sync_queue language sql as $$
  select * from platform_sync_queue where kind = 'staff' and local_id = p_id and done_at is null
$$;
create function pg_temp.pending(p_id uuid) returns bigint language sql as $$
  select count(*) from platform_sync_queue where kind = 'staff' and local_id = p_id and done_at is null
$$;
create function pg_temp.flush() returns void language sql as $$
  update platform_sync_queue set done_at = now() where done_at is null
$$;
create function pg_temp.person(p_id uuid, p_tenant uuid, p_role app_role, p_name text, p_email text default null) returns void
language sql as $$
  insert into auth.users (id, email) values (p_id, coalesce(p_email, p_id::text || '@login.staffcheck.figbloom.internal'));
  insert into profiles (id, tenant_id, role, full_name, email) values (p_id, p_tenant, p_role, p_name, p_email);
$$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

delete from platform_sync_queue;
insert into tenants (id, name, slug, county) values
  ('00000000-0000-4000-8000-00000000f001', 'Staff Check School', 'staffcheck-a-' || substr(md5(random()::text), 1, 8), 'Nairobi'),
  ('00000000-0000-4000-8000-00000000f002', 'Staff Check Other School', 'staffcheck-b-' || substr(md5(random()::text), 1, 8), 'Nairobi');
select pg_temp.flush();   -- the schools' own registration rows

-- ---------------------------------------------------------------- who may run it
select pg_temp.check('anon and authenticated can''t run the platform side',
  not has_function_privilege('authenticated', 'platform_staff_enqueue(uuid, text, uuid, date)', 'execute')
  and not has_function_privilege('authenticated', 'platform_staff_left(text, text, uuid, uuid, date, text, boolean)', 'execute')
  and not has_function_privilege('authenticated', 'platform_staff_backfill(uuid, boolean)', 'execute')
  and not has_function_privilege('authenticated', 'platform_staff_event_data(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'platform_sync_claim_kinds(int, text[])', 'execute')
  and not has_function_privilege('authenticated', 'platform_events_enabled()', 'execute')
  and not has_function_privilege('anon', 'platform_staff_left(text, text, uuid, uuid, date, text, boolean)', 'execute')
  and not has_function_privilege('authenticated', 'set_staff_login_ban(uuid[], boolean)', 'execute')
  and not has_table_privilege('authenticated', 'platform_event_deliveries', 'select'));
select pg_temp.check('the service role can',
  has_function_privilege('service_role', 'platform_staff_left(text, text, uuid, uuid, date, text, boolean)', 'execute')
  and has_function_privilege('service_role', 'platform_sync_claim_kinds(int, text[])', 'execute')
  and has_function_privilege('service_role', 'platform_staff_backfill(uuid, boolean)', 'execute'));
select pg_temp.check('a school''s own staff can run archive_staff and restore_staff (it checks who they are)',
  has_function_privilege('authenticated', 'archive_staff(uuid[], date)', 'execute')
  and not has_function_privilege('anon', 'archive_staff(uuid[], date)', 'execute'));
select pg_temp.check('PLATFORM_EVENTS_ENABLED is off by default', not platform_events_enabled());
select pg_temp.check('PLATFORM_STAFF_EVENTS_ENABLED (sending) is off by default', not platform_staff_events_enabled());

-- ---------------------------------------------------------------- the two gates on sending
select pg_temp.person('00000000-0000-4000-8000-00000000f0c1', '00000000-0000-4000-8000-00000000f001', 'teacher', 'Hired While Off');
select pg_temp.check('sending switched off: a new teacher queues nothing',
  pg_temp.pending('00000000-0000-4000-8000-00000000f0c1') = 0);
set local role service_role;
select pg_temp.check('switched off: the staff backfill dry run still lists, and says why it can''t run',
  (select (d ->> 'count')::int >= 1 and not (d ->> 'sending_enabled')::boolean and not (d ->> 'school_linked')::boolean
     from platform_staff_backfill('00000000-0000-4000-8000-00000000f001', true) d));
do $$ begin
  perform platform_staff_backfill('00000000-0000-4000-8000-00000000f001', false);
  raise notice 'FAIL the staff backfill runs for real while sending is switched off';
exception when others then
  raise notice '% the staff backfill for real is refused while sending is switched off',
    case when sqlerrm like 'staff_events_disabled:%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
end $$;
reset role;

update platform_settings set value = 'true' where key = 'PLATFORM_STAFF_EVENTS_ENABLED';
update profiles set full_name = 'Hired While Off 2' where id = '00000000-0000-4000-8000-00000000f0c1';
select pg_temp.check('switched on, but the platform doesn''t know the school (registration not delivered): nothing queued',
  pg_temp.pending('00000000-0000-4000-8000-00000000f0c1') = 0);
set local role service_role;
do $$ begin
  perform platform_staff_backfill('00000000-0000-4000-8000-00000000f001', false);
  raise notice 'FAIL the staff backfill runs for real for a school the platform doesn''t know';
exception when others then
  raise notice '% the staff backfill for real is refused for a school the platform doesn''t know',
    case when sqlerrm like 'school_not_linked:%' then 'PASS' else 'FAIL (' || sqlerrm || ')' end;
end $$;
reset role;
delete from profiles where id = '00000000-0000-4000-8000-00000000f0c1';
delete from auth.users where id = '00000000-0000-4000-8000-00000000f0c1';

-- from here on: sending on, and both schools' registrations delivered
select platform_record_link('tenant', '00000000-0000-4000-8000-00000000f001', 'platform-school-1');
select platform_record_link('tenant', '00000000-0000-4000-8000-00000000f002', 'platform-school-2');
select pg_temp.flush();

-- ---------------------------------------------------------------- the triggers fill the queue
select pg_temp.person('00000000-0000-4000-8000-00000000f0a1', '00000000-0000-4000-8000-00000000f001', 'school_admin', 'Check Head', 'head@staffcheck.ac.ke');
select pg_temp.person('00000000-0000-4000-8000-00000000f0a2', '00000000-0000-4000-8000-00000000f001', 'teacher', 'Check Teacher');
select pg_temp.person('00000000-0000-4000-8000-00000000f0a3', '00000000-0000-4000-8000-00000000f001', 'driver', 'Check Driver');
select pg_temp.person('00000000-0000-4000-8000-00000000f0a4', '00000000-0000-4000-8000-00000000f001', 'staff', 'Check Bursar');
select pg_temp.person('00000000-0000-4000-8000-00000000f0a5', '00000000-0000-4000-8000-00000000f001', 'parent', 'Check Parent');
select pg_temp.person('00000000-0000-4000-8000-00000000f0a6', '00000000-0000-4000-8000-00000000f001', 'student', 'Check Learner');
select pg_temp.person('00000000-0000-4000-8000-00000000f0b1', '00000000-0000-4000-8000-00000000f002', 'teacher', 'Other School Teacher');

select pg_temp.check('a new school admin, teacher, driver and other staff member are each queued as created',
  (select count(*) from platform_sync_queue
    where kind = 'staff' and done_at is null and event = 'created' and event_id is not null and occurred_at is not null
      and tenant_id = '00000000-0000-4000-8000-00000000f001'
      and local_id in ('00000000-0000-4000-8000-00000000f0a1', '00000000-0000-4000-8000-00000000f0a2',
                       '00000000-0000-4000-8000-00000000f0a3', '00000000-0000-4000-8000-00000000f0a4')) = 4);
select pg_temp.check('a parent and a learner are not staff: nothing queued',
  pg_temp.pending('00000000-0000-4000-8000-00000000f0a5') = 0 and pg_temp.pending('00000000-0000-4000-8000-00000000f0a6') = 0);
select pg_temp.check('every queued row has its own event id',
  (select count(distinct event_id) = count(*) from platform_sync_queue where kind = 'staff'));

select set_config('t.first_id', (pg_temp.staff_row('00000000-0000-4000-8000-00000000f0a2')).event_id::text, true);
update profiles set full_name = 'Check Teacher Renamed' where id = '00000000-0000-4000-8000-00000000f0a2';
select pg_temp.check('a rename while still pending: one row, still created, a new version and a new event id',
  pg_temp.pending('00000000-0000-4000-8000-00000000f0a2') = 1
  and (pg_temp.staff_row('00000000-0000-4000-8000-00000000f0a2')).event = 'created'
  and (pg_temp.staff_row('00000000-0000-4000-8000-00000000f0a2')).version = 2
  and (pg_temp.staff_row('00000000-0000-4000-8000-00000000f0a2')).event_id::text <> current_setting('t.first_id'));

select pg_temp.flush();
update profiles set phone = '+254700000001' where id = '00000000-0000-4000-8000-00000000f0a2';
select pg_temp.check('once sent, a phone change is an update',
  (pg_temp.staff_row('00000000-0000-4000-8000-00000000f0a2')).event = 'updated');
select pg_temp.flush();
update profiles set staff_title = 'Head of Science' where id = '00000000-0000-4000-8000-00000000f0a2';
select pg_temp.check('a new title is an update', (pg_temp.staff_row('00000000-0000-4000-8000-00000000f0a2')).event = 'updated');
select pg_temp.flush();
update profiles set role = 'staff' where id = '00000000-0000-4000-8000-00000000f0a3';
select pg_temp.check('a new staff role is an update', (pg_temp.staff_row('00000000-0000-4000-8000-00000000f0a3')).event = 'updated');
select pg_temp.flush();

update profiles set avatar_url = 'x/avatars/staff.png', login_id = 'TC-9901' where id = '00000000-0000-4000-8000-00000000f0a2';
select pg_temp.check('an unrelated edit (photo, login ID) queues nothing', pg_temp.pending('00000000-0000-4000-8000-00000000f0a2') = 0);
update profiles set email = 'tc-9901@login.staffcheck.figbloom.internal' where id = '00000000-0000-4000-8000-00000000f0a2';
select pg_temp.check('a synthetic login address is no email: setting one queues nothing',
  pg_temp.pending('00000000-0000-4000-8000-00000000f0a2') = 0);
update profiles set email = 'Teacher@StaffCheck.ac.ke' where id = '00000000-0000-4000-8000-00000000f0a2';
select pg_temp.check('a real email is an update', (pg_temp.staff_row('00000000-0000-4000-8000-00000000f0a2')).event = 'updated');
select pg_temp.flush();
update profiles set full_name = 'Parent Renamed' where id = '00000000-0000-4000-8000-00000000f0a5';
select pg_temp.check('renaming a parent queues nothing', pg_temp.pending('00000000-0000-4000-8000-00000000f0a5') = 0);

-- ---------------------------------------------------------------- what is sent
select pg_temp.check('created/updated data: person_id, full_name, phone, email (real, lower case), role, job_title (the title)',
  (select platform_staff_event_data('00000000-0000-4000-8000-00000000f0a2') -> 'data')
  = jsonb_build_object('person_id', '00000000-0000-4000-8000-00000000f0a2', 'full_name', 'Check Teacher Renamed',
                       'phone', '+254700000001', 'email', 'teacher@staffcheck.ac.ke', 'role', 'teacher', 'job_title', 'Head of Science'));
select pg_temp.check('a synthetic address (in the profile and the login) is sent as email null; no title: the role''s name',
  (select d -> 'data' ->> 'email' is null and d -> 'data' ->> 'job_title' = 'Staff' and d -> 'data' ? 'email' and (d ->> 'current')::boolean
     from platform_staff_event_data('00000000-0000-4000-8000-00000000f0a4') d));
select pg_temp.check('platform_real_email: synthetic, blank and malformed are null',
  platform_real_email('ad-0001@login.alliance.figbloom.internal') is null and platform_real_email('  ') is null
  and platform_real_email('not-an-email') is null and platform_real_email(' Head@School.AC.KE ') = 'head@school.ac.ke');

-- ---------------------------------------------------------------- the queue hands staff out last, and only to the new sender
select pg_temp.flush();
update profiles set full_name = 'Check Head 2' where id = '00000000-0000-4000-8000-00000000f0a1';   -- queued first
update tenants set name = name || ' ' where id = '00000000-0000-4000-8000-00000000f001';
set local role service_role;
select pg_temp.check('the old platform_sync_claim(int) never hands out a staff row',
  (select array_agg(kind) from platform_sync_claim(10)) = array['tenant']);
update platform_sync_queue set locked_until = null where done_at is null;
select set_config('t.first_kind', (select kind from platform_sync_claim_kinds(1, array['organization', 'tenant', 'staff'])), true);
select set_config('t.staff_claim', (select json_build_object('id', id, 'kind', kind, 'version', version)::text
                                      from platform_sync_claim_kinds(10, array['organization', 'tenant', 'staff'])), true);
reset role;
select pg_temp.check('platform_sync_claim_kinds hands out the school first, then the staff event',
  current_setting('t.first_kind') = 'tenant' and current_setting('t.staff_claim')::json ->> 'kind' = 'staff');
update profiles set full_name = 'Check Head 3' where id = '00000000-0000-4000-8000-00000000f0a1';   -- while on its way
set local role service_role;
select pg_temp.check('completing a staff event whose person changed meanwhile answers false',
  not platform_sync_done((current_setting('t.staff_claim')::json ->> 'id')::bigint, (current_setting('t.staff_claim')::json ->> 'version')::int, null));
reset role;
select pg_temp.check('...and it goes again, due now, with a new event id',
  (select done_at is null and locked_until is null and next_attempt_at <= now() and version = 2 and event = 'updated'
     from platform_sync_queue where id = (current_setting('t.staff_claim')::json ->> 'id')::bigint));
select pg_temp.check('staff events leave no platform_links row',
  not exists (select 1 from platform_links where local_id = '00000000-0000-4000-8000-00000000f0a1'));
select pg_temp.flush();

-- ---------------------------------------------------------------- archiving and restoring (the school's own)
select pg_temp.act_as('00000000-0000-4000-8000-00000000f0a2'); set local role authenticated;
do $$ begin
  update profiles set archived_at = now() where id = '00000000-0000-4000-8000-00000000f0a2';
  raise notice 'FAIL a teacher can archive themselves with a plain update';
exception when insufficient_privilege then raise notice 'PASS a teacher can''t archive themselves with a plain update';
end $$;
reset role;

insert into auth.sessions (id, user_id) values (gen_random_uuid(), '00000000-0000-4000-8000-00000000f0a2');
select pg_temp.act_as('00000000-0000-4000-8000-00000000f0a1'); set local role authenticated;
do $$ begin
  perform archive_staff(array['00000000-0000-4000-8000-00000000f0a1']::uuid[]);
  raise notice 'FAIL an admin can archive themselves';
exception when insufficient_privilege then raise notice 'PASS an admin can''t archive themselves';
end $$;
do $$ begin
  perform archive_staff(array['00000000-0000-4000-8000-00000000f0b1']::uuid[]);
  raise notice 'FAIL an admin can archive another school''s teacher';
exception when insufficient_privilege then raise notice 'PASS an admin can''t archive another school''s teacher';
end $$;
select pg_temp.check('the school admin archives a teacher', archive_staff(array['00000000-0000-4000-8000-00000000f0a2']::uuid[], '2026-11-30') = 1);
reset role;
select pg_temp.check('archived: schools.staff.left queued with left_on',
  (pg_temp.staff_row('00000000-0000-4000-8000-00000000f0a2')).event = 'left'
  and (pg_temp.staff_row('00000000-0000-4000-8000-00000000f0a2')).left_on = '2026-11-30');
select pg_temp.check('...the login is banned and its sessions ended, with an audit event',
  (select banned_until > now() + interval '50 years' and raw_app_meta_data ->> 'archived_staff' = 'true' from auth.users where id = '00000000-0000-4000-8000-00000000f0a2')
  and not exists (select 1 from auth.sessions where user_id = '00000000-0000-4000-8000-00000000f0a2')
  and exists (select 1 from audit_events where tenant_id = '00000000-0000-4000-8000-00000000f001' and event = '1 staff member archived'));
select pg_temp.check('...and a later rename of the archived teacher queues no update',
  (select (pg_temp.staff_row('00000000-0000-4000-8000-00000000f0a2')).version) = 1);
update profiles set full_name = 'Archived Teacher' where id = '00000000-0000-4000-8000-00000000f0a2';
select pg_temp.check('(still one left row, unchanged)',
  (pg_temp.staff_row('00000000-0000-4000-8000-00000000f0a2')).event = 'left'
  and (pg_temp.staff_row('00000000-0000-4000-8000-00000000f0a2')).version = 1);

-- reactivating a suspended school keeps the archived teacher's ban
update tenants set status = 'suspended' where id = '00000000-0000-4000-8000-00000000f001';
update tenants set status = 'active' where id = '00000000-0000-4000-8000-00000000f001';
select pg_temp.check('reactivating a suspended school does not lift an archived staff member''s ban',
  (select banned_until > now() from auth.users where id = '00000000-0000-4000-8000-00000000f0a2')
  and (select banned_until is null from auth.users where id = '00000000-0000-4000-8000-00000000f0a3'));

select pg_temp.act_as('00000000-0000-4000-8000-00000000f0a1'); set local role authenticated;
select pg_temp.check('the school admin restores them', restore_staff(array['00000000-0000-4000-8000-00000000f0a2']::uuid[]) = 1);
reset role;
select pg_temp.check('restored before left was sent: one row, created again (HR upserts), the ban lifted',
  pg_temp.pending('00000000-0000-4000-8000-00000000f0a2') = 1
  and (pg_temp.staff_row('00000000-0000-4000-8000-00000000f0a2')).event = 'created'
  and (pg_temp.staff_row('00000000-0000-4000-8000-00000000f0a2')).left_on is null
  and (select banned_until is null and not (raw_app_meta_data ? 'archived_staff') from auth.users where id = '00000000-0000-4000-8000-00000000f0a2'));
select pg_temp.flush();

-- removed outright (delete-account): left
delete from profiles where id = '00000000-0000-4000-8000-00000000f0a4';
select pg_temp.check('removing a staff member queues left (the row keeps the school)',
  (pg_temp.staff_row('00000000-0000-4000-8000-00000000f0a4')).event = 'left'
  and (pg_temp.staff_row('00000000-0000-4000-8000-00000000f0a4')).tenant_id = '00000000-0000-4000-8000-00000000f001'
  and (pg_temp.staff_row('00000000-0000-4000-8000-00000000f0a4')).left_on is not null);
select pg_temp.flush();

-- ---------------------------------------------------------------- the staff backfill
set local role service_role;
select set_config('t.dry', platform_staff_backfill('00000000-0000-4000-8000-00000000f001', true)::text, true);
reset role;
select pg_temp.check('dry run: lists the school''s three current staff, queues nothing',
  (current_setting('t.dry')::jsonb ->> 'count')::int = 3
  and (select count(*) from platform_sync_queue where kind = 'staff' and done_at is null) = 0
  and not (current_setting('t.dry')::jsonb -> 'staff') @> '[{"person_id": "00000000-0000-4000-8000-00000000f0a5"}]');
set local role service_role;
select platform_staff_backfill('00000000-0000-4000-8000-00000000f001', false);
reset role;
select pg_temp.check('for real: each current staff member queued as created, nobody else',
  (select count(*) from platform_sync_queue where kind = 'staff' and done_at is null and event = 'created'
     and tenant_id = '00000000-0000-4000-8000-00000000f001') = 3
  and pg_temp.pending('00000000-0000-4000-8000-00000000f0b1') = 0);
select pg_temp.flush();

-- ---------------------------------------------------------------- hr.employee.left
set local role service_role;
select pg_temp.check('switched off: acknowledged and recorded, not applied',
  platform_staff_left('dl-1', 'ev-1', '00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000f0a3', '2026-12-01', 'EMP-7', false) ->> 'outcome' = 'not_enabled');
select pg_temp.check('...a repeat of that delivery is a duplicate',
  platform_staff_left('dl-1', 'ev-1', '00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000f0a3', '2026-12-01', 'EMP-7', true) ->> 'outcome' = 'duplicate');
reset role;
select pg_temp.check('...and the driver is untouched',
  (select archived_at is null from profiles where id = '00000000-0000-4000-8000-00000000f0a3'));

set local role service_role;
select pg_temp.check('another school''s delivery for this person is refused (tenant_mismatch)',
  platform_staff_left('dl-2', 'ev-2', '00000000-0000-4000-8000-00000000f002', '00000000-0000-4000-8000-00000000f0a3', '2026-12-01', 'EMP-7') ->> 'outcome' = 'tenant_mismatch');
select pg_temp.check('a person Schools doesn''t have: not_found; a parent: not_staff',
  platform_staff_left('dl-3', 'ev-3', '00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000ffff', null) ->> 'outcome' = 'not_found'
  and platform_staff_left('dl-4', 'ev-4', '00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000f0a5', null) ->> 'outcome' = 'not_staff');
reset role;
select pg_temp.check('rejections change nothing and are not recorded (a re-drive is looked at afresh)',
  (select archived_at is null from profiles where id = '00000000-0000-4000-8000-00000000f0a3')
  and not exists (select 1 from platform_event_deliveries where delivery_id in ('dl-2', 'dl-3', 'dl-4')));

set local role service_role;
select pg_temp.check('the right school: archived',
  platform_staff_left('dl-5', 'ev-5', '00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000f0a3', '2026-12-01', 'EMP-7') ->> 'outcome' = 'archived');
reset role;
select pg_temp.check('...archived with HR''s date, the login banned, an audit event naming HR',
  (select archived_at is not null and left_on = '2026-12-01' and archived_by is null from profiles where id = '00000000-0000-4000-8000-00000000f0a3')
  and (select banned_until > now() and raw_app_meta_data ->> 'archived_staff' = 'true' from auth.users where id = '00000000-0000-4000-8000-00000000f0a3')
  and exists (select 1 from audit_events where tenant_id = '00000000-0000-4000-8000-00000000f001'
                and actor_label = 'Figbloom HR (via Figbloom platform)' and metadata ->> 'employee_number' = 'EMP-7'));
select pg_temp.check('...and not echoed back to HR as schools.staff.left',
  pg_temp.pending('00000000-0000-4000-8000-00000000f0a3') = 0);
set local role service_role;
select pg_temp.check('the same delivery again: duplicate',
  platform_staff_left('dl-5', 'ev-5', '00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000f0a3', '2026-12-01', 'EMP-7') ->> 'outcome' = 'duplicate');
select pg_temp.check('a new delivery for someone already archived: already_archived',
  platform_staff_left('dl-6', 'ev-6', '00000000-0000-4000-8000-00000000f001', '00000000-0000-4000-8000-00000000f0a3', '2026-12-01', 'EMP-7') ->> 'outcome' = 'already_archived');
reset role;
select pg_temp.check('deliveries recorded with their outcomes',
  (select array_agg(delivery_id || ':' || outcome order by delivery_id) from platform_event_deliveries where delivery_id like 'dl-%')
  = array['dl-1:not_enabled', 'dl-5:archived', 'dl-6:already_archived']);

-- ---------------------------------------------------------------- a 404 from the platform ends the row
select pg_temp.flush();
update profiles set full_name = 'Check Head 404' where id = '00000000-0000-4000-8000-00000000f0a1';
set local role service_role;
select platform_sync_skipped((pg_temp.staff_row('00000000-0000-4000-8000-00000000f0a1')).id, 'skipped_unlinked');
reset role;
select pg_temp.check('skipped_unlinked: done, not due again, the reason kept',
  pg_temp.pending('00000000-0000-4000-8000-00000000f0a1') = 0
  and exists (select 1 from platform_sync_queue where kind = 'staff' and local_id = '00000000-0000-4000-8000-00000000f0a1'
                and skipped = 'skipped_unlinked' and done_at is not null));
select pg_temp.check('...and only the service role may skip a row',
  not has_function_privilege('authenticated', 'platform_sync_skipped(bigint, text)', 'execute')
  and has_function_privilege('service_role', 'platform_sync_skipped(bigint, text)', 'execute'));

-- ---------------------------------------------------------------- the console's admins (20261105610000)
select pg_temp.person('00000000-0000-4000-8000-00000000f0d1', '00000000-0000-4000-8000-00000000f001', 'school_admin', 'Synthetic Admin');
select pg_temp.person('00000000-0000-4000-8000-00000000f0d2', '00000000-0000-4000-8000-00000000f001', 'school_admin', 'Archived Admin', 'gone@staffcheck.ac.ke');
select set_config('figbloom.staff_archive', 'true', true);   -- as the archive functions do
update profiles set archived_at = now() where id = '00000000-0000-4000-8000-00000000f0d2';
select set_config('figbloom.staff_archive', '', true);
select pg_temp.person('00000000-0000-4000-8000-00000000f0d3', '00000000-0000-4000-8000-00000000f001', 'school_admin', 'Login Mailbox Admin');
update auth.users set email = 'Deputy@StaffCheck.ac.ke' where id = '00000000-0000-4000-8000-00000000f0d3';
set local role service_role;
select set_config('t.console', (platform_console_schools('00000000-0000-4000-8000-00000000f001') -> 0)::text, true);
reset role;
select pg_temp.check('console list: admins are the current school admins with a real email (the login''s counts), oldest first',
  current_setting('t.console')::jsonb -> 'admins' = jsonb_build_array(
    jsonb_build_object('email', 'head@staffcheck.ac.ke', 'name', (select full_name from profiles where id = '00000000-0000-4000-8000-00000000f0a1'), 'role', 'school_admin'),
    jsonb_build_object('email', 'deputy@staffcheck.ac.ke', 'name', 'Login Mailbox Admin', 'role', 'school_admin')));
select pg_temp.check('...and admin_email is as before',
  current_setting('t.console')::jsonb ->> 'admin_email' = 'head@staffcheck.ac.ke');
set local role service_role;
select pg_temp.check('a school with no admin: admins is an empty list',
  platform_console_schools('00000000-0000-4000-8000-00000000f002') -> 0 -> 'admins' = '[]'::jsonb);
reset role;

-- archived_by is a same-school reference (20261105620000)
do $$ begin
  perform set_config('figbloom.staff_archive', 'true', true);
  update profiles set archived_at = now(), archived_by = '00000000-0000-4000-8000-00000000f0b1' where id = '00000000-0000-4000-8000-00000000f0a3';
  raise notice 'FAIL archived_by may name another school''s teacher';
exception when insufficient_privilege then raise notice 'PASS archived_by may not name another school''s teacher';
end $$;
select set_config('figbloom.staff_archive', '', true);

-- switched off again: nothing more is queued
update platform_settings set value = 'false' where key = 'PLATFORM_STAFF_EVENTS_ENABLED';
update profiles set full_name = 'Check Head Off Again' where id = '00000000-0000-4000-8000-00000000f0a1';
select pg_temp.check('switched off again: a rename queues nothing', pg_temp.pending('00000000-0000-4000-8000-00000000f0a1') = 0);

rollback;
