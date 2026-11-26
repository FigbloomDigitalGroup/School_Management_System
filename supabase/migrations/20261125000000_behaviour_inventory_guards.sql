-- Brings the stock movements (20261124200000) and behaviour log (20261124400000)
-- tables up to the rules every school table follows. supabase/rls-checks found
-- three gaps after both went live on 2026-11-24:
--
-- 1. Audit (20261104000000): every table in audit_table_config has an insert,
--    an update and a delete trigger. These five had only some of them, so a
--    change to a behaviour entry or a deleted movement wasn't logged.
--    audit_log.sql: "each table in audit_table_config has its insert, update and
--    delete triggers".
--
-- 2. Same school (20261103600000, 20261105300000): every reference from one
--    school table to another goes through enforce_same_school_refs, so a row
--    can't point at another school's item, learner, class or person. None of
--    the five tables had it. Row-level security already kept users to their
--    own school; this is the second lock that also holds for security definer
--    functions and the server. A profile with no school (super admins and org
--    admins) passes, as everywhere else. The trigger is named zz_..., so it
--    runs after inventory_movements_apply and behaviour_entry_prepare and
--    checks the row as it will be written. same_school_refs.sql.
--
-- 3. behaviour_period(p_tenant, p_reset, p_on) is an internal helper of
--    behaviour_points, but signed-in users could call it for any school and
--    get that school's term dates. No app calls it (the apps work the period
--    out in packages/shared/src/behaviour.ts), and behaviour_points is security
--    definer, so it keeps calling it as the owner. tenant_matrix.sql.
--
-- Nothing else changes: no data is touched, and existing rows aren't
-- re-checked. Works with and without the four pending attendance migrations
-- (20261110160000-20261110190000) and with or without 20261124500000.

-- 1. audit triggers: add whichever of the three are missing, keyed on the
--    primary key, the same way 20261104000000 installs them
do $$
declare
  c record;
  keys text;
  ev text;
  trg text;
begin
  for c in select * from audit_table_config
            where table_name in ('inventory_movements', 'behaviour_settings', 'behaviour_categories',
                                 'behaviour_entries', 'behaviour_staff_notes') loop
    select string_agg(a.attname, ',' order by array_position(i.indkey, a.attnum))
      into keys
      from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
     where i.indrelid = format('public.%I', c.table_name)::regclass and i.indisprimary;

    foreach ev in array array['ins', 'upd', 'del'] loop
      trg := left(c.table_name, 50) || '_audit_' || ev;
      continue when exists (select 1 from pg_trigger
                             where tgrelid = format('public.%I', c.table_name)::regclass and tgname = trg);
      execute format(
        case ev
          when 'ins' then 'create trigger %I after insert on %I referencing new table as new_rows for each statement execute function audit_table_change(%L, %L, %L)'
          when 'upd' then 'create trigger %I after update on %I referencing old table as old_rows new table as new_rows for each statement execute function audit_table_change(%L, %L, %L)'
          else            'create trigger %I after delete on %I referencing old table as old_rows for each statement execute function audit_table_change(%L, %L, %L)'
        end,
        trg, c.table_name, c.category, c.keep_values, coalesce(keys, ''));
    end loop;
  end loop;
end $$;

-- 2. same-school triggers: one per table over every reference to another
--    school table (the same query as 20261103600000), replacing any earlier one
do $$
declare
  t record;
begin
  for t in
    with school as (
      select c.oid, c.relname
        from pg_class c
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
       where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
    )
    select s.relname as tbl,
           string_agg(quote_literal(a.attname) || ', ' || quote_literal(r.relname), ', ' order by a.attname) as args
      from pg_constraint k
      join school s on s.oid = k.conrelid
      join school r on r.oid = k.confrelid
      join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
     where k.contype = 'f' and array_length(k.conkey, 1) = 1 and a.attname <> 'tenant_id'
       and s.relname in ('inventory_movements', 'behaviour_settings', 'behaviour_categories',
                         'behaviour_entries', 'behaviour_staff_notes')
     group by s.relname
  loop
    execute format('drop trigger if exists %I on %I', 'zz_' || left(t.tbl, 50) || '_same_school', t.tbl);
    execute format('create trigger %I before insert or update on %I for each row execute function enforce_same_school_refs(%s)',
                   'zz_' || left(t.tbl, 50) || '_same_school', t.tbl, t.args);
  end loop;
end $$;

-- 3. behaviour_period is internal to behaviour_points
revoke execute on function behaviour_period(uuid, text, date) from public, anon, authenticated;
grant execute on function behaviour_period(uuid, text, date) to service_role;
