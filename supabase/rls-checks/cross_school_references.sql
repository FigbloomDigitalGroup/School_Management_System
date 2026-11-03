-- Cross-school references (QA 03, FIG-1236): can a school admin put a row in THEIR OWN school that points at ANOTHER school's
-- records (its learner, guardian, invoice, class, route, ...)?
--
-- A foreign key only proves the parent row exists, wherever it lives, so it cannot stop this. Only a trigger or a policy can,
-- and most tables have neither (the catalog shows 218 single-column references between school tables, none composite with
-- tenant_id, and about 21 tables with a "same school" guard trigger).
--
-- Runs against a local database that has the migrations applied and `npm run db:seed` plus `npm run db:seed-org` data (two
-- schools: Alliance and Kijani Ridge), inside one transaction that is rolled back. For every table that has a tenant_id and
-- holds a real row in a school X:
--   CONTROL  the admin of X puts a copy of that row back into X (the original is removed first, so no unique key is in the
--            way). This shows a school admin can insert into the table at all.
--   ATTACK   the admin of the OTHER school Y inserts a copy into Y: same columns, so every reference points at X's rows, only
--            tenant_id is Y's. A FAIL is an accepted row. Refused by a policy or a guard trigger is a PASS. A constraint
--            error after the policy let it through (unique, check, not-null, foreign key) is a REVIEW: the policy did not stop it.
-- Tables with no real row in either school print NOT TESTED; they are not a quiet PASS.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/cross_school_references.sql
-- Check the psql exit code too. Do not run it while e2e is running.

\set ON_ERROR_STOP 1
begin;

create temp table qa_xref (src text, tbl text, status text, detail text);

