-- Accounts (QA 08, FIG-1241): the database side of sign-in and the account lifecycle.
--
-- Does every sign-in account have exactly one profile, and the address the sign-in screen will use for it? Are login IDs unique
-- inside a school (and only inside it)? What does suspending a school do to its users' sign-in, and what does archiving a learner
-- do? Runs as the owner against a local database with `npm run db:seed` and `npm run db:seed-org` data, in one transaction that is
-- rolled back. Every check prints PASS, FAIL, KNOWN <bug> (a defect already filed: KNOWN until fixed, then PASS) or INFO (a fact a
-- person should read, not a defect).
--
-- What this does NOT see: the edge functions that create and delete accounts (invite-admin, provision-student, provision-guardian,
-- delete-account), which differ on main and are tested in supabase/functions and in tests/integration.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/accounts.sql
-- Check the psql exit code too. Do not run it while e2e is running.

\set ON_ERROR_STOP 1
begin;

create function pg_temp.check(label text, ok boolean, known text default null) returns void language plpgsql as $$
begin
  raise notice '% %', case when ok then 'PASS' when known is not null then 'KNOWN ' || known else 'FAIL' end, label;
end $$;
create function pg_temp.info(label text) returns void language plpgsql as $$ begin raise notice 'INFO % ', label; end $$;
create function pg_temp.expect_error(label text, stmt text, errcode text) returns void language plpgsql as $$
begin
  begin execute stmt; raise notice 'FAIL %: allowed', label;
  exception when others then
    if sqlstate = errcode then raise notice 'PASS % (%)', label, sqlerrm;
    else raise notice 'FAIL %: % %', label, sqlstate, sqlerrm; end if;
  end;
end $$;

-- ---------------------------------------------------------------- accounts and profiles agree
select pg_temp.check('every sign-in account has a profile, and every profile has a sign-in account',
  not exists (select 1 from auth.users u left join profiles p on p.id = u.id where p.id is null)
  and not exists (select 1 from profiles p left join auth.users u on u.id = p.id where u.id is null));

select pg_temp.check('a school-ID account signs in as <id>@login.<school>.figbloom.internal, the address resolve-login-id answers with',
  not exists (
    select 1 from profiles p join tenants t on t.id = p.tenant_id join auth.users u on u.id = p.id
     where p.login_id is not null and lower(u.email) <> lower(p.login_id) || '@login.' || t.slug || '.figbloom.internal'));

select pg_temp.check('an email account has the same address on its profile and in the sign-in service',
  not exists (select 1 from profiles p join auth.users u on u.id = p.id where p.login_id is null and lower(p.email) is distinct from lower(u.email)));

select pg_temp.check('an account holds either a school ID or an email, never both and never neither (school staff by email, everyone else by ID)',
  not exists (select 1 from profiles p where (p.login_id is null) = (p.email is null)));

select pg_temp.check('nobody has a retired role, and only platform staff and organization admins have no school',
  not exists (select 1 from profiles where role::text in ('guard', 'receptionist'))
  and not exists (select 1 from profiles where (tenant_id is null) <> (role::text in ('super_admin', 'org_admin'))));

-- ---------------------------------------------------------------- login IDs
select set_config('t.a', (select id::text from tenants where slug = 'alliance'), true);
select pg_temp.check('the same login ID exists in two schools (so uniqueness has to be per school, and is)',
  exists (select 1 from profiles where login_id is not null group by login_id having count(distinct tenant_id) > 1));
select pg_temp.expect_error('a second account in a school cannot take a login ID that is already in use there',
  format('update profiles set login_id = (select login_id from profiles where tenant_id = %L and login_id like ''TC-%%'' order by login_id limit 1) where tenant_id = %L and login_id like ''BD-%%'' and id = (select id from profiles where tenant_id = %L and login_id like ''BD-%%'' order by login_id limit 1)',
         current_setting('t.a'), current_setting('t.a'), current_setting('t.a')), '23505');

