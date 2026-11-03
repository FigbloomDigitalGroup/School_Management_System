-- Figbloom platform registration checks for 20261104900000_platform_registration.
--
-- Runs against a local database that has the migrations applied and
-- `npm run db:seed` data, inside one transaction that is rolled back.
-- Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/platform_registration.sql
--
-- What it shows: creating or renaming an organisation or school queues it in
-- the same transaction (one pending row per record, unrelated edits don't);
-- the queue hands out organisations first and never the same row twice at
-- once; a lone school gets its own organisation; a platform decision sets
-- organizations.status, so a suspended organisation's admins lose its schools
-- and reactivation gives them back, with the right audit; repeats and older
-- decisions are ignored; after switch-on nothing else may change the status;
-- and only the service role can run any of it.

\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------- fixtures (as postgres)
select set_config('t.a', (select id::text from tenants where slug = 'alliance'), true);
delete from platform_sync_queue;
insert into auth.users (id) values ('00000000-0000-4000-8000-0000000000e1');
insert into profiles (id, role, full_name) values ('00000000-0000-4000-8000-0000000000e1', 'org_admin', 'Check Platform Org Admin');

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when coalesce(ok, false) then 'PASS' else 'FAIL' end, label; end $$;
create function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true)
$$;
create function pg_temp.pending(p_kind text, p_id uuid) returns bigint language sql as $$
  select count(*) from platform_sync_queue where kind = p_kind and local_id = p_id and done_at is null
$$;
grant execute on all functions in schema pg_temp to authenticated, service_role;

-- ---------------------------------------------------------------- who may run it
select pg_temp.check('anon and authenticated can''t run the queue or decision functions',
  not has_function_privilege('authenticated', 'platform_sync_claim(int)', 'execute')
  and not has_function_privilege('anon', 'platform_sync_claim(int)', 'execute')
  and not has_function_privilege('authenticated', 'platform_apply_organization_decision(uuid, text, text, text, timestamptz, text, text)', 'execute')
  and not has_function_privilege('authenticated', 'platform_create_school_organization(uuid)', 'execute')
  and not has_function_privilege('authenticated', 'platform_sync_enqueue(text, uuid)', 'execute'));
select pg_temp.check('the service role can',
  has_function_privilege('service_role', 'platform_sync_claim(int)', 'execute')
  and has_function_privilege('service_role', 'platform_apply_organization_decision(uuid, text, text, text, timestamptz, text, text)', 'execute'));
select pg_temp.check('signed-in staff can read the switch-on setting, nothing else',
  has_function_privilege('authenticated', 'platform_decisions_enabled()', 'execute')
  and not has_table_privilege('authenticated', 'platform_settings', 'select')
  and not has_table_privilege('authenticated', 'platform_sync_queue', 'select')
  and not has_table_privilege('authenticated', 'platform_webhook_deliveries', 'select'));
select pg_temp.check('switch-on is off by default', not platform_decisions_enabled());

-- ---------------------------------------------------------------- the triggers fill the queue
insert into organizations (id, name, slug, kind, status)
  values ('00000000-0000-4000-8000-0000000000e2', 'Check Platform Org', 'check-platform-org', 'group_owner', 'active');
insert into organization_admins (profile_id, organization_id)
  values ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-0000000000e2');
select pg_temp.check('a new organisation is queued',
  pg_temp.pending('organization', '00000000-0000-4000-8000-0000000000e2') = 1);
update organizations set name = 'Check Platform Group' where id = '00000000-0000-4000-8000-0000000000e2';
select pg_temp.check('a rename keeps one pending row (it is read when sent), with a new version',
  pg_temp.pending('organization', '00000000-0000-4000-8000-0000000000e2') = 1
  and (select version = 2 from platform_sync_queue where local_id = '00000000-0000-4000-8000-0000000000e2' and done_at is null));

update tenants set organization_id = '00000000-0000-4000-8000-0000000000e2' where id = current_setting('t.a')::uuid;
select pg_temp.check('moving a school into an organisation queues the school',
  pg_temp.pending('tenant', current_setting('t.a')::uuid) = 1);
update platform_sync_queue set done_at = now() where done_at is null;
update tenants set accent = '#123456' where id = current_setting('t.a')::uuid;
select pg_temp.check('an unrelated edit (the accent) queues nothing',
  pg_temp.pending('tenant', current_setting('t.a')::uuid) = 0);
update tenants set name = name || ' ' where id = current_setting('t.a')::uuid;
select pg_temp.check('renaming the school queues it again',
  pg_temp.pending('tenant', current_setting('t.a')::uuid) = 1);
