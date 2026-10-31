-- FIG-1313: a school's rows can only point at that school's records.
--
-- A foreign key proves the parent row exists, not that it belongs to the
-- same school. Learners, guardians and invoices had a guard trigger each
-- (enforce_student_tenant and friends), but nothing else did, so a school
-- admin could save, in their own school, a class whose class teacher, a
-- timetable slot whose class and subject, or a vehicle assignment whose
-- driver, route and vehicle all belonged to another school. Nothing of the
-- other school could be read through them today, but one missed tenant_id
-- check in a future query would turn them into a cross-school read.
--
-- Rather than a guard per column (QA found 11 tables open, and 74 more it
-- couldn't test), one trigger function checks every single-column foreign
-- key from a school table (one with tenant_id) to another school table: the
-- referenced row's tenant_id must be the row's own, or empty. Empty covers
-- profiles with no school: Figbloom staff and organization admins, who act
-- in member schools (archived_by, recorded_by and the like). This migration
-- installs it on every such table from the catalog, so the columns are
-- listed once, here, not by hand.
--
-- Left out on purpose: audit_events, impersonation_sessions and
-- organization_access_log, which record access across schools.
--
-- Only rows written from now on are checked; a local database at main had
-- no existing row pointing at another school.
--
-- supabase/rls-checks/same_school_refs.sql checks it, including that every
-- school-to-school foreign key has the trigger, so a new table can't be
-- forgotten.

-- tg_argv: pairs of (column, referenced table); every referenced key is a uuid id
create or replace function enforce_same_school_refs() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  rec jsonb := to_jsonb(new);
  prev jsonb;
  col text;
  ref_table text;
  ref_id uuid;
  ref_tenant uuid;
  i int := 0;
begin
  if tg_op = 'UPDATE' then prev := to_jsonb(old); end if;
  while i < tg_nargs loop
    col := tg_argv[i];
    ref_table := tg_argv[i + 1];
    i := i + 2;
    ref_id := (rec ->> col)::uuid;
    continue when ref_id is null;
    -- an update that leaves this reference and the school alone needs no lookup
    continue when tg_op = 'UPDATE' and rec -> col is not distinct from prev -> col
                  and rec -> 'tenant_id' is not distinct from prev -> 'tenant_id';
    execute format('select tenant_id from %I where id = $1', ref_table) into ref_tenant using ref_id;
    if ref_tenant is not null and ref_tenant is distinct from (rec ->> 'tenant_id')::uuid then
      raise exception 'One of the records chosen belongs to another school.'
        using errcode = '42501', detail = format('%s.%s points at %s %s', tg_table_name, col, ref_table, ref_id);
    end if;
  end loop;
  return new;
end $$;

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
       and s.relname not in ('audit_events', 'impersonation_sessions', 'organization_access_log')
     group by s.relname
  loop
    execute format('create trigger %I before insert or update on %I for each row execute function enforce_same_school_refs(%s)',
                   left(t.tbl, 50) || '_same_school', t.tbl, t.args);
  end loop;
end $$;
