-- "Request Figbloom HR" checks for 20261124100000_hr_request.
--
-- Runs against a local database that has the migrations applied, inside one transaction that is rolled back.
-- It makes its own schools and people, so it needs no seed. Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/hr_request.sql
--
-- What it shows: only the service role (open-hr, after it has checked the caller with hr_handoff_status) records a
-- request; the first request is kept (who and when) and asking again answers its time; nobody signed in can set or
-- clear the request on their school directly, not even its admin; the console's school list carries hr_requested_at
-- (ISO, UTC, seconds; null when never asked) and not who asked; a requester's profile going away keeps the request.

\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------- fixtures (as postgres)
create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when coalesce(ok, false) then 'PASS' else 'FAIL' end, label; end $$;
create function pg_temp.person(p_id uuid, p_tenant uuid, p_role app_role, p_name text) returns void
language sql as $$
  insert into auth.users (id, email) values (p_id, p_id::text || '@login.hrreq.figbloom.internal');
  insert into profiles (id, tenant_id, role, full_name) values (p_id, p_tenant, p_role, p_name);
$$;
-- as this signed-in person, with the authenticated role: how many rows an update of the request columns on their
-- school touched ('error <sqlstate>' when it was refused outright)
create function pg_temp.update_as(uid uuid, p_tenant uuid) returns text language plpgsql as $$
declare n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    update tenants set hr_requested_at = now() - interval '30 days', hr_requested_by = uid where id = p_tenant;
    get diagnostics n = row_count;
  exception when others then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    return 'error ' || sqlstate;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return n::text;
end $$;
-- the same person calling the recorder directly ('denied' when they may not)
create function pg_temp.record_as(uid uuid, p_tenant uuid) returns text language plpgsql as $$
declare v timestamptz;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    v := platform_record_hr_request(p_tenant, uid);
  exception when insufficient_privilege then
    reset role;
    perform set_config('request.jwt.claims', '', true);
    return 'denied';
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return coalesce(v::text, 'null');
end $$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

insert into organizations (id, name, slug, kind, status) values
  ('00000000-0000-4000-8000-00000000b7f1', 'HR Request Group', 'hrreq-group-' || substr(md5(random()::text), 1, 8), 'group_owner', 'active');
insert into tenants (id, name, slug, county, organization_id) values
  ('00000000-0000-4000-8000-00000000b701', 'HR Request School', 'hrreq-a-' || substr(md5(random()::text), 1, 8), 'Nairobi', '00000000-0000-4000-8000-00000000b7f1'),
  ('00000000-0000-4000-8000-00000000b702', 'HR Request Other School', 'hrreq-b-' || substr(md5(random()::text), 1, 8), 'Nairobi', '00000000-0000-4000-8000-00000000b7f1');

select pg_temp.person('00000000-0000-4000-8000-00000000b7a1', '00000000-0000-4000-8000-00000000b701', 'school_admin', 'HR Request Principal');
select pg_temp.person('00000000-0000-4000-8000-00000000b7a2', '00000000-0000-4000-8000-00000000b701', 'staff', 'HR Request Bursar');
select pg_temp.person('00000000-0000-4000-8000-00000000b7a3', null, 'org_admin', 'HR Request Org Admin');
insert into organization_admins (profile_id, organization_id) values
  ('00000000-0000-4000-8000-00000000b7a3', '00000000-0000-4000-8000-00000000b7f1');
insert into staff_permissions (tenant_id, profile_id, area) values
  ('00000000-0000-4000-8000-00000000b701', '00000000-0000-4000-8000-00000000b7a2', 'fees');

-- ---------------------------------------------------------------- the columns
select pg_temp.check('tenants has hr_requested_at (timestamptz) and hr_requested_by (uuid), both empty until asked',
  (select count(*) = 2 from information_schema.columns
    where table_schema = 'public' and table_name = 'tenants' and is_nullable = 'YES'
      and ((column_name = 'hr_requested_at' and data_type = 'timestamp with time zone')
        or (column_name = 'hr_requested_by' and data_type = 'uuid')))
  and (select hr_requested_at is null and hr_requested_by is null from tenants where id = '00000000-0000-4000-8000-00000000b701'));
select pg_temp.check('a requester''s profile going away keeps the request (hr_requested_by is set null)',
  exists (select 1 from pg_constraint c
           where c.conrelid = 'tenants'::regclass and c.contype = 'f' and c.confrelid = 'profiles'::regclass
             and c.confdeltype = 'n'
             and c.conkey = array[(select attnum from pg_attribute where attrelid = 'tenants'::regclass and attname = 'hr_requested_by')]));