update organizations set name = 'Check Platform Group 2' where id = '00000000-0000-4000-8000-0000000000e2';

-- ---------------------------------------------------------------- the queue hands rows out safely
-- answers are carried out in settings: the service role needn't be able to create temp tables
set local role service_role;
select set_config('t.claim', (select json_agg(json_build_object('id', c.id, 'kind', c.kind, 'version', c.version) order by c.n)::text
                                from (select row_number() over () as n, q.* from platform_sync_claim(10) q) c), true);
reset role;
select pg_temp.check('organisations come out before schools (the school was queued first)',
  (select array_agg(e ->> 'kind' order by i) from json_array_elements(current_setting('t.claim')::json) with ordinality as x(e, i))
  = array['organization', 'tenant']);
select set_config('t.claim_org', (select e ->> 'id' from json_array_elements(current_setting('t.claim')::json) e where e ->> 'kind' = 'organization'), true);
select set_config('t.claim_tenant', (select e ->> 'id' from json_array_elements(current_setting('t.claim')::json) e where e ->> 'kind' = 'tenant'), true);
select set_config('t.claim_org_version', (select e ->> 'version' from json_array_elements(current_setting('t.claim')::json) e where e ->> 'kind' = 'organization'), true);
set local role service_role;
select pg_temp.check('a second run while they are leased gets nothing', (select count(*) from platform_sync_claim(10)) = 0);
select platform_sync_done(current_setting('t.claim_org')::bigint, current_setting('t.claim_org_version')::int, 'platform-org-1');
select platform_sync_failed(current_setting('t.claim_tenant')::bigint, 'organization_not_registered', null);
reset role;
select pg_temp.check('done: marked, and the platform link recorded',
  (select done_at is not null from platform_sync_queue where id = current_setting('t.claim_org')::bigint)
  and exists (select 1 from platform_links where kind = 'organization' and local_id = '00000000-0000-4000-8000-0000000000e2' and platform_id = 'platform-org-1'));
select pg_temp.check('failed: retried after a minute, the lease lifted',
  (select next_attempt_at between now() + interval '55 seconds' and now() + interval '65 seconds' and locked_until is null and last_error is not null
     from platform_sync_queue where id = current_setting('t.claim_tenant')::bigint));

-- a rename while a send is on its way: completing the old version hands the row back instead
update platform_sync_queue set done_at = now() where done_at is null;
update organizations set name = 'Check Race 1' where id = '00000000-0000-4000-8000-0000000000e2';
set local role service_role;
select set_config('t.race', (select json_build_object('id', id, 'version', version)::text from platform_sync_claim(10) where kind = 'organization'), true);
reset role;
update organizations set name = 'Check Race 2' where id = '00000000-0000-4000-8000-0000000000e2';
set local role service_role;
select pg_temp.check('completing a version that has moved on answers false',
  not platform_sync_done((current_setting('t.race')::json ->> 'id')::bigint, (current_setting('t.race')::json ->> 'version')::int, null));
reset role;
select pg_temp.check('...and the row is handed back, due now, so the new name is sent next',
  (select done_at is null and locked_until is null and next_attempt_at <= now() and version = 2
     from platform_sync_queue where id = (current_setting('t.race')::json ->> 'id')::bigint));

-- ---------------------------------------------------------------- a school's own organisation
insert into tenants (id, name, slug, county) values ('00000000-0000-4000-8000-0000000000e3', 'Check Lone School', 'check-platform-org', 'Nakuru');
set local role service_role;
select set_config('t.lone_org', platform_create_school_organization('00000000-0000-4000-8000-0000000000e3')::text, true);
reset role;
select pg_temp.check('a school without an organisation gets its own, named after it (slug taken: -school)',
  (select name = 'Check Lone School' and slug = 'check-platform-org-school' and kind = 'group_owner' and status = 'active'
     from organizations where id = current_setting('t.lone_org')::uuid)
  and (select organization_id = current_setting('t.lone_org')::uuid from tenants where id = '00000000-0000-4000-8000-0000000000e3'));
select pg_temp.check('...and both are queued',
  pg_temp.pending('organization', current_setting('t.lone_org')::uuid) = 1
  and pg_temp.pending('tenant', '00000000-0000-4000-8000-0000000000e3') = 1);

-- ---------------------------------------------------------------- applying a decision
select pg_temp.act_as('00000000-0000-4000-8000-0000000000e1'); set local role authenticated;
select pg_temp.check('active organisation: its admin has its school',
  current_setting('t.a')::uuid in (select my_organization_tenant_ids()));
