-- First-sign-in password checks for 20261104400000 (FIG-1338).
--
-- Runs against a local database that has the migrations applied and
-- `npm run db:seed` data, inside one transaction that is rolled back.
-- Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/first_password.sql

\set ON_ERROR_STOP 1
begin;

select set_config('t.driver', (select p.id::text from profiles p join tenants t on t.id = p.tenant_id
   where t.slug = 'alliance' and p.role = 'driver' order by p.id limit 1), true);

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when coalesce(ok, false) then 'PASS' else 'FAIL' end, label; end $$;
create function pg_temp.flag() returns boolean language sql as $$
  select must_change_password from profiles where id = current_setting('t.driver')::uuid
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- the office has just given the driver a temporary password
update profiles set must_change_password = true where id = current_setting('t.driver')::uuid;

-- the driver tries to clear the flag without choosing a password
select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.driver'), 'role', 'authenticated')::text, true);
set local role authenticated;
update profiles set must_change_password = false where id = current_setting('t.driver')::uuid;
reset role;
select set_config('request.jwt.claims', '', true);
select pg_temp.check('the person can''t clear the first-sign-in flag on their own', pg_temp.flag());

-- choosing a password (Auth updates encrypted_password) clears it
update auth.users set encrypted_password = crypt('a-new-password', gen_salt('bf')) where id = current_setting('t.driver')::uuid;
select pg_temp.check('choosing a password clears it', not pg_temp.flag());

-- the admin reset: new temporary password first, then the flag, as reset-user-password does
update auth.users set encrypted_password = crypt('temp-123456', gen_salt('bf')) where id = current_setting('t.driver')::uuid;
update profiles set must_change_password = true where id = current_setting('t.driver')::uuid;
select pg_temp.check('an admin reset still leaves the flag set', pg_temp.flag());

-- other own-profile edits are unaffected
select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.driver'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$ begin
  update profiles set phone = phone where id = current_setting('t.driver')::uuid;
  raise notice 'PASS the person can still save the rest of their own profile';
exception when others then raise notice 'FAIL the person''s own profile edit: % %', sqlstate, sqlerrm; end $$;
reset role;

rollback;