-- One insert, as one user, undone straight away. The template row is copied first, then removed (as the owner, with triggers
-- off), then the copy is inserted by the actor with tenant_id set to p_to.
create function pg_temp.clone_insert(p_tbl text, p_src uuid, p_to uuid, p_actor uuid, p_cond text)
returns table (has_row boolean, n bigint, code text, msg text) language plpgsql as $$
declare cols text; vals text; tid tid;
begin
  has_row := false; n := null; code := null; msg := null;
  execute format('select ctid from public.%I where tenant_id = %L and (%s) order by ctid limit 1', p_tbl, p_src, p_cond) into tid;
  if tid is null then return next; return; end if;
  has_row := true;
  select string_agg(quote_ident(attname), ', ' order by attnum),
         string_agg(case when attname = 'tenant_id' then quote_literal(p_to::text) || '::uuid'
                         when attname = 'id' and atttypid = 'uuid'::regtype then 'gen_random_uuid()'
                         else quote_ident(attname) end, ', ' order by attnum)
    into cols, vals
    from pg_attribute
   where attrelid = ('public.' || quote_ident(p_tbl))::regclass and attnum > 0 and not attisdropped and attgenerated = '' and attidentity <> 'a';
  begin
    execute format('create temp table qa_tmpl as select * from public.%I where ctid = %L', p_tbl, tid);
    execute 'grant select on pg_temp.qa_tmpl to authenticated';
    execute 'set local session_replication_role = replica';
    execute format('delete from public.%I where ctid = %L', p_tbl, tid);
    execute 'set local session_replication_role = origin';
    perform set_config('request.jwt.claims', json_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
    set local role authenticated;
    execute format('insert into public.%I (%s) select %s from pg_temp.qa_tmpl', p_tbl, cols, vals);
    get diagnostics n = row_count;
    reset role;
    raise exception using errcode = 'QA003';
  exception when others then
    if sqlstate <> 'QA003' then code := sqlstate; msg := sqlerrm; end if;
  end;
  return next;
end $$;

create function pg_temp.run() returns void language plpgsql as $$
declare
  s record; o record; t record; ctl record; atk record; refcols text; cond text;
begin
  for s in select slug, id from tenants where slug in ('alliance', 'kijani-ridge') order by slug loop
    select slug, id into o from tenants where slug in ('alliance', 'kijani-ridge') and slug <> s.slug;
    for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind = 'r'
                and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
              order by c.relname loop
      -- the columns of this table that hold the id of a row of another school-owned table (profiles included)
      select string_agg(quote_ident(a.attname), ', ' order by a.attname), string_agg(quote_ident(a.attname) || ' is not null', ' or ' order by a.attname)
        into refcols, cond
        from pg_constraint con join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
       where con.contype = 'f' and con.conrelid = ('public.' || quote_ident(t.relname))::regclass and array_length(con.conkey, 1) = 1
         and a.attname <> 'tenant_id'
         and exists (select 1 from pg_attribute x where x.attrelid = con.confrelid and x.attname = 'tenant_id' and not x.attisdropped);
      if refcols is null then
        insert into qa_xref values (s.slug, t.relname, 'N/A', 'no column points at another school-owned table, so there is nothing to cross-reference');
        continue;
      end if;
      -- Nobody can insert an invoice that already has money on it (the paid_cents guard), so a control built from a paid invoice
      -- is refused and the whole table drops out as N/A. Which row came first used to decide that; now it always uses an unpaid one.
      if t.relname = 'fee_invoices' then cond := '(' || cond || ') and paid_cents = 0 and status::text = ''unpaid'''; end if;
      select * into ctl from pg_temp.clone_insert(t.relname, s.id, s.id,
        (select id from profiles where tenant_id = s.id and role = 'school_admin' order by id limit 1), cond);
      if not ctl.has_row then
        insert into qa_xref values (s.slug, t.relname, 'NOT TESTED', 'no real row in ' || s.slug || ' with a filled reference (' || refcols || ')');
        continue;
      end if;
      if ctl.code is not null or coalesce(ctl.n, 0) = 0 then
        insert into qa_xref values (s.slug, t.relname, 'N/A', 'the school admin cannot insert here at all (control refused: ' || coalesce(left(ctl.msg, 80), '0 rows') || ')');
        continue;
      end if;
      select * into atk from pg_temp.clone_insert(t.relname, s.id, o.id,
        (select id from profiles where tenant_id = o.id and role = 'school_admin' order by id limit 1), cond);
      insert into qa_xref values (s.slug, t.relname,
        case when atk.code is null and coalesce(atk.n, 0) > 0 then 'FAIL'
             when atk.code is null then 'REVIEW'
             when atk.code like '23%' then 'REVIEW'
             else 'PASS' end,
        case when atk.code is null and coalesce(atk.n, 0) > 0 then o.slug || ' admin saved a row in ' || o.slug || ' that points at ' || s.slug || '''s records through: ' || refcols
             when atk.code is null then 'ran, 0 rows'
             when atk.code like '23%' then 'got past the policy, stopped by a constraint (' || atk.code || ' ' || left(atk.msg, 90) || ')'
             else 'refused (' || atk.code || ' ' || left(atk.msg, 90) || ')' end);
    end loop;
  end loop;
end $$;

select pg_temp.run();

do $$
declare r record;
begin
  for r in select src, tbl, status, detail from qa_xref where status in ('FAIL', 'REVIEW', 'PASS') order by status desc, src, tbl loop
    raise notice '% % (rows of %): %', r.status, r.tbl, r.src, r.detail;
  end loop;
  for r in select status, count(*) c, count(distinct tbl) tables from qa_xref group by status order by status loop
    raise notice 'TOTAL %: % checks on % tables', rpad(r.status, 10), r.c, r.tables;
  end loop;
  raise notice 'NOT TESTED in BOTH schools (no real row anywhere): %',
    (select string_agg(tbl, ', ' order by tbl) from (select tbl from qa_xref group by tbl having bool_and(status = 'NOT TESTED')) x);
  raise notice 'RESULT: %', case when exists (select 1 from qa_xref where status = 'FAIL') then 'FAIL' else 'PASS (read the REVIEW and NOT TESTED lines)' end;
end $$;

rollback;