-- next_login_number is "the highest number among the role's current accounts, plus one". The expectations below are worked out from
-- the rows, so they hold whatever numbers the seed happens to use.
create temp table qa_numbers (stage text, n int);
select set_config('t.top', (select id::text from profiles where tenant_id = current_setting('t.a')::uuid and role = 'teacher' and login_id ~ '[0-9]+$' order by substring(login_id from '[0-9]+$')::int desc limit 1), true);
select set_config('t.topn', (select substring(login_id from '[0-9]+$')::int::text from profiles where id = current_setting('t.top')::uuid), true);
insert into qa_numbers select 'now', next_login_number(current_setting('t.a')::uuid, 'teacher');
select pg_temp.check('the next teacher number is one above the highest existing one',
  (select n from qa_numbers where stage = 'now') = (select max(substring(login_id from '[0-9]+$')::int) + 1 from profiles
    where tenant_id = current_setting('t.a')::uuid and role = 'teacher' and login_id ~ '[0-9]+$'));
update profiles set login_id = 'RETIRED-X' where id = current_setting('t.top')::uuid;   -- as if the newest teacher's account had been deleted
insert into qa_numbers select 'after', next_login_number(current_setting('t.a')::uuid, 'teacher');
select pg_temp.check('once the newest account is removed the next number is one above the highest REMAINING one (1 if none are left)',
  (select n from qa_numbers where stage = 'after') = coalesce((select max(substring(login_id from '[0-9]+$')::int) + 1 from profiles
    where tenant_id = current_setting('t.a')::uuid and role = 'teacher' and login_id ~ '[0-9]+$'), 1));
select pg_temp.info(format('login IDs are recycled: the newest teacher was number %s; once that account is removed the next teacher is given number %s, so an old ID card, message or audit line naming the old ID can now mean someone else',
  current_setting('t.topn'), (select n from qa_numbers where stage = 'after')));
select pg_temp.info('no database rule makes a phone number unique: duplicates are possible unless a function refuses them (the account functions are tested separately)');

-- ---------------------------------------------------------------- suspending a school
select pg_temp.check('before: nobody at the school is banned from signing in',
  not exists (select 1 from profiles p join auth.users u on u.id = p.id where p.tenant_id = current_setting('t.a')::uuid and u.banned_until is not null and u.banned_until > now()));
update tenants set status = 'suspended' where id = current_setting('t.a')::uuid;
select pg_temp.check('suspending a school bans every one of its users in the sign-in service',
  (select count(*) from profiles p join auth.users u on u.id = p.id where p.tenant_id = current_setting('t.a')::uuid)
  = (select count(*) from profiles p join auth.users u on u.id = p.id where p.tenant_id = current_setting('t.a')::uuid and u.banned_until > now() + interval '1 year'));
select pg_temp.check('a suspension does not touch other schools',
  not exists (select 1 from profiles p join auth.users u on u.id = p.id where p.tenant_id <> current_setting('t.a')::uuid and u.banned_until is not null));
update tenants set status = 'active' where id = current_setting('t.a')::uuid;
select pg_temp.check('reactivating the school lifts the ban',
  not exists (select 1 from profiles p join auth.users u on u.id = p.id where p.tenant_id = current_setting('t.a')::uuid and u.banned_until is not null));

-- ---------------------------------------------------------------- archiving a learner
select set_config('t.admin', (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.a')::uuid order by id limit 1), true);
select set_config('t.kid', (select s.id::text from students s where s.tenant_id = current_setting('t.a')::uuid and s.active and s.profile_id is not null order by s.id limit 1), true);
select set_config('t.kidprofile', (select profile_id::text from students where id = current_setting('t.kid')::uuid), true);
select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;
select archive_learners(array[current_setting('t.kid')::uuid]);
reset role;
select pg_temp.check('the learner is archived (the roll and billing leave them)',
  (select not active from students where id = current_setting('t.kid')::uuid));
select pg_temp.check('an archived learner can no longer sign in (their account is banned)',
  (select banned_until > now() from auth.users where id = current_setting('t.kidprofile')::uuid) is true, 'FIG-1305');

rollback;
