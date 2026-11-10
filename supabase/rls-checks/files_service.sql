-- files_service (20261110130000): where the apps keep their files. Anyone may read it; nobody but the database's own roles
-- may change it; one row at most; https addresses only.
--
-- Runs against a local database with the migrations applied, inside one transaction that is rolled back.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/files_service.sql

\set ON_ERROR_STOP 1
begin;
delete from files_service;

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when ok then 'PASS' else 'FAIL' end, label; end $$;
grant execute on all functions in schema pg_temp to anon, authenticated;

set local role anon;
select pg_temp.check('anyone can read it: no row means Supabase Storage', (select count(*) from files_service) = 0);
reset role;

insert into files_service (api_url, public_base_url) values ('https://files.example', 'https://cdn.example');
set local role anon;
select pg_temp.check('anyone can read the row, before signing in (the sign-in page shows a crest)', (select api_url from files_service) = 'https://files.example');
reset role;

do $$ begin
  begin
    set local role authenticated;
    update files_service set api_url = 'https://evil.example';
    raise notice 'FAIL a signed-in user changed where files go';
  exception when insufficient_privilege then raise notice 'PASS a signed-in user cannot change where files go';
  end;
  reset role;
  begin
    set local role authenticated;
    delete from files_service;
    raise notice 'FAIL a signed-in user switched files back';
  exception when insufficient_privilege then raise notice 'PASS a signed-in user cannot delete the row';
  end;
  reset role;
  begin
    insert into files_service (id, api_url, public_base_url) values (true, 'https://x.example', 'https://y.example');
    raise notice 'FAIL a second row';
  exception when unique_violation then raise notice 'PASS one row at most';
  end;
  begin
    update files_service set api_url = 'http://plain.example';
    raise notice 'FAIL a plain-http address';
  exception when check_violation then raise notice 'PASS https addresses only';
  end;
end $$;

rollback;
