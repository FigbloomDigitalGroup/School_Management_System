-- Where the apps keep their files: one row, or none (moving files off Supabase Storage to S3, step 2).
--
-- No row: files stay on Supabase Storage, as before. A row: every app built with packages/shared/src/files.ts (the web app
-- and both phone apps) uses the files API at api_url and reads public assets from public_base_url, from its next start. So
-- web and phones switch together, without a rebuild or a new setting in any of them, and switching back is deleting the row.
--
--   insert into files_service (api_url, public_base_url) values ('<FilesApiUrl>', '<PublicAssetsUrl>');   -- switch to S3
--   delete from files_service;                                                                              -- back
--
-- Everyone may read it (the sign-in page shows a school's crest before anyone signs in); only the database's own roles write it.

create table files_service (
  id              boolean primary key default true check (id),
  api_url         text not null check (api_url ~ '^https://[^\s/]+(/[^\s]*)?$'),
  public_base_url text not null check (public_base_url ~ '^https://[^\s/]+(/[^\s]*)?$'),
  switched_at     timestamptz not null default now()
);

alter table files_service enable row level security;
create policy files_service_read on files_service for select to anon, authenticated using (true);
revoke insert, update, delete on files_service from anon, authenticated;
grant select on files_service to anon, authenticated;
