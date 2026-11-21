-- Switches Figbloom Schools' files to S3, in one transaction (files-to-s3.ps1 -Step switch runs it on the server):
--
--   1. Public file addresses saved in full in the tables (profile photos, school crests, ...) point at CloudFront instead
--      of this server's storage: :old_prefix becomes :new_prefix, at the same path (the files were copied at the same
--      paths). Every text and json column in public, except audit_events (history stays as it was) and generated
--      columns, with triggers off so no audit rows or notifications come of it (as rewrite-cloud-links.sh).
--   2. The files_service row: from their next start the apps use the files API (packages/shared/src/files.ts).
--
-- Variables: old_prefix  'https://schools-db.figbloom.org/storage/v1/object/public/public-assets/'
--            new_prefix  'https://<PublicAssetsUrl host>/'
--            api_url, public_base_url   the SchoolsFiles-<env> outputs
-- switch-back.sql undoes both.
\set ON_ERROR_STOP 1
begin;
set local session_replication_role = replica;
create temp table links (old text, new text) on commit drop;
insert into links values (:'old_prefix', :'new_prefix');
do $$
declare
  c record;
  n bigint;
  total bigint := 0;
  o text := (select old from links);
  w text := (select new from links);
begin
  for c in
    select col.table_name t, col.column_name k, col.data_type d
    from information_schema.columns col
    join information_schema.tables tb using (table_schema, table_name)
    where col.table_schema = 'public' and tb.table_type = 'BASE TABLE' and col.table_name <> 'audit_events'
      and col.data_type in ('text', 'character varying', 'json', 'jsonb') and col.is_generated = 'NEVER'
  loop
    execute format('update public.%I set %I = replace(%I::text, %L, %L)::%s where %I::text like %L',
      c.t, c.k, c.k, o, w, c.d, c.k, '%' || o || '%');
    get diagnostics n = row_count;
    if n > 0 then raise notice '%.% rewritten=%', c.t, c.k, n; total := total + n; end if;
  end loop;
  raise notice 'total_rewritten=%', total;
end $$;

insert into files_service (id, api_url, public_base_url) values (true, :'api_url', :'public_base_url')
  on conflict (id) do update set api_url = excluded.api_url, public_base_url = excluded.public_base_url, switched_at = now();

-- Anything still pointing at this server's storage (another kind of link than a public file), for a person to look at
do $$
declare c record; n bigint;
begin
  for c in
    select col.table_name t, col.column_name k
    from information_schema.columns col join information_schema.tables tb using (table_schema, table_name)
    where col.table_schema = 'public' and tb.table_type = 'BASE TABLE' and col.table_name not in ('audit_events', 'files_service')
      and col.data_type in ('text', 'character varying', 'json', 'jsonb')
  loop
    execute format('select count(*) from public.%I where %I::text like %L', c.t, c.k, '%/storage/v1/%') into n;
    if n > 0 then raise notice 'still_links_to_storage %.%=%', c.t, c.k, n; end if;
  end loop;
end $$;
select 'switched: files_service = ' || api_url || ' , ' || public_base_url from files_service;
commit;
