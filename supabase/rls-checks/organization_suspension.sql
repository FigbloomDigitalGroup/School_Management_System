-- Organisation suspension reaching its schools (20261104910000) and every
-- school having an organisation (20261104920000).
--
-- Runs against a local database that has the migrations applied and
-- `npm run db:seed` data, inside one transaction that is rolled back.
-- Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/organization_suspension.sql

\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------- fixtures (as postgres)
select set_config('t.a',       (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.teacher', (select id::text from profiles where role = 'teacher' and tenant_id = current_setting('t.a')::uuid limit 1), true);
select set_config('t.super',   (select id::text from profiles where role = 'super_admin' limit 1), true);
update tenants set status = 'active', status_reason = null where id = current_setting('t.a')::uuid;
update auth.users set banned_until = null where id = current_setting('t.teacher')::uuid;

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when coalesce(ok, false) then 'PASS' else 'FAIL' end, label; end $$;
create function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.status(p uuid) returns text language sql as $$ select status::text from tenants where id = p $$;
create function pg_temp.held(p uuid) returns boolean language sql as $$ select exists (select 1 from organization_suspended_schools where tenant_id = p) $$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

-- ================================================================ every school has an organisation
insert into tenants (id, name, slug, county, status)
  values ('00000000-0000-4000-8000-0000000000f1', 'Check Lone School', 'check-lone-school', 'Nakuru', 'active');
select pg_temp.check('a school inserted without an organisation gets its own, named after it',
  (select o.name = 'Check Lone School' and o.slug = 'check-lone-school' and o.kind = 'group_owner' and o.status = 'active'
     from tenants t join organizations o on o.id = t.organization_id where t.id = '00000000-0000-4000-8000-0000000000f1'));
select pg_temp.check('no school is left without an organisation', not exists (select 1 from tenants where organization_id is null));
do $$
begin
  update tenants set organization_id = null where id = '00000000-0000-4000-8000-0000000000f1';
  raise notice 'FAIL a school can''t be taken out of its organisation';
exception when not_null_violation then raise notice 'PASS a school can''t be taken out of its organisation';
end $$;
do $$
begin
  delete from organizations where id = (select organization_id from tenants where id = '00000000-0000-4000-8000-0000000000f1');
  raise notice 'FAIL an organisation with schools can''t be deleted';
exception when foreign_key_violation then raise notice 'PASS an organisation with schools can''t be deleted';
end $$;
select pg_temp.act_as(current_setting('t.teacher')); set local role authenticated;
do $$
begin
  perform give_school_own_organization('00000000-0000-4000-8000-0000000000f1');
  raise notice 'FAIL only Figbloom staff can move a school to its own organisation';
exception when insufficient_privilege then raise notice 'PASS only Figbloom staff can move a school to its own organisation';
end $$;
reset role;

-- ================================================================ the organisation's suspension reaches its schools
-- O1 with three schools: A (alliance, active), B (on trial), C (suspended on its own first)
insert into organizations (id, name, slug, kind, status) values
  ('00000000-0000-4000-8000-0000000000b1', 'Check Cascade Group', 'check-cascade-group', 'group_owner', 'active'),
  ('00000000-0000-4000-8000-0000000000b2', 'Check Other Group', 'check-other-group', 'group_owner', 'active');
update tenants set organization_id = '00000000-0000-4000-8000-0000000000b1' where id = current_setting('t.a')::uuid;
insert into tenants (id, name, slug, county, status, organization_id) values
  ('00000000-0000-4000-8000-0000000000c2', 'Check School B', 'check-school-b', 'Nairobi', 'trial', '00000000-0000-4000-8000-0000000000b1'),
  ('00000000-0000-4000-8000-0000000000c3', 'Check School C', 'check-school-c', 'Nairobi', 'active', '00000000-0000-4000-8000-0000000000b1'),
  ('00000000-0000-4000-8000-0000000000c4', 'Check School D', 'check-school-d', 'Nairobi', 'overdue', '00000000-0000-4000-8000-0000000000b2');
set local role service_role;
select pg_temp.check('C is suspended on its own first (Figbloom console)',
  platform_console_set_school_status('00000000-0000-4000-8000-0000000000c3', 'suspended', 'Its own reason', 'ops@figbloom.org') ->> 'outcome' = 'ok');

select pg_temp.check('platform decision: the organisation is suspended',
  platform_apply_organization_decision('00000000-0000-4000-8000-0000000000b1', 'suspended', 'Fees unpaid',
    'console:ann@figbloom.org', '2026-11-03 09:00+00', 'cascade-1', 'webhook') ->> 'outcome' = 'applied');
reset role;
select pg_temp.check('its schools are suspended through tenants.status, remembering what they were',
  pg_temp.status(current_setting('t.a')::uuid) = 'suspended' and pg_temp.status('00000000-0000-4000-8000-0000000000c2') = 'suspended'
  and (select status_before_suspension::text from tenants where id = current_setting('t.a')::uuid) = 'active'
  and (select status_before_suspension::text from tenants where id = '00000000-0000-4000-8000-0000000000c2') = 'trial');
select pg_temp.check('...and recorded as held by the organisation; C, suspended on its own, is not',
  pg_temp.held(current_setting('t.a')::uuid) and pg_temp.held('00000000-0000-4000-8000-0000000000c2')
  and not pg_temp.held('00000000-0000-4000-8000-0000000000c3'));
select pg_temp.check('...exactly as a single suspended school: its users are banned in Auth',
  (select banned_until > now() + interval '50 years' from auth.users where id = current_setting('t.teacher')::uuid));
select pg_temp.act_as(current_setting('t.teacher')); set local role authenticated;
select pg_temp.check('...and my_tenant() is the no-match id', my_tenant() = '00000000-0000-0000-0000-000000000000'::uuid);
reset role;
select pg_temp.check('each school reads "Figbloom" and the reason, never who decided',
  (select count(*) = 2 and bool_and(actor_label = 'Figbloom (via Figbloom platform)' and event like '%: Fees unpaid'
                                    and (actor_label || event || metadata::text) not like '%ann@figbloom.org%')
     from audit_events where event like 'School suspended with its organization%'
      and tenant_id in (current_setting('t.a')::uuid, '00000000-0000-4000-8000-0000000000c2')));
select pg_temp.check('who decided is in the staff-only event',
  exists (select 1 from audit_events where tenant_id is null and metadata ->> 'decided_by' = 'console:ann@figbloom.org'
            and metadata ->> 'delivery_id' = 'cascade-1'));

-- ---------------------------------------------------------------- repeated, late and sideways decisions
set local role service_role;
select pg_temp.check('the same delivery again changes nothing',
  platform_apply_organization_decision('00000000-0000-4000-8000-0000000000b1', 'active', null, 'console:x', '2026-11-03 09:30+00', 'cascade-1', 'webhook') ->> 'outcome' = 'duplicate');
select pg_temp.check('a late (older) reactivation changes nothing',
  platform_apply_organization_decision('00000000-0000-4000-8000-0000000000b1', 'active', null, 'console:x', '2026-11-03 08:00+00', 'cascade-0', 'webhook') ->> 'outcome' = 'stale');
select pg_temp.check('suspended to rejected: applied',
  platform_apply_organization_decision('00000000-0000-4000-8000-0000000000b1', 'rejected', 'Not a school', 'console:x', '2026-11-03 09:10+00', 'cascade-2', 'webhook') ->> 'outcome' = 'applied');
reset role;
select pg_temp.check('...but the schools stay as they were, still held',
  pg_temp.status(current_setting('t.a')::uuid) = 'suspended' and pg_temp.held(current_setting('t.a')::uuid)
  and pg_temp.held('00000000-0000-4000-8000-0000000000c2'));

-- ---------------------------------------------------------------- joining and moving
insert into tenants (id, name, slug, county, status, organization_id)
  values ('00000000-0000-4000-8000-0000000000c5', 'Check School E', 'check-school-e', 'Nairobi', 'onboarding', '00000000-0000-4000-8000-0000000000b1');
select pg_temp.check('a new school in a suspended organisation starts suspended, and remembers onboarding',
  pg_temp.status('00000000-0000-4000-8000-0000000000c5') = 'suspended' and pg_temp.held('00000000-0000-4000-8000-0000000000c5')
  and (select status_before_suspension::text from tenants where id = '00000000-0000-4000-8000-0000000000c5') = 'onboarding');

update tenants set organization_id = '00000000-0000-4000-8000-0000000000b2' where id = '00000000-0000-4000-8000-0000000000c2';
select pg_temp.check('B moved to a working organisation: the suspension its old one caused is lifted, back to trial',
  pg_temp.status('00000000-0000-4000-8000-0000000000c2') = 'trial' and not pg_temp.held('00000000-0000-4000-8000-0000000000c2'));
update tenants set organization_id = '00000000-0000-4000-8000-0000000000b1' where id = '00000000-0000-4000-8000-0000000000c4';
select pg_temp.check('D moved into the suspended organisation: suspended and held, remembering overdue',
  pg_temp.status('00000000-0000-4000-8000-0000000000c4') = 'suspended' and pg_temp.held('00000000-0000-4000-8000-0000000000c4')
  and (select status_before_suspension::text from tenants where id = '00000000-0000-4000-8000-0000000000c4') = 'overdue');
update tenants set organization_id = '00000000-0000-4000-8000-0000000000b2' where id = '00000000-0000-4000-8000-0000000000c3';
select pg_temp.check('C, suspended on its own, moved to a working organisation: stays suspended',
  pg_temp.status('00000000-0000-4000-8000-0000000000c3') = 'suspended');
update tenants set organization_id = '00000000-0000-4000-8000-0000000000b1' where id = '00000000-0000-4000-8000-0000000000c3';

-- ---------------------------------------------------------------- one school suspended separately, then the organisation reactivated
set local role service_role;
select pg_temp.check('suspending A on its own while its organisation holds it: the suspension becomes A''s',
  platform_console_set_school_status(current_setting('t.a')::uuid, 'suspended', 'Data protection review', 'ops@figbloom.org') ->> 'outcome' = 'ok');
select pg_temp.check('reactivating one school of a suspended organisation is refused',
  platform_console_set_school_status('00000000-0000-4000-8000-0000000000c5', 'active', null, 'ops@figbloom.org') ->> 'outcome' = 'organization_suspended');
select pg_temp.check('platform decision: the organisation is reactivated',
  platform_apply_organization_decision('00000000-0000-4000-8000-0000000000b1', 'active', null, 'console:ann@figbloom.org', '2026-11-03 10:00+00', 'cascade-3', 'webhook') ->> 'outcome' = 'applied');
reset role;
select pg_temp.check('only the schools it held come back, each to what it was (E onboarding, D overdue)',
  pg_temp.status('00000000-0000-4000-8000-0000000000c5') = 'onboarding' and pg_temp.status('00000000-0000-4000-8000-0000000000c4') = 'overdue');
select pg_temp.check('A (suspended on its own meanwhile) and C (on its own from the start) stay suspended',
  pg_temp.status(current_setting('t.a')::uuid) = 'suspended' and pg_temp.status('00000000-0000-4000-8000-0000000000c3') = 'suspended');
select pg_temp.check('...so A''s teacher is still banned', (select banned_until is not null from auth.users where id = current_setting('t.teacher')::uuid));
select pg_temp.check('nothing is held for the organisation any more', not exists (select 1 from organization_suspended_schools where organization_id = '00000000-0000-4000-8000-0000000000b1'));

-- ---------------------------------------------------------------- Schools' own console (before switch-on)
update organizations set status = 'suspended' where id = '00000000-0000-4000-8000-0000000000b2';
select pg_temp.check('suspending an organisation in Schools'' own console reaches its schools too (B)',
  pg_temp.status('00000000-0000-4000-8000-0000000000c2') = 'suspended' and pg_temp.held('00000000-0000-4000-8000-0000000000c2'));
select pg_temp.check('...the school reads "Figbloom", and a staff-only event lists the schools',
  exists (select 1 from audit_events where tenant_id = '00000000-0000-4000-8000-0000000000c2' and actor_label = 'Figbloom'
            and event like 'School suspended with its organization%')
  and exists (select 1 from audit_events where tenant_id is null and metadata ->> 'organization_id' = '00000000-0000-4000-8000-0000000000b2'
                and metadata -> 'schools' ? '00000000-0000-4000-8000-0000000000c2'));
update organizations set status = 'active' where id = '00000000-0000-4000-8000-0000000000b2';
select pg_temp.check('...and reactivating it brings B back to trial',
  pg_temp.status('00000000-0000-4000-8000-0000000000c2') = 'trial' and not pg_temp.held('00000000-0000-4000-8000-0000000000c2'));

-- ---------------------------------------------------------------- who may run it
select pg_temp.check('the cascade''s pieces are not callable by signed-in users',
  not has_function_privilege('authenticated', 'suspend_school_with_organization(uuid, uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'restore_school_from_organization(uuid, text)', 'execute')
  and not has_function_privilege('authenticated', 'create_school_own_organization(text, text, text, text)', 'execute')
  and not has_table_privilege('authenticated', 'organization_suspended_schools', 'select'));

rollback;
