-- FIG-1297 checks for 20261102200000_null_safe_permission_checks.
--
-- A permission helper must answer false, never NULL, for a caller with no
-- profile (not signed in, or signed in without a profile row), because an
-- `if not helper(...) then raise` guard lets NULL through. And no
-- data-changing definer function may be executable by anon.
--
-- Runs against a local database that has the migrations applied, inside one
-- transaction that is rolled back. It makes its own school (no seed data
-- needed). Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/null_guards.sql

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
-- A statement that must be refused (any error).
create function pg_temp.expect_refused(label text, stmt text) returns void language plpgsql as $$
begin
  begin execute stmt; raise notice 'FAIL %: allowed', label;
  exception when others then raise notice 'PASS % (% %)', label, sqlstate, sqlerrm;
  end;
end $$;
create function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true)
$$;
-- Nobody signed in: auth.uid() is NULL.
create function pg_temp.act_as_nobody() returns void language sql as $$
  select set_config('request.jwt.claims', '', true), set_config('request.jwt.claim.sub', '', true)
$$;
grant execute on all functions in schema pg_temp to anon, authenticated;

-- ---------------------------------------------------------------- fixtures (as postgres)
with x as (
  insert into tenants (name, slug, county) values ('Null Guard Check School', 'null-check-' || substr(md5(random()::text), 1, 8), 'Nairobi') returning id
) select set_config('t.a', x.id::text, true) from x;
with x as (
  insert into classes (tenant_id, name, form_level) values (current_setting('t.a')::uuid, 'Null Check 1', 1) returning id
) select set_config('t.class', x.id::text, true) from x;
with x as (
  insert into subjects (tenant_id, name, code) values (current_setting('t.a')::uuid, 'Null Check Maths', 'NCKM') returning id
) select set_config('t.subject', x.id::text, true) from x;
-- An Auth user with no profile row: what open sign-up leaves behind.
select set_config('t.noprofile', gen_random_uuid()::text, true);
insert into auth.users (id, email) values (current_setting('t.noprofile')::uuid, 'null-check-' || current_setting('t.noprofile') || '@example.invalid');

-- ---------------------------------------------------------------- the helpers answer false, never NULL
-- Asked as postgres (the helpers are definers, so the caller's role doesn't
-- change the answer; only auth.uid() does).
create function pg_temp.helpers_false(who text) returns void language plpgsql as $$
declare t uuid := current_setting('t.a')::uuid;
begin
  perform pg_temp.check(who || ': may_administer is false',
    may_administer(t) is false);
  perform pg_temp.check(who || ': has_perm is false',
    has_perm(t, 'fees') is false);
  perform pg_temp.check(who || ': has_perm with no area is false',
    has_perm(t, null) is false);
  perform pg_temp.check(who || ': has_office_perm is false',
    has_office_perm(t) is false);
  perform pg_temp.check(who || ': may_teach_class_subject is false',
    may_teach_class_subject(t, current_setting('t.class')::uuid, current_setting('t.subject')::uuid) is false);
  perform pg_temp.check(who || ': may_administer(NULL) is false',
    may_administer(null) is false);
end $$;

select pg_temp.act_as_nobody();
select pg_temp.helpers_false('not signed in');
select pg_temp.act_as(current_setting('t.noprofile'));
select pg_temp.helpers_false('signed in, no profile');

-- ---------------------------------------------------------------- the guards hold
-- Signed in without a profile: the function runs, and its guard must refuse.
select pg_temp.act_as(current_setting('t.noprofile'));
set local role authenticated;
select pg_temp.expect_refused('no profile: set_school_details is refused',
  format($s$select set_school_details(%L, 'Renamed', 'Nairobi', null)$s$, current_setting('t.a')));
select pg_temp.expect_refused('no profile: set_school_payment_methods is refused',
  format($s$select set_school_payment_methods(%L, '999999', null, null, null)$s$, current_setting('t.a')));
select pg_temp.expect_refused('no profile: set_school_accent is refused',
  format($s$select set_school_accent(%L, '#1B4D2E')$s$, current_setting('t.a')));
select pg_temp.expect_refused('no profile: set_school_logo is refused',
  format($s$select set_school_logo(%L, 'https://example.invalid/x.png')$s$, current_setting('t.a')));
reset role;

-- Not signed in: anon can't call them at all.
select pg_temp.act_as_nobody();
set local role anon;
select pg_temp.expect_refused('anon: set_school_details is refused',
  format($s$select set_school_details(%L, 'Renamed', 'Nairobi', null)$s$, current_setting('t.a')));
select pg_temp.expect_refused('anon: set_school_payment_methods is refused',
  format($s$select set_school_payment_methods(%L, '999999', null, null, null)$s$, current_setting('t.a')));
reset role;

select pg_temp.check('the school''s name and paybill are unchanged',
  exists (select 1 from tenants where id = current_setting('t.a')::uuid
           and name = 'Null Guard Check School' and payment_paybill is null));

-- ---------------------------------------------------------------- anon grants
-- No data-changing (volatile, non-trigger) definer function in public is
-- executable by anon. refresh_organization_tenant_summary() used to be
-- excepted; since 20261103900000 (FIG-1314) only its triggers call it.
create temp table anon_callable as
select p.oid::regprocedure::text as fn
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.prosecdef
   and p.provolatile = 'v'
   and p.prorettype <> 'trigger'::regtype
   and has_function_privilege('anon', p.oid, 'execute');

do $$
declare r record;
begin
  for r in select fn from anon_callable order by fn loop
    raise notice 'FAIL anon can execute %', r.fn;
  end loop;
end $$;
select pg_temp.expect_eq('data-changing definer functions anon can execute',
  (select count(*) from anon_callable), 0);

-- ---------------------------------------------------------------- helpers nobody calls directly (20261103900000, FIG-1314)
select pg_temp.expect_eq('anon or a signed-in user can execute refresh_organization_tenant_summary, teaches_learner or chat_teaches_student',
  (select count(*) from pg_proc p, unnest(array['anon', 'authenticated']) r(role)
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('refresh_organization_tenant_summary', 'teaches_learner', 'chat_teaches_student')
      and has_function_privilege(r.role, p.oid, 'execute')), 0);

-- the triggers still refresh the summary when a signed-in admin changes a learner
select set_config('t.alliance', (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.alliance_admin', (select id::text from profiles where role = 'school_admin'
   and tenant_id = current_setting('t.alliance')::uuid limit 1), true);
update organization_tenant_summary set active_students = -1 where tenant_id = current_setting('t.alliance')::uuid;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.alliance_admin'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$ begin
  update students set full_name = full_name
   where id = (select id from students where tenant_id = current_setting('t.alliance')::uuid limit 1);
  raise notice 'PASS a school admin''s change to a learner still goes through';
exception when others then raise notice 'FAIL a school admin''s change to a learner: % %', sqlstate, sqlerrm; end $$;
reset role;
select pg_temp.expect_eq('and the school''s summary was refreshed by the trigger',
  (select count(*) from organization_tenant_summary
    where tenant_id = current_setting('t.alliance')::uuid and active_students >= 0), 1);

rollback;
