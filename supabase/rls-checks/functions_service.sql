-- functions_service (20261110150000): where the apps call the edge functions. Anyone may read it; nobody but the
-- database's own roles may change it; one row at most; an https address with no trailing slash.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/functions_service.sql

\set ON_ERROR_STOP 1
begin;
delete from functions_service;

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when ok then 'PASS' else 'FAIL' end, label; end $$;
grant execute on all functions in schema pg_temp to anon, authenticated;

set local role anon;
select pg_temp.check('anyone can read it: no row means the server''s edge runtime', (select count(*) from functions_service) = 0);
reset role;

insert into functions_service (base_url) values ('https://lambda.example/functions/v1');
set local role anon;
select pg_temp.check('anyone can read the row, before signing in (sign-in calls functions)', (select base_url from functions_service) = 'https://lambda.example/functions/v1');
reset role;

do $$ begin
  begin
    set local role authenticated;
    update functions_service set base_url = 'https://evil.example';
    raise notice 'FAIL a signed-in user changed where functions are called';
  exception when insufficient_privilege then raise notice 'PASS a signed-in user cannot change where functions are called';
  end;
  reset role;
  begin
    set local role authenticated;
    delete from functions_service;
    raise notice 'FAIL a signed-in user deleted the row';
  exception when insufficient_privilege then raise notice 'PASS a signed-in user cannot delete the row';
  end;
  reset role;
  begin
    insert into functions_service (id, base_url) values (true, 'https://x.example');
    raise notice 'FAIL a second row';
  exception when unique_violation then raise notice 'PASS one row at most';
  end;
  begin
    update functions_service set base_url = 'http://plain.example';
    raise notice 'FAIL a plain-http address';
  exception when check_violation then raise notice 'PASS https addresses only';
  end;
  begin
    update functions_service set base_url = 'https://x.example/functions/v1/';
    raise notice 'FAIL a trailing slash';
  exception when check_violation then raise notice 'PASS no trailing slash';
  end;
end $$;

rollback;
