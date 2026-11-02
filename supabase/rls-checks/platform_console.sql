-- Figbloom console checks for 20261104600000_platform_console_schools.
--
-- Runs against a local database that has the migrations applied and
-- `npm run db:seed` data, inside one transaction that is rolled back.
-- Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/platform_console.sql
--
-- What it shows: only the service role can run the two functions; the list's
-- counts match the tables; and a suspension from the console goes through
-- tenants.status, so the school's users get the no-match my_tenant() and the
-- Auth ban exactly as when suspended from Schools' own console; reactivating
-- restores the status the school had (here 'overdue'); the school's audit log
-- says "Figbloom" and the reason, and the staff member's address is only in an
-- event with no school, which the school's admin can't read.

\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------- fixtures (as postgres)
select set_config('t.a',       (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.teacher', (select id::text from profiles where role = 'teacher' and tenant_id = current_setting('t.a')::uuid limit 1), true);
select set_config('t.admin',   (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.a')::uuid limit 1), true);
-- overdue: still signs in, and reactivation should bring it back to exactly this
update tenants set status = 'overdue', status_reason = null where id = current_setting('t.a')::uuid;
update auth.users set last_sign_in_at = '2026-11-01 17:22:00+00' where id = current_setting('t.teacher')::uuid;

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when coalesce(ok, false) then 'PASS' else 'FAIL' end, label; end $$;
create function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.as_service() returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true)
$$;
-- The generic audit trigger's lines for this school's tenants row. They carry no
-- tenant_id (a tenants row has no tenant_id column), so match the row's key.
create function pg_temp.generic_tenant_lines(school uuid) returns bigint language sql as $$
  select count(*) from audit_events
   where metadata ->> 'table' = 'tenants' and metadata ->> 'op' = 'update'
     and metadata -> 'changes' @> jsonb_build_array(jsonb_build_object('key', jsonb_build_object('id', school)))
$$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

select pg_temp.check('the fixture has a school with learners, a teacher and a school admin',
  current_setting('t.a', true) <> '' and current_setting('t.teacher', true) <> '' and current_setting('t.admin', true) <> '');

-- ---------------------------------------------------------------- who may call them
select pg_temp.check('anon cannot run platform_console_schools',
  not has_function_privilege('anon', 'platform_console_schools(uuid)', 'execute'));
select pg_temp.check('authenticated cannot run platform_console_schools',
  not has_function_privilege('authenticated', 'platform_console_schools(uuid)', 'execute'));
select pg_temp.check('anon cannot run platform_console_set_school_status',
  not has_function_privilege('anon', 'platform_console_set_school_status(uuid, text, text, text)', 'execute'));
select pg_temp.check('authenticated cannot run platform_console_set_school_status',
  not has_function_privilege('authenticated', 'platform_console_set_school_status(uuid, text, text, text)', 'execute'));
select pg_temp.check('service_role can run both',
  has_function_privilege('service_role', 'platform_console_schools(uuid)', 'execute')
  and has_function_privilege('service_role', 'platform_console_set_school_status(uuid, text, text, text)', 'execute'));
select pg_temp.check('both are security definer with a fixed search_path',
  (select bool_and(p.prosecdef and p.proconfig::text like '%search_path=public%')
     from pg_proc p where p.proname in ('platform_console_schools', 'platform_console_set_school_status')));

-- ---------------------------------------------------------------- the list (as the service role)
-- answers are kept in a setting while acting as the service role, and put in a
-- temp table afterwards, as postgres (the service role needn't own temp tables)
select pg_temp.as_service(); set local role service_role;
select set_config('t.list', platform_console_schools()::text, true);
reset role;
create temp table l on commit drop as
  select e as row from jsonb_array_elements(current_setting('t.list')::jsonb) e;

select pg_temp.check('the list has every school',
  (select count(*) from l) = (select count(*) from tenants));
select pg_temp.check('a row has exactly the contract''s fields',
  (select array_agg(k order by k) from jsonb_object_keys((select row from l where row ->> 'id' = current_setting('t.a'))) k)
  = array['admin_email','created_at','id','last_activity_at','name','organization','parents','slug','status','status_reason','students','teachers']);
select pg_temp.check('students counts current learners',
  (select (row ->> 'students')::int from l where row ->> 'id' = current_setting('t.a'))
  = (select count(*) from students where tenant_id = current_setting('t.a')::uuid and active));
select pg_temp.check('teachers counts teacher accounts',
  (select (row ->> 'teachers')::int from l where row ->> 'id' = current_setting('t.a'))
  = (select count(*) from profiles where tenant_id = current_setting('t.a')::uuid and role = 'teacher'));
select pg_temp.check('parents counts parent accounts',
  (select (row ->> 'parents')::int from l where row ->> 'id' = current_setting('t.a'))
  = (select count(*) from profiles where tenant_id = current_setting('t.a')::uuid and role = 'parent'));
select pg_temp.check('admin_email is the first school admin''s real address (not a login-ID one)',
  (select row ->> 'admin_email' from l where row ->> 'id' = current_setting('t.a'))
  is not distinct from (select a.email from (select coalesce(nullif(trim(p.email), ''), u.email) as email, p.created_at, p.id
                                               from profiles p left join auth.users u on u.id = p.id
                                              where p.tenant_id = current_setting('t.a')::uuid and p.role = 'school_admin') a
                         where a.email is not null and a.email not like '%.figbloom.internal'
                         order by a.created_at, a.id limit 1));
select pg_temp.check('last_activity_at is the latest sign-in at the school, in UTC with a Z',
  (select row ->> 'last_activity_at' from l where row ->> 'id' = current_setting('t.a'))
  = to_char((select max(u.last_sign_in_at) from profiles p join auth.users u on u.id = p.id
              where p.tenant_id = current_setting('t.a')::uuid) at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
select pg_temp.check('one school can be asked for by id',
  jsonb_array_length(platform_console_schools(current_setting('t.a')::uuid)) = 1);

-- ---------------------------------------------------------------- suspend from the console
select set_config('t.generic_before', pg_temp.generic_tenant_lines(current_setting('t.a')::uuid)::text, true);
select pg_temp.as_service(); set local role service_role;
select set_config('t.r1', platform_console_set_school_status(current_setting('t.a')::uuid, 'suspended', '  Licence unpaid  ', 'ops@figbloom.org')::text, true);
reset role;
create temp table r1 on commit drop as select current_setting('t.r1')::jsonb as r;

select pg_temp.check('suspend: ok, and the school comes back suspended with its reason',
  (select r ->> 'outcome' = 'ok' and r #>> '{school,status}' = 'suspended' and r #>> '{school,status_reason}' = 'Licence unpaid' from r1));
select pg_temp.check('suspend: tenants.status is suspended, remembering it was overdue',
  (select status = 'suspended' and status_before_suspension = 'overdue' from tenants where id = current_setting('t.a')::uuid));
select pg_temp.check('suspend: the school''s users are banned in Auth, as by Schools'' own console',
  (select banned_until > now() + interval '50 years' and raw_app_meta_data ->> 'suspended_with_school' = 'true'
     from auth.users where id = current_setting('t.teacher')::uuid));
select pg_temp.act_as(current_setting('t.teacher')); set local role authenticated;
select pg_temp.check('suspend: a teacher there gets the no-match my_tenant() and sees no learners',
  my_tenant() = '00000000-0000-0000-0000-000000000000'::uuid and (select count(*) from students) = 0);
reset role;
select pg_temp.check('suspend: one event on the school, by "Figbloom", with the reason',
  (select count(*) = 1 and bool_and(actor_label = 'Figbloom (via Figbloom console)'
                                    and event = 'School suspended by Figbloom: Licence unpaid'
                                    and metadata ->> 'reason' = 'Licence unpaid'
                                    and metadata #>> '{changes,status,to}' = 'suspended')
     from audit_events where tenant_id = current_setting('t.a')::uuid and metadata ->> 'via' = 'Figbloom console'));
select pg_temp.check('suspend: the staff member''s address is in no event on the school, nor on the school''s row',
  not exists (select 1 from audit_events where tenant_id = current_setting('t.a')::uuid
                 and (actor_label || event || metadata::text) like '%ops@figbloom.org%')
  and not exists (select 1 from tenants t where t.id = current_setting('t.a')::uuid and to_jsonb(t)::text like '%ops@figbloom.org%'));
select pg_temp.check('suspend: it is in one event with no school (Figbloom staff only)',
  (select count(*) = 1 and bool_and(actor_label = 'ops@figbloom.org via Figbloom console'
                                    and metadata ->> 'school_id' = current_setting('t.a')
                                    and metadata ->> 'actor_email' = 'ops@figbloom.org')
     from audit_events where tenant_id is null and metadata ->> 'via' = 'Figbloom console'));
select pg_temp.check('suspend: no second, generic tenants line for the same change',
  pg_temp.generic_tenant_lines(current_setting('t.a')::uuid) = current_setting('t.generic_before')::bigint);

-- ---------------------------------------------------------------- 404 / 409 / 422 / bad input
select pg_temp.as_service(); set local role service_role;
select pg_temp.check('already suspended: outcome already',
  platform_console_set_school_status(current_setting('t.a')::uuid, 'suspended', 'again', 'ops@figbloom.org') ->> 'outcome' = 'already');
select pg_temp.check('no such school: outcome not_found',
  platform_console_set_school_status(gen_random_uuid(), 'suspended', 'x', 'ops@figbloom.org') ->> 'outcome' = 'not_found');
select pg_temp.check('a status the console can''t set: outcome not_settable',
  platform_console_set_school_status(current_setting('t.a')::uuid, 'trial', null, 'ops@figbloom.org') ->> 'outcome' = 'not_settable');
reset role;

do $$
begin
  perform pg_temp.as_service();
  begin
    perform platform_console_set_school_status(current_setting('t.a')::uuid, 'active', repeat('x', 501), 'ops@figbloom.org');
    raise notice 'FAIL a reason over 500 characters is refused';
  exception when invalid_parameter_value then raise notice 'PASS a reason over 500 characters is refused';
  end;
  begin
    perform platform_console_set_school_status(current_setting('t.a')::uuid, 'active', null, '  ');
    raise notice 'FAIL a blank actor is refused';
  exception when invalid_parameter_value then raise notice 'PASS a blank actor is refused';
  end;
end $$;

-- ---------------------------------------------------------------- reactivate from the console
select pg_temp.as_service(); set local role service_role;
select set_config('t.r2', platform_console_set_school_status(current_setting('t.a')::uuid, 'active', null, 'ops@figbloom.org')::text, true);
reset role;
create temp table r2 on commit drop as select current_setting('t.r2')::jsonb as r;
select pg_temp.check('reactivate: ok, back to overdue (its status before), reason cleared',
  (select r ->> 'outcome' = 'ok' and r #>> '{school,status}' = 'overdue' and r #> '{school,status_reason}' = 'null'::jsonb from r2));
select pg_temp.check('reactivate: the remembered status is forgotten',
  (select status = 'overdue' and status_before_suspension is null from tenants where id = current_setting('t.a')::uuid));
select pg_temp.check('reactivate: the ban is lifted',
  (select banned_until is null and not (raw_app_meta_data ? 'suspended_with_school')
     from auth.users where id = current_setting('t.teacher')::uuid));
select pg_temp.act_as(current_setting('t.teacher')); set local role authenticated;
select pg_temp.check('reactivate: the teacher sees their learners again', (select count(*) from students) > 0);
reset role;
select pg_temp.act_as(current_setting('t.admin')); set local role authenticated;
select pg_temp.check('the school admin reads the console''s events on their school',
  (select count(*) from audit_events where metadata ->> 'via' = 'Figbloom console') = 2);
select pg_temp.check('...and nothing they can read names the staff member',
  not exists (select 1 from audit_events where (actor_label || event || metadata::text) like '%ops@figbloom.org%'));
reset role;

select pg_temp.as_service(); set local role service_role;
select pg_temp.check('reactivating a school that isn''t suspended: outcome not_suspended',
  platform_console_set_school_status(current_setting('t.a')::uuid, 'active', null, 'ops@figbloom.org') ->> 'outcome' = 'not_suspended');
reset role;

-- ---------------------------------------------------------------- reason never outlives its status
-- The console function's figbloom.self_audited lasts the rest of its transaction,
-- which here is this whole file; an API call is its own transaction. Clear it.
select set_config('figbloom.self_audited', '', true);
select set_config('t.generic_before', pg_temp.generic_tenant_lines(current_setting('t.a')::uuid)::text, true);
update tenants set status = 'suspended', status_reason = 'From the console' where id = current_setting('t.a')::uuid;
select pg_temp.check('a suspension made directly (Schools'' own console) remembers the status too',
  (select status_before_suspension = 'overdue' from tenants where id = current_setting('t.a')::uuid));
update tenants set status = 'trial' where id = current_setting('t.a')::uuid;
select pg_temp.check('a status change elsewhere clears the console''s reason and the remembered status',
  (select status_reason is null and status_before_suspension is null from tenants where id = current_setting('t.a')::uuid));
select pg_temp.check('a direct status change still gets its generic audit line (so the check above isn''t vacuous)',
  pg_temp.generic_tenant_lines(current_setting('t.a')::uuid) = current_setting('t.generic_before')::bigint + 2);

rollback;
