-- The same-school check (20261103600000, FIG-1313) runs after the triggers
-- that fill a row in.
--
-- Postgres fires a table's BEFORE triggers in name order. The check was
-- installed as <table>_same_school, which sorts ahead of <table>_stamp, so it
-- read the row before the stamp trigger had set its school. chat_messages is
-- the one people hit: the app sends a message without tenant_id (the stamp
-- trigger takes it from the conversation), the check saw an empty school
-- pointing at a conversation in a real one, and every message was refused
-- with "One of the records chosen belongs to another school." The activity
-- tables, whose stamp triggers also take the school from the parent row,
-- had the same order.
--
-- Every trigger that calls enforce_same_school_refs() is renamed with a zz_
-- prefix, so it fires after the table's other BEFORE triggers and checks the
-- row as it will be written. Nothing else changes: same function, same
-- columns. A trigger added later that fills in a referenced column or
-- tenant_id must also sort before zz_; supabase/rls-checks/same_school_refs.sql
-- checks that none sorts after.

do $$
declare
  t record;
begin
  for t in
    select tg.tgname, c.relname
      from pg_trigger tg
      join pg_proc p on p.oid = tg.tgfoid
      join pg_class c on c.oid = tg.tgrelid
     where p.proname = 'enforce_same_school_refs'
       and c.relnamespace = 'public'::regnamespace
       and tg.tgname not like 'zz\_%'
  loop
    -- old names are at most 62 characters, the limit is 63
    execute format('alter trigger %I on %I rename to %I', t.tgname, t.relname, 'zz_' || left(t.tgname, 60));
  end loop;
end $$;