-- ---------------------------------------------------------------- who may record a request
select pg_temp.check('only the service role may run platform_record_hr_request',
  has_function_privilege('service_role', 'platform_record_hr_request(uuid, uuid)', 'execute')
  and not has_function_privilege('authenticated', 'platform_record_hr_request(uuid, uuid)', 'execute')
  and not has_function_privilege('anon', 'platform_record_hr_request(uuid, uuid)', 'execute'));
select pg_temp.check('the school''s admin can''t call it directly (open-hr checks first)',
  pg_temp.record_as('00000000-0000-4000-8000-00000000b7a1', '00000000-0000-4000-8000-00000000b701') = 'denied');

create temp table hr_writers (label text, uid uuid);
insert into hr_writers values
  ('the school''s admin', '00000000-0000-4000-8000-00000000b7a1'),
  ('the bursar (fees area)', '00000000-0000-4000-8000-00000000b7a2'),
  ('an org admin of the school''s organisation', '00000000-0000-4000-8000-00000000b7a3');
grant select on hr_writers to authenticated;
select pg_temp.check(label || ' can''t set the request on the school directly',
  pg_temp.update_as(uid, '00000000-0000-4000-8000-00000000b701') in ('0', 'error 42501'))
  from hr_writers order by label;
select pg_temp.check('...so it is still empty',
  (select hr_requested_at is null and hr_requested_by is null from tenants where id = '00000000-0000-4000-8000-00000000b701'));

-- ---------------------------------------------------------------- the request
create temp table hr_answers (label text primary key, at timestamptz);
grant select, insert on hr_answers to service_role;
set local role service_role;
insert into hr_answers
  select 'first', platform_record_hr_request('00000000-0000-4000-8000-00000000b701', '00000000-0000-4000-8000-00000000b7a2');
reset role;
select pg_temp.check('the first request is recorded, with who asked, and its time is the answer',
  (select t.hr_requested_at = f.at and t.hr_requested_by = '00000000-0000-4000-8000-00000000b7a2'
     from tenants t, hr_answers f where f.label = 'first' and t.id = '00000000-0000-4000-8000-00000000b701'));
select pg_temp.check('another school isn''t touched',
  (select hr_requested_at is null from tenants where id = '00000000-0000-4000-8000-00000000b702'));

update tenants set hr_requested_at = '2026-11-20 08:30:15.789+00' where id = '00000000-0000-4000-8000-00000000b701';
set local role service_role;
insert into hr_answers
  select 'again', platform_record_hr_request('00000000-0000-4000-8000-00000000b701', '00000000-0000-4000-8000-00000000b7a1');
reset role;
select pg_temp.check('asking again changes nothing and answers the first request''s time',
  (select a.at = '2026-11-20 08:30:15.789+00'::timestamptz and t.hr_requested_by = '00000000-0000-4000-8000-00000000b7a2'
     from tenants t, hr_answers a where a.label = 'again' and t.id = '00000000-0000-4000-8000-00000000b701'));

set local role service_role;
select pg_temp.check('an unknown school answers null and creates nothing',
  platform_record_hr_request('00000000-0000-4000-8000-00000000bfff', '00000000-0000-4000-8000-00000000b7a1') is null);
reset role;

-- ---------------------------------------------------------------- the console's list
select pg_temp.check('the console''s school list carries hr_requested_at, ISO in UTC seconds',
  (select s ->> 'hr_requested_at' = '2026-11-20T08:30:15Z'
     from jsonb_array_elements(platform_console_schools('00000000-0000-4000-8000-00000000b701')) s));
select pg_temp.check('null for a school that never asked',
  (select s ? 'hr_requested_at' and s -> 'hr_requested_at' = 'null'::jsonb
     from jsonb_array_elements(platform_console_schools('00000000-0000-4000-8000-00000000b702')) s));
select pg_temp.check('the list doesn''t say who asked',
  (select not (s::text like '%00000000-0000-4000-8000-00000000b7a2%')
     from jsonb_array_elements(platform_console_schools('00000000-0000-4000-8000-00000000b701')) s));
select pg_temp.check('the list is still for the service role only',
  has_function_privilege('service_role', 'platform_console_schools(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'platform_console_schools(uuid)', 'execute'));

rollback;
