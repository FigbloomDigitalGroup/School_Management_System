-- Where the apps call the edge functions: one row, or none (moving the functions off Supabase to AWS Lambda).
--
-- No row: the database server's own edge runtime (<SUPABASE_URL>/functions/v1), as before. A row: every app built with
-- packages/shared/src/functionsService.ts (the web app and both phone apps) calls base_url/<name> from its next start:
-- figbloom-platform's SchoolsFunctions-<env> (output FunctionsUrl), the same functions on Lambda. Both run against this
-- database, so a call that still goes the old way meanwhile does the same thing.
--
--   insert into functions_service (base_url) values ('<FunctionsUrl>');   -- switch to Lambda
--   delete from functions_service;                                         -- back
--
-- Everyone may read it (sign-in itself calls functions); only the database's own roles write it. As files_service.

create table functions_service (
  id          boolean primary key default true check (id),
  base_url    text not null check (base_url ~ '^https://[^\s/]+(/[^\s]*)?$' and base_url !~ '/$'),
  switched_at timestamptz not null default now()
);

alter table functions_service enable row level security;
create policy functions_service_read on functions_service for select to anon, authenticated using (true);
revoke insert, update, delete on functions_service from anon, authenticated;
grant select on functions_service to anon, authenticated;
