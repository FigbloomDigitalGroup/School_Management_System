-- Undoes switch.sql, in one transaction: the apps go back to Supabase Storage from their next start, and public file
-- addresses point at this server's storage again. Files uploaded to S3 meanwhile are not copied back: copy them first
-- if anyone uploaded since the switch (aws s3 cp from the buckets, then the storage API), or they will be missing.
--
-- Variables as switch.sql (old_prefix, new_prefix); api_url and public_base_url are not needed.
\set ON_ERROR_STOP 1
begin;
set local session_replication_role = replica;
create temp table links (old text, new text) on commit drop;
insert into links values (:'new_prefix', :'old_prefix');
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
delete from files_service;
select 'switched back: files on Supabase Storage';
commit;