reset role;

set local role service_role;
select pg_temp.check('suspend: applied',
  platform_apply_organization_decision('00000000-0000-4000-8000-0000000000e2', 'suspended', 'Fees unpaid',
    'console:ann@figbloom.org', '2026-11-03 09:00+00', 'd-1', 'webhook') ->> 'outcome' = 'applied');
reset role;
select pg_temp.check('suspend: organizations.status is suspended',
  (select status = 'suspended' from organizations where id = '00000000-0000-4000-8000-0000000000e2'));
select pg_temp.act_as('00000000-0000-4000-8000-0000000000e1'); set local role authenticated;
select pg_temp.check('suspend: its admin loses its schools, as with Schools'' own suspension',
  not (current_setting('t.a')::uuid in (select my_organization_tenant_ids())));
reset role;
select pg_temp.check('suspend: the school''s event says Figbloom and the reason, not who',
  (select count(*) = 1 and bool_and(actor_label = 'Figbloom (via Figbloom platform)'
                                    and event like '%suspended by Figbloom: Fees unpaid'
                                    and (actor_label || event || metadata::text) not like '%ann@figbloom.org%')
     from audit_events where tenant_id = current_setting('t.a')::uuid and metadata ->> 'via' = 'Figbloom platform'));
select pg_temp.check('suspend: the staff-only event (no school) names who decided',
  exists (select 1 from audit_events where tenant_id is null and metadata ->> 'decided_by' = 'console:ann@figbloom.org'
            and metadata ->> 'delivery_id' = 'd-1'));

set local role service_role;
select pg_temp.check('the same delivery again: duplicate, not applied',
  platform_apply_organization_decision('00000000-0000-4000-8000-0000000000e2', 'active', null,
    'console:ann@figbloom.org', '2026-11-03 09:30+00', 'd-1', 'webhook') ->> 'outcome' = 'duplicate');
select pg_temp.check('an older decision: stale, not applied',
  platform_apply_organization_decision('00000000-0000-4000-8000-0000000000e2', 'active', null,
    'console:ann@figbloom.org', '2026-11-03 08:00+00', 'd-0', 'webhook') ->> 'outcome' = 'stale');
select pg_temp.check('an organisation Schools doesn''t have: not_found',
  platform_apply_organization_decision(gen_random_uuid(), 'active', null, 'console:x', now(), 'd-x', 'webhook') ->> 'outcome' = 'not_found');
reset role;
select pg_temp.check('...and it is still suspended', (select status = 'suspended' from organizations where id = '00000000-0000-4000-8000-0000000000e2'));

-- ---------------------------------------------------------------- switch-on: only the platform decides
update platform_settings set value = 'true' where key = 'PLATFORM_DECISIONS_ENABLED';
select pg_temp.check('switch-on reads as on', platform_decisions_enabled());
do $$
begin
  update organizations set status = 'active' where id = '00000000-0000-4000-8000-0000000000e2';
  raise notice 'FAIL after switch-on, a direct status change is refused';
exception when insufficient_privilege then raise notice 'PASS after switch-on, a direct status change is refused';
end $$;
update organizations set name = 'Check Platform Group 3' where id = '00000000-0000-4000-8000-0000000000e2';
select pg_temp.check('...but other edits still work', (select name = 'Check Platform Group 3' from organizations where id = '00000000-0000-4000-8000-0000000000e2'));

set local role service_role;
select pg_temp.check('reactivate from the platform: applied',
  platform_apply_organization_decision('00000000-0000-4000-8000-0000000000e2', 'active', null,
    'console:ann@figbloom.org', '2026-11-03 10:00+00', 'd-2', 'webhook') ->> 'outcome' = 'applied');
reset role;
select pg_temp.act_as('00000000-0000-4000-8000-0000000000e1'); set local role authenticated;
select pg_temp.check('reactivate: its admin has its schools again',
  current_setting('t.a')::uuid in (select my_organization_tenant_ids()));
reset role;

-- ---------------------------------------------------------------- the reconcile's candidates
set local role service_role;
select platform_note_unapplied_delivery('d-3', current_setting('t.lone_org')::uuid);
reset role;
insert into platform_links (kind, local_id) values ('organization', current_setting('t.lone_org')::uuid) on conflict do nothing;
set local role service_role;
select pg_temp.check('a decision noted before switch-on puts its organisation first for the reconcile',
  (select organization_id from platform_reconcile_candidates(1)) = current_setting('t.lone_org')::uuid);
reset role;

rollback;
