-- Cross-school isolation matrix (QA 03, FIG-1236): can school A touch school B's data?
--
-- Data-driven: it reads the catalog, so a new table with a tenant_id column is covered without editing this file.
-- For EVERY public table that has a tenant_id, each actor below tries to read, insert, update and delete the OTHER
-- school's rows:
--   * a school admin, teacher, parent, student and driver from each of the two seeded schools (Alliance and
--     Kijani Ridge), each attacking the other school;
--   * the org admin of the Kijani Ridge Group, attacking Alliance (a school outside their organization);
--   * an anonymous visitor, attacking both.
-- Most tables are empty in the seed, and "no rows visible" in an empty table proves nothing, so for a school that
-- has no row in a table a synthetic fixture row is created first (foreign keys and triggers off, as postgres).
-- The attacks then run with triggers and row-level security ON, each in its own rolled-back sub-transaction.
--
-- How an INSERT is read: Postgres checks row-level security BEFORE constraints. So 42501 means refused by a
-- policy or a missing grant; an error from a BEFORE trigger (P0001) means a trigger refused it; but a constraint
-- error (class 23: unique, foreign key, not null, check) means the policy had already let the row through, so
-- that cell is a FAIL. An insert that lands in the actor's own school (a trigger rewrote tenant_id) is a PASS.
--
-- An attack that a BEFORE trigger refuses (they run before row-level security) is a PASS, but it is then retried
-- with the table's triggers switched off, to see whether row-level security alone would also have stopped it. If
-- not, the cell is still a PASS and its detail starts with TRIGGER-ONLY: the isolation rests on one trigger.
-- Fixture rows are made with foreign keys, triggers and CHECK constraints off (only inside this rolled-back
-- transaction), so every table can be given a row to attack.
--
-- Before the real run a CANARY proves the matrix can see a leak: a deliberately open policy is added to one table
-- and every operation must be reported as FAIL. If the canary is not caught, everything after it means nothing.
--
-- Runs against a local database that has the migrations applied, `npm run db:seed` and `npm run db:seed-org`,
-- inside one transaction that is rolled back. Prints PASS / FAIL / SKIP per table and operation.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/tenant_matrix.sql
--   add  -v cells=1  to also print every single cell as  run|school attacked|actor|table|operation|status|detail

\set ON_ERROR_STOP 1
begin;

create temp table qa_actor   (actor text primary key, tenant_slug text, pgrole text, user_id uuid);
create temp table qa_fixture (victim text, tbl text, kind text, reason text);
create temp table qa_results (run text, victim text, actor text, tbl text, op text, status text, detail text);

-- ---------------------------------------------------------------- actors
insert into qa_actor
select s.slug || ':' || r, s.slug, 'authenticated',
       (select p.id from profiles p where p.tenant_id = s.id and p.role::text = r order by p.created_at, p.id limit 1)
  from tenants s, unnest(array['school_admin', 'teacher', 'parent', 'student', 'driver']) r
 where s.slug in ('alliance', 'kijani-ridge');
insert into qa_actor
  select 'org_admin', null, 'authenticated', (select id from profiles where role::text = 'org_admin' order by created_at limit 1);
insert into qa_actor values ('anon', null, 'anon', null);

do $$ begin
  if exists (select 1 from qa_actor where user_id is null and actor <> 'anon') then
    raise exception 'QA03 setup: seeded user(s) missing (%). Run npm run db:seed, then npm run db:seed-org.',
      (select string_agg(actor, ', ') from qa_actor where user_id is null and actor <> 'anon');
  end if;
end $$;

-- A second organization, so "an org admin reaches only the schools of their own organization" is tested against a real
-- other organization: Alliance joins it (inside this rolled-back transaction only).
create temp table qa_org2 as
  with o as (insert into organizations (name, slug, kind, status) values ('QA03 other group', 'qa03-other-group', 'group_owner', 'active') returning id)
  select id from o;
update tenants set organization_id = (select id from qa_org2) where slug = 'alliance';

create temp table qa_tables as
select c.oid as oid, c.relname::text as tbl, row_number() over (order by c.relname) as n
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
 where ns.nspname = 'public' and c.relkind = 'r'
   and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id'
                                                and not a.attisdropped and a.atttypid = 'uuid'::regtype);

-- ---------------------------------------------------------------- helpers
-- A harmless value for a NOT NULL column, by type, for the synthetic fixture rows.
create function pg_temp.qa_dummy(p_typ oid) returns text language sql as $$
  select case
    when t.typtype = 'e' then quote_literal((select enumlabel from pg_enum where enumtypid = t.oid order by enumsortorder limit 1))
    when t.typcategory = 'A' then quote_literal('{}')
    when t.typname = 'uuid' then 'gen_random_uuid()'
    when t.typname in ('text', 'varchar', 'bpchar', 'citext', 'name') then 'left(md5(random()::text), 8)'
    when t.typname in ('int2', 'int4', 'int8', 'numeric', 'float4', 'float8') then '1'
    when t.typname = 'bool' then 'false'
    when t.typname = 'date' then 'current_date'
    when t.typname in ('timestamp', 'timestamptz') then 'now()'
    when t.typname = 'time' then quote_literal('08:00')
    when t.typname in ('json', 'jsonb') then quote_literal('{}')
    when t.typname = 'interval' then quote_literal('1 day')
    when t.typname = 'bytea' then quote_literal('\x00')
    else null end
  from pg_type t where t.oid = p_typ
$$;

-- Sign in as an actor for the rest of the (sub-)transaction.
create function pg_temp.qa_become(p_user uuid, p_pgrole text) returns void language plpgsql as $$
begin
  if p_pgrole = 'anon' then
    perform set_config('request.jwt.claims', '', true);
    set local role anon;
  else
    perform set_config('request.jwt.claims', json_build_object('sub', p_user::text, 'role', 'authenticated')::text, true);
    set local role authenticated;
  end if;
end $$;

-- ---------------------------------------------------------------- fixtures: a row for each school in each table
do $$
declare
  v record; t record; c record; cnt bigint; cols text; vals text; fx text;
begin
  for v in select slug, id, case slug when 'alliance' then 'a' else 'k' end as tag
             from tenants where slug in ('alliance', 'kijani-ridge') loop
    for t in select * from qa_tables order by n loop
      fx := format('qa_fx_%s_%s', t.n, v.tag);
      execute format('select count(*) from public.%I where tenant_id = %L', t.tbl, v.id) into cnt;
      if cnt > 0 then
        execute format('create temp table %I as select * from public.%I where tenant_id = %L limit 1', fx, t.tbl, v.id);
        execute format('grant select on pg_temp.%I to authenticated, anon', fx);
        insert into qa_fixture values (v.slug, t.tbl, 'real', null);
      else
        begin
          execute 'set local session_replication_role = replica';   -- foreign keys and triggers off for the fixture only (set_config() is refused for this one setting)
          select string_agg(quote_ident(a.attname), ', ' order by a.attnum),
                 string_agg(case when a.attname = 'tenant_id' then quote_literal(v.id) else pg_temp.qa_dummy(a.atttypid) end, ', ' order by a.attnum)
            into cols, vals
            from pg_attribute a
           where a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped and a.attgenerated = '' and a.attidentity <> 'a'
             and (a.attname = 'tenant_id' or a.attnotnull);
          for c in select conname from pg_constraint where conrelid = t.oid and contype = 'c' loop
            execute format('alter table public.%I drop constraint %I', t.tbl, c.conname);   -- rolled back with everything else
          end loop;
          execute format('insert into public.%I (%s) values (%s)', t.tbl, cols, vals);
          execute format('create temp table %I as select * from public.%I where tenant_id = %L limit 1', fx, t.tbl, v.id);
          execute format('grant select on pg_temp.%I to authenticated, anon', fx);
          execute 'set local session_replication_role = origin';
          insert into qa_fixture values (v.slug, t.tbl, 'synthetic', null);
        exception when others then
          execute 'set local session_replication_role = origin';
          insert into qa_fixture values (v.slug, t.tbl, 'none', sqlstate || ' ' || sqlerrm);
        end;
      end if;
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------- the attacks
create function pg_temp.qa_put(p_run text, p_victim text, p_actor text, p_tbl text, p_op text, p_status text, p_detail text)
returns void language sql as $$ insert into qa_results values (p_run, p_victim, p_actor, p_tbl, p_op, p_status, p_detail) $$;

-- One attempt, as an actor, undone straight away. p_mode: count (select count(*)), rowcount (a write), returning (an insert).
create function pg_temp.qa_run(p_user uuid, p_pgrole text, p_sql text, p_mode text, p_triggers_off_on text)
returns table (n bigint, ret uuid, code text, msg text, ctx text) language plpgsql as $$
begin
  n := null; ret := null; code := null; msg := null; ctx := null;
  begin
    if p_triggers_off_on is not null then execute format('alter table public.%I disable trigger user', p_triggers_off_on); end if;
    perform pg_temp.qa_become(p_user, p_pgrole);
    if p_mode = 'count' then execute p_sql into n;
    elsif p_mode = 'rowcount' then execute p_sql; get diagnostics n = row_count;
    else execute p_sql into ret; end if;
    raise exception using errcode = 'QA003';
  exception when others then
    if sqlstate <> 'QA003' then
      code := sqlstate; msg := sqlerrm;
      get stacked diagnostics ctx = pg_exception_context;   -- names the trigger/function that raised it, if one did
    end if;
  end;
  return next;
end $$;

-- Reads an attempt's outcome. Anything that changed or revealed the other school's data is a FAIL, a refusal is a PASS.
-- An error raised inside a trigger or function (its call context names a PL/pgSQL function) is a refusal whatever its
-- code (a trigger may use 23503 for "that parent could not be found"). A class 23 error WITHOUT such a context is a
-- real constraint, raised AFTER the policy check, so the policy let the statement through. Anything else is ERROR.
-- Did the error come out of the application's own trigger or function? The call context lists every PL/pgSQL frame, and
-- this script's own helpers (qa_*, the DO blocks) are always among them, so those are ignored.
create function pg_temp.qa_raised_by_app(p_ctx text) returns boolean language sql as $$
  select exists (select 1 from regexp_matches(coalesce(p_ctx, ''), 'PL/pgSQL function ([^ (]+)', 'g') m
                  where m[1] !~ '(^|\.)qa_' and m[1] !~ '^inline_code_block')
$$;

create function pg_temp.qa_judge(p_kind text, p_n bigint, p_ret uuid, p_code text, p_msg text, p_ctx text, p_victim uuid)
returns table (status text, detail text, by_trigger boolean) language plpgsql as $$
begin
  by_trigger := false;
  if p_code = '42501' then status := 'PASS'; detail := 'refused (42501)';
  elsif p_code is not null and (p_code like 'P0%' or p_code = '22023' or pg_temp.qa_raised_by_app(p_ctx)) then
    status := 'PASS'; detail := 'refused by a trigger or function: ' || left(p_msg, 90); by_trigger := true;
  elsif p_code like '23%' then status := 'FAIL'; detail := 'the policy let it through; only a constraint stopped it (' || p_code || ' ' || left(p_msg, 80) || ')';
  elsif p_code is not null then status := 'ERROR'; detail := p_code || ' ' || left(p_msg, 120);
  elsif p_kind = 'select' then
    if p_n > 0 then status := 'FAIL'; detail := 'can read ' || p_n || ' row(s)'; else status := 'PASS'; detail := 'no rows visible'; end if;
  elsif p_kind = 'update' then
    if p_n > 0 then status := 'FAIL'; detail := 'changed ' || p_n || ' row(s) of the other school'; else status := 'PASS'; detail := 'no rows changed'; end if;
  elsif p_kind = 'move' then
    if p_n > 0 then status := 'FAIL'; detail := 'moved ' || p_n || ' own row(s) into the other school'; else status := 'PASS'; detail := 'no rows moved'; end if;
  elsif p_kind = 'delete' then
    if p_n > 0 then status := 'FAIL'; detail := 'deleted ' || p_n || ' row(s)'; else status := 'PASS'; detail := 'no rows deleted'; end if;
  elsif p_kind = 'insert_n' then
    if p_n > 0 then status := 'FAIL'; detail := 'inserted a row that belongs to the other school'; else status := 'PASS'; detail := 'nothing inserted'; end if;
  elsif p_kind = 'insert' then
    if p_ret = p_victim then status := 'FAIL'; detail := 'inserted a row into the other school';
    elsif p_ret is not null then status := 'PASS'; detail := 'row was rewritten into the actor''s own school';
    else status := 'ERROR'; detail := 'insert returned no row'; end if;
  end if;
  return next;
end $$;

create function pg_temp.qa_attack(p_run text, p_tables text[], p_actors text[], p_victims text[]) returns void language plpgsql as $$
declare
  a record; v record; t record; r record; j record; j2 record; retest record;
  kind text; fx text; collist text; sellist text; own_id uuid; sql text; mode text; k text; op text;
  worst text; worst_detail text;
begin
  for a in select * from qa_actor where p_actors is null or actor = any (p_actors) order by actor loop
    select id into own_id from tenants where slug = a.tenant_slug;
    for v in select s.slug, s.id, case s.slug when 'alliance' then 'a' else 'k' end as tag
               from tenants s
              where s.slug in ('alliance', 'kijani-ridge')
                and (case when p_victims is not null then s.slug = any (p_victims)
                          else a.actor = 'anon' or (a.actor = 'org_admin' and s.slug = 'alliance')
                               or (a.tenant_slug is not null and s.slug <> a.tenant_slug) end) loop
      for t in select * from qa_tables where p_tables is null or tbl = any (p_tables) order by tbl loop
        select f.kind into kind from qa_fixture f where f.victim = v.slug and f.tbl = t.tbl;
        if kind is null or kind = 'none' then
          perform pg_temp.qa_put(p_run, v.slug, a.actor, t.tbl, o, 'NOT TESTED',
                                 coalesce((select f.reason from qa_fixture f where f.victim = v.slug and f.tbl = t.tbl), 'no fixture'))
            from unnest(array['select', 'insert', 'update', 'delete']) o;
          continue;
        end if;
        fx := format('qa_fx_%s_%s', t.n, v.tag);
        select string_agg(quote_ident(attname), ', ' order by attnum),
               string_agg(case when attname = 'id' and atttypid = 'uuid'::regtype then 'gen_random_uuid()' else quote_ident(attname) end, ', ' order by attnum)
          into collist, sellist
          from pg_attribute
         where attrelid = t.oid and attnum > 0 and not attisdropped and attgenerated = '' and attidentity <> 'a';

        -- op is the matrix column; each op is one or two attempts (update: change their rows, and move one of ours into theirs)
        foreach op in array array['select', 'insert', 'update', 'delete'] loop
          worst := 'PASS'; worst_detail := null;
          foreach k in array case op when 'update' then array['update', 'move'] else array[op] end loop
            if k = 'move' and own_id is null then continue; end if;
            if k = 'select' then
              sql := format('select count(*) from public.%I where tenant_id = %L', t.tbl, v.id); mode := 'count';
            elsif k = 'update' then
              sql := format('update public.%I set tenant_id = tenant_id where tenant_id = %L', t.tbl, v.id); mode := 'rowcount';
            elsif k = 'move' then
              sql := format('update public.%I set tenant_id = %L where tenant_id = %L', t.tbl, v.id, own_id); mode := 'rowcount';
            elsif k = 'delete' then
              sql := format('delete from public.%I where tenant_id = %L', t.tbl, v.id); mode := 'rowcount';
            else
              sql := format('insert into public.%I (%s) select %s from pg_temp.%I returning tenant_id', t.tbl, collist, sellist, fx); mode := 'returning';
            end if;
            select * into r from pg_temp.qa_run(a.user_id, a.pgrole, sql, mode, null);
            select * into j from pg_temp.qa_judge(k, r.n, r.ret, r.code, r.msg, r.ctx, v.id);
            if j.status = 'PASS' and j.by_trigger then
              -- a trigger said no before row-level security was consulted: would the policies alone have said no?
              select * into retest from pg_temp.qa_run(a.user_id, a.pgrole, sql, mode, t.tbl);
              select * into j2 from pg_temp.qa_judge(k, retest.n, retest.ret, retest.code, retest.msg, retest.ctx, v.id);
              if j2.status in ('FAIL', 'ERROR') then
                j.detail := 'TRIGGER-ONLY: ' || j.detail || ' | with triggers off: ' || j2.detail;
              end if;
            end if;
            if j.status = 'FAIL' then worst := 'FAIL'; worst_detail := j.detail;
            elsif j.status = 'ERROR' and worst <> 'FAIL' then worst := 'ERROR'; worst_detail := j.detail;
            elsif worst = 'PASS' and (worst_detail is null or j.detail like 'TRIGGER-ONLY%') then worst_detail := j.detail; end if;
          end loop;
          perform pg_temp.qa_put(p_run, v.slug, a.actor, t.tbl, op, worst, coalesce(worst_detail, 'refused'));
        end loop;
      end loop;
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------- canary: the matrix must notice a deliberately open table
create policy qa03_canary_leak on public.announcements for all to authenticated using (true) with check (true);
select pg_temp.qa_attack('canary', array['announcements'], null, null);
drop policy qa03_canary_leak on public.announcements;

do $$
declare o text; missed text := '';
begin
  foreach o in array array['select', 'insert', 'update', 'delete'] loop
    if not exists (select 1 from qa_results where run = 'canary' and op = o and status = 'FAIL') then missed := missed || o || ' '; end if;
  end loop;
  if missed = '' then
    raise notice 'PASS canary: a deliberately open policy on announcements was reported as a leak for read, insert, update and delete';
  else
    raise notice 'FAIL canary: a deliberately open policy on announcements was NOT caught for: %. Nothing below can be trusted.', missed;
  end if;
end $$;

-- ---------------------------------------------------------------- the real run
select pg_temp.qa_attack('full', null, null, null);

-- ---------------------------------------------------------------- tables WITHOUT a tenant_id
-- These hold school data reached through a parent row or a user (assignment_submissions, exam_questions, device_tokens, ...)
-- or are platform-only. pred = "this row belongs to school %L". overrides point a synthetic fixture row at the school's own
-- parent rows. read_ok = a public catalogue whose reading is allowed by design (only writes are attacked).
create temp table qa_other (n int, rank int, tbl text primary key, pred text, setcol text, overrides jsonb, read_ok boolean);
insert into qa_other (n, rank, tbl, pred, setcol, overrides, read_ok) values
 ( 1, 0, 'ai_chat_messages',       'chat_id in (select id from public.ai_chats where tenant_id = %L)', 'content',
        '{"chat_id": "(select id from public.ai_chats where tenant_id = %L limit 1)"}', false),
 ( 2, 0, 'announcement_reads',     'profile_id in (select id from public.profiles where tenant_id = %L)', 'read_at',
        '{"announcement_id": "(select id from public.announcements where tenant_id = %L limit 1)", "profile_id": "(select id from public.profiles where tenant_id = %L and role::text = ''teacher'' limit 1)"}', false),
 ( 3, 0, 'assignment_submissions', 'assignment_id in (select id from public.assignments where tenant_id = %L)', 'file_name',
        '{"assignment_id": "(select id from public.assignments where tenant_id = %L limit 1)", "student_id": "(select id from public.students where tenant_id = %L limit 1)"}', false),
 ( 4, 0, 'bus_stop_progress',      'trip_id in (select id from public.trips where tenant_id = %L)', 'last_checked_at',
        '{"trip_id": "(select id from public.trips where tenant_id = %L limit 1)", "stop_id": "(select id from public.route_stops where tenant_id = %L limit 1)"}', false),
 ( 5, 0, 'device_tokens',          'profile_id in (select id from public.profiles where tenant_id = %L)', 'token',
        '{"profile_id": "(select id from public.profiles where tenant_id = %L and role::text = ''teacher'' limit 1)"}', false),
 ( 6, 0, 'exam_paper_texts',       'paper_id in (select id from public.exam_papers where tenant_id = %L)', 'body',
        '{"paper_id": "(select id from public.exam_papers where tenant_id = %L limit 1)"}', false),
 ( 7, 1, 'exam_questions',         'paper_id in (select id from public.exam_papers where tenant_id = %L)', 'prompt',
        '{"paper_id": "(select id from public.exam_papers where tenant_id = %L limit 1)"}', false),
 ( 8, 2, 'exam_question_keys',     'question_id in (select q.id from public.exam_questions q join public.exam_papers p on p.id = q.paper_id where p.tenant_id = %L)', 'model_answer',
        '{"question_id": "(select q.id from public.exam_questions q join public.exam_papers p on p.id = q.paper_id where p.tenant_id = %L limit 1)"}', false),
 ( 9, 0, 'notification_preferences','profile_id in (select id from public.profiles where tenant_id = %L)', 'updated_at',
        '{"profile_id": "(select id from public.profiles where tenant_id = %L and role::text = ''teacher'' limit 1)"}', false),
 (10, 0, 'organization_admins',    'organization_id = (select organization_id from public.tenants where id = %L)', 'added_at',
        '{"organization_id": "(select organization_id from public.tenants where id = %L)", "profile_id": "gen_random_uuid()"}', false),
 (11, 0, 'organizations',          'id = (select organization_id from public.tenants where id = %L)', 'name', null, false),
 (12, 0, 'tenants',                'id = %L', 'name', null, false),
 (13, 0, 'plan_pricing',           'true', 'price_cents', null, false),
 (14, 0, 'platform_incidents',     'true', 'title', null, false),
 (15, 0, 'service_status',         'true', 'service', null, false),
 (16, 0, 'login_lookups',          'true', 'caller_key', null, false),
 (17, 0, 'learning_areas',         'true', 'name', null, true);

-- The attacker's own queries run under row-level security, so a predicate that looks at parent tables ("papers of school X")
-- would see nothing and every attempt would trivially pass. The attacks therefore filter on literal ids: keysql, run as
-- postgres, lists the school's values of keycol (the column that links a row to its school).
alter table qa_other add column keycol text, add column keysql text;
update qa_other set keycol = k.col, keysql = k.q
  from (values
    ('ai_chat_messages',        'chat_id',         'select id from public.ai_chats where tenant_id = %L'),
    ('announcement_reads',      'profile_id',      'select id from public.profiles where tenant_id = %L'),
    ('assignment_submissions',  'assignment_id',   'select id from public.assignments where tenant_id = %L'),
    ('bus_stop_progress',       'trip_id',         'select id from public.trips where tenant_id = %L'),
    ('device_tokens',           'profile_id',      'select id from public.profiles where tenant_id = %L'),
    ('exam_paper_texts',        'paper_id',        'select id from public.exam_papers where tenant_id = %L'),
    ('exam_questions',          'paper_id',        'select id from public.exam_papers where tenant_id = %L'),
    ('exam_question_keys',      'question_id',     'select q.id from public.exam_questions q join public.exam_papers p on p.id = q.paper_id where p.tenant_id = %L'),
    ('notification_preferences','profile_id',      'select id from public.profiles where tenant_id = %L'),
    ('organization_admins',     'organization_id', 'select organization_id from public.tenants where id = %L and organization_id is not null'),
    ('organizations',           'id',              'select organization_id from public.tenants where id = %L and organization_id is not null'),
    ('tenants',                 'id',              'select id from public.tenants where id = %L')
  ) as k(t, col, q) where qa_other.tbl = k.t;

do $$
declare
  v record; o record; c record; cnt bigint; cols text; vals text; fx text; ov jsonb; pred text; nfx bigint;
begin
  for v in select slug, id, case slug when 'alliance' then 'a' else 'k' end as tag
             from tenants where slug in ('alliance', 'kijani-ridge') loop
    for o in select * from qa_other order by rank, tbl loop
      fx := format('qa_ox_%s_%s', o.n, v.tag);
      pred := format(o.pred, v.id);
      execute format('select count(*) from public.%I where %s', o.tbl, pred) into cnt;
      if cnt > 0 then
        execute format('create temp table %I as select * from public.%I where %s limit 1', fx, o.tbl, pred);
        execute format('grant select on pg_temp.%I to authenticated, anon', fx);
        insert into qa_fixture values (v.slug, o.tbl, 'real', null);
      else
        begin
          execute 'set local session_replication_role = replica';
          ov := coalesce(o.overrides, '{}'::jsonb);
          select string_agg(quote_ident(a.attname), ', ' order by a.attnum),
                 string_agg(case when ov ? a.attname then format(ov ->> a.attname, v.id) else pg_temp.qa_dummy(a.atttypid) end, ', ' order by a.attnum)
            into cols, vals
            from pg_attribute a
           where a.attrelid = ('public.' || o.tbl)::regclass and a.attnum > 0 and not a.attisdropped
             and a.attgenerated = '' and a.attidentity <> 'a' and (a.attnotnull or ov ? a.attname);
          for c in select conname from pg_constraint where conrelid = ('public.' || o.tbl)::regclass and contype = 'c' loop
            execute format('alter table public.%I drop constraint %I', o.tbl, c.conname);
          end loop;
          execute format('insert into public.%I (%s) values (%s)', o.tbl, cols, vals);
          execute format('create temp table %I as select * from public.%I where %s limit 1', fx, o.tbl, pred);
          execute format('select count(*) from pg_temp.%I', fx) into nfx;
          if nfx = 0 then raise exception 'the fixture row does not match the school predicate'; end if;
          execute format('grant select on pg_temp.%I to authenticated, anon', fx);
          execute 'set local session_replication_role = origin';
          insert into qa_fixture values (v.slug, o.tbl, 'synthetic', null);
        exception when others then
          execute 'set local session_replication_role = origin';
          insert into qa_fixture values (v.slug, o.tbl, 'none', sqlstate || ' ' || sqlerrm);
        end;
      end if;
    end loop;
  end loop;
end $$;

create function pg_temp.qa_attack_other(p_run text, p_tables text[]) returns void language plpgsql as $$
declare
  a record; v record; o record; r record; j record; j2 record; retest record;
  kind text; fx text; collist text; sellist text; sql text; mode text; op text; pred text; keys text;
  worst text; worst_detail text;
begin
  for a in select * from qa_actor order by actor loop
    for v in select s.slug, s.id, case s.slug when 'alliance' then 'a' else 'k' end as tag
               from tenants s
              where s.slug in ('alliance', 'kijani-ridge')
                and (a.actor = 'anon' or (a.actor = 'org_admin' and s.slug = 'alliance')
                     or (a.tenant_slug is not null and s.slug <> a.tenant_slug)) loop
      for o in select * from qa_other where p_tables is null or tbl = any (p_tables) order by tbl loop
        select f.kind into kind from qa_fixture f where f.victim = v.slug and f.tbl = o.tbl;
        if kind is null or kind = 'none' then
          perform pg_temp.qa_put(p_run, v.slug, a.actor, o.tbl, x, 'NOT TESTED',
                                 coalesce((select f.reason from qa_fixture f where f.victim = v.slug and f.tbl = o.tbl), 'no fixture'))
            from unnest(array['select', 'insert', 'update', 'delete']) x;
          continue;
        end if;
        fx := format('qa_ox_%s_%s', o.n, v.tag);
        if o.keycol is not null then
          -- resolved here, as postgres, before the actor is switched in
          execute format('select coalesce(array_agg(k::text), ''{}'') from (%s) s(k)', format(o.keysql, v.id)) into keys;
          pred := format('%I = any (%L::uuid[])', o.keycol, keys);
        else
          pred := format(o.pred, v.id);
        end if;
        select string_agg(quote_ident(attname), ', ' order by attnum),
               string_agg(case when attname = 'id' and atttypid = 'uuid'::regtype then 'gen_random_uuid()'
                               when attname = 'slug' and atttypid = 'text'::regtype then '(''qa03-'' || left(md5(random()::text), 8))'
                               else quote_ident(attname) end, ', ' order by attnum)
          into collist, sellist
          from pg_attribute
         where attrelid = ('public.' || o.tbl)::regclass and attnum > 0 and not attisdropped and attgenerated = '' and attidentity <> 'a';

        foreach op in array array['select', 'insert', 'update', 'delete'] loop
          if op = 'select' and o.read_ok then
            perform pg_temp.qa_put(p_run, v.slug, a.actor, o.tbl, op, 'N/A', 'a public catalogue: reading is allowed by design');
            continue;
          end if;
          if op = 'select' then
            sql := format('select count(*) from public.%I where %s', o.tbl, pred); mode := 'count';
          elsif op = 'update' then
            sql := format('update public.%I set %I = %I where %s', o.tbl, o.setcol, o.setcol, pred); mode := 'rowcount';
          elsif op = 'delete' then
            sql := format('delete from public.%I where %s', o.tbl, pred); mode := 'rowcount';
          else
            sql := format('insert into public.%I (%s) select %s from pg_temp.%I', o.tbl, collist, sellist, fx); mode := 'rowcount';
          end if;
          select * into r from pg_temp.qa_run(a.user_id, a.pgrole, sql, mode, null);
          select * into j from pg_temp.qa_judge(case op when 'insert' then 'insert_n' else op end, r.n, r.ret, r.code, r.msg, r.ctx, v.id);
          if j.status = 'PASS' and j.by_trigger then
            select * into retest from pg_temp.qa_run(a.user_id, a.pgrole, sql, mode, o.tbl);
            select * into j2 from pg_temp.qa_judge(case op when 'insert' then 'insert_n' else op end, retest.n, retest.ret, retest.code, retest.msg, retest.ctx, v.id);
            if j2.status in ('FAIL', 'ERROR') then
              j.detail := 'TRIGGER-ONLY: ' || j.detail || ' | with triggers off: ' || j2.detail;
            end if;
          end if;
          perform pg_temp.qa_put(p_run, v.slug, a.actor, o.tbl, op, j.status, j.detail);
        end loop;
      end loop;
    end loop;
  end loop;
end $$;

-- canary for this second code path: the table that holds the exam answer keys, made deliberately open
create policy qa03_canary_keys on public.exam_question_keys for all to authenticated using (true) with check (true);
select pg_temp.qa_attack_other('canary2', array['exam_question_keys']);
drop policy qa03_canary_keys on public.exam_question_keys;
do $$
declare o text; missed text := '';
begin
  foreach o in array array['select', 'insert', 'update', 'delete'] loop
    if not exists (select 1 from qa_results where run = 'canary2' and op = o and status = 'FAIL') then missed := missed || o || ' '; end if;
  end loop;
  if missed = '' then
    raise notice 'PASS canary: a deliberately open policy on exam_question_keys (a table without tenant_id) was reported as a leak for read, insert, update and delete';
  else
    raise notice 'FAIL canary: a deliberately open policy on exam_question_keys was NOT caught for: %. The checks of tables without a tenant_id cannot be trusted.', missed;
  end if;
end $$;

select pg_temp.qa_attack_other('full', null);

-- ---------------------------------------------------------------- the org admin: allowed in their own organization, not once it is suspended
-- First what the Kijani Ridge Group admin can do to Kijani Ridge while the organization is active (allowed, shown for contrast),
-- then the same attempts after the organization is suspended, which must all be refused (the issue's "known gap").
select pg_temp.qa_attack('org-active', null, array['org_admin'], array['kijani-ridge']);
update organizations set status = 'suspended' where id = (select organization_id from tenants where slug = 'kijani-ridge');
select pg_temp.qa_attack('suspended-org', null, array['org_admin'], array['kijani-ridge']);
update organizations set status = 'active' where id = (select organization_id from tenants where slug = 'kijani-ridge');

do $$
declare a_sel int; b_sel int; a_wr int; b_wr int;
begin
  select count(distinct tbl) into a_sel from qa_results where run = 'org-active' and op = 'select' and status = 'FAIL';
  select count(distinct tbl) into b_sel from qa_results where run = 'suspended-org' and op = 'select' and status = 'FAIL';
  select count(distinct tbl) into a_wr from qa_results where run = 'org-active' and op in ('insert', 'update', 'delete') and status = 'FAIL';
  select count(distinct tbl) into b_wr from qa_results where run = 'suspended-org' and op in ('insert', 'update', 'delete') and status = 'FAIL';
  raise notice 'CONTROL org: while its organization is active, the Kijani Ridge Group admin can read % and write % of the 79 school tables of Kijani Ridge (allowed); once the organization is suspended that is % and % (must be 0 and 0)',
    a_sel, a_wr, b_sel, b_wr;
end $$;

-- ---------------------------------------------------------------- the privileged (SECURITY DEFINER) functions
-- Every callable function in public that runs with its owner's rights. Each is called with arguments that point at the
-- victim school's own rows. First by the victim school's own users (the CONTROL: it shows the call works at all and what
-- the owner gets back), then by every outsider. An outsider is a FAIL only if the call succeeds and either changed the
-- victim school's data (all of its rows are fingerprinted before and after) or returned the same data the owner got.
-- If no owner can make the call work with the inferred arguments the function is INCONCLUSIVE, never a quiet PASS.

-- a fingerprint of every row the school owns in the 79 tables
create function pg_temp.qa_digest(p_v uuid) returns text language plpgsql as $$
declare t record; acc text := ''; d text;
begin
  for t in select tbl from qa_tables order by tbl loop
    execute format('select md5(coalesce(string_agg(x::text, ''|'' order by x::text), '''')) from public.%I x where tenant_id = %L', t.tbl, p_v) into d;
    acc := acc || d;
  end loop;
  return md5(acc);
end $$;

create function pg_temp.qa_pick(p_tbl text, p_tenant uuid, p_extra text) returns uuid language plpgsql as $$
declare r uuid;
begin
  if p_tbl = 'profiles' then
    execute format('select id from public.profiles where tenant_id = %L and role::text = %L order by created_at limit 1', p_tenant, coalesce(p_extra, 'teacher')) into r;
  else
    execute format('select id from public.%I where tenant_id = %L limit 1', p_tbl, p_tenant) into r;
  end if;
  return r;
exception when others then
  return null;
end $$;

-- one of the school's rows per kind of id, for building arguments
create temp table qa_ids (victim text, k text, id uuid);
insert into qa_ids (victim, k, id)
select s.slug, m.k, case when m.k = 'tenant' then s.id else pg_temp.qa_pick(m.tbl, s.id, m.extra) end
  from tenants s,
       (values ('tenant', null, null), ('student', 'students', null), ('class', 'classes', null), ('subject', 'subjects', null),
               ('exam', 'exams', null), ('route', 'routes', null), ('stop', 'route_stops', null), ('trip', 'trips', null),
               ('vehicle', 'vehicles', null), ('invoice', 'fee_invoices', null), ('proof', 'payment_proofs', null),
               ('paper', 'exam_papers', null), ('attempt', 'exam_attempts', null), ('item', 'inventory_items', null),
               ('call', 'calls', null), ('conv', 'conversations', null), ('request', 'student_bio_requests', null),
               ('card', 'report_cards', null), ('sig', 'signatures', null), ('sigreq', 'signature_requests', null),
               ('section', 'course_sections', null), ('chat', 'ai_chats', null), ('attachment', 'attachments', null),
               ('profile', 'profiles', 'teacher')) as m(k, tbl, extra)
 where s.slug in ('alliance', 'kijani-ridge');

-- Arguments for a function, as SQL: ids that point at the victim school's rows (chosen by the argument's name),
-- harmless values for everything else.
create function pg_temp.qa_genargs(p_oid oid, p_victim text) returns text language plpgsql as $$
declare
  names text[]; modes "char"[]; types oid[]; i int; parts text[] := '{}';
  arg_name text; arg_type oid; v_key text; v_id uuid; lit text; dummy text;
begin
  select coalesce(p.proargnames, '{}'::text[]), p.proargmodes,
         coalesce(p.proallargtypes, string_to_array(p.proargtypes::text, ' ')::oid[])
    into names, modes, types from pg_proc p where p.oid = p_oid;
  for i in 1 .. coalesce(array_length(types, 1), 0) loop
    if coalesce(modes[i]::text, 'i') in ('o', 't') then continue; end if;
    arg_name := lower(coalesce(names[i], ''));
    arg_type := types[i];
    if arg_type = 'uuid'::regtype or arg_type = 'uuid[]'::regtype then
      v_key := case
        when arg_name ~ 'tenant' then 'tenant'
        when arg_name ~ 'student|learner|child|^p_ids$|^ids$' then 'student'
        when arg_name ~ 'class' then 'class'
        when arg_name ~ 'subject' then 'subject'
        when arg_name ~ 'paper' then 'paper'
        when arg_name ~ 'attempt' then 'attempt'
        when arg_name ~ 'exam' then 'exam'
        when arg_name ~ 'route' then 'route'
        when arg_name ~ 'stop' then 'stop'
        when arg_name ~ 'trip' then 'trip'
        when arg_name ~ 'vehicle' then 'vehicle'
        when arg_name ~ 'invoice' then 'invoice'
        when arg_name ~ 'proof' then 'proof'
        when arg_name ~ 'item' then 'item'
        when arg_name ~ 'call' then 'call'
        when arg_name ~ 'conversation' then 'conv'
        when arg_name ~ 'request' then 'request'
        when arg_name ~ 'card' then 'card'
        when arg_name ~ 'section' then 'section'
        when arg_name ~ 'chat' then 'chat'
        when arg_name ~ 'attachment' then 'attachment'
        when arg_name ~ 'other|signer|teacher|driver|profile|user|contact|host|^a$|^b$' then 'profile'
        when arg_name ~ 'doc' then 'sigreq'
        when arg_name in ('p_id', 'id') then 'sig'
        else 'tenant' end;
      select q.id into v_id from qa_ids q where q.victim = p_victim and q.k = v_key;
      lit := coalesce(quote_literal(v_id::text), 'null') || '::uuid';
      parts := parts || (case when arg_type = 'uuid[]'::regtype then format('array[%s]', lit) else lit end);
    else
      dummy := pg_temp.qa_dummy(arg_type);
      parts := parts || (case when dummy is null then 'null' else '(' || dummy || ')::' || format_type(arg_type, null) end);
    end if;
  end loop;
  return array_to_string(parts, ', ');
end $$;

-- One call of a function as an actor, undone straight away. Returns what it returned, and a fingerprint of the victim school's
-- data taken (as postgres) right after the call.
create function pg_temp.qa_run_fn(p_user uuid, p_pgrole text, p_sql text, p_victim uuid)
returns table (code text, msg text, ctx text, res text, dig text) language plpgsql as $$
begin
  code := null; msg := null; ctx := null; res := null; dig := null;
  begin
    perform pg_temp.qa_become(p_user, p_pgrole);
    execute format('select coalesce(string_agg(row_to_json(x)::text, ''|''), '''') from (%s) x', p_sql) into res;
    reset role;
    dig := pg_temp.qa_digest(p_victim);
    raise exception using errcode = 'QA003';
  exception when others then
    if sqlstate <> 'QA003' then
      code := sqlstate; msg := sqlerrm;
      get stacked diagnostics ctx = pg_exception_context;
    end if;
  end;
  return next;
end $$;

create temp table qa_fn (fn text, volatility text, victim text, actor text, status text, detail text);
create temp table qa_fn_control (fn text, victim text, ok boolean, owner text);

create function pg_temp.qa_fn_attack() returns void language plpgsql as $$
declare
  f record; v record; a record; c record; r record;
  args text; sql text; d0 text; ctl_ok boolean; ctl_res text; ctl_actor text; st text; det text; res_clean text;
begin
  for v in select s.slug, s.id from tenants s where s.slug in ('alliance', 'kijani-ridge') loop
    d0 := pg_temp.qa_digest(v.id);
    for f in select p.oid, p.proname, p.provolatile, p.pronargs, p.prorettype
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.prosecdef and p.prokind = 'f' and p.prorettype <> 'trigger'::regtype
              order by p.proname loop
      args := pg_temp.qa_genargs(f.oid, v.slug);
      sql := format('select * from public.%I(%s)', f.proname, args);

      -- control: one of the school's own users, in the order most likely to be allowed
      ctl_ok := false; ctl_res := null; ctl_actor := null;
      for c in select * from qa_actor where tenant_slug = v.slug
                order by case split_part(actor, ':', 2) when 'school_admin' then 1 when 'teacher' then 2 when 'parent' then 3 when 'student' then 4 else 5 end loop
        select * into r from pg_temp.qa_run_fn(c.user_id, c.pgrole, sql, v.id);
        if r.code is null then
          ctl_ok := true; ctl_actor := c.actor;
          ctl_res := case when r.res in (format('{"%s":""}', f.proname), format('{"%s":null}', f.proname)) then '' else r.res end;
          exit;
        end if;
      end loop;
      insert into qa_fn_control values (f.proname, v.slug, ctl_ok, ctl_actor);

      -- outsiders
      for a in select * from qa_actor
                where actor = 'anon' or (actor = 'org_admin' and v.slug = 'alliance') or (tenant_slug is not null and tenant_slug <> v.slug)
                order by actor loop
        select * into r from pg_temp.qa_run_fn(a.user_id, a.pgrole, sql, v.id);
        res_clean := case when r.res in (format('{"%s":""}', f.proname), format('{"%s":null}', f.proname)) then '' else r.res end;
        if r.code is not null then
          if r.code in ('42501', '28000', 'P0001', 'P0002', 'P0003', '22023') then st := 'PASS'; det := 'refused: ' || left(r.msg, 80);
          elsif r.code like '23%' then st := 'REVIEW'; det := 'got as far as a write before failing (' || r.code || ' ' || left(r.msg, 70) || ')';
          else st := 'INCONCLUSIVE'; det := r.code || ' ' || left(r.msg, 90); end if;
        elsif r.dig is distinct from d0 then st := 'FAIL'; det := 'changed the school''s data';
        elsif res_clean = '' or res_clean ~ '^\{"[^"]*":(false|0|null|"")\}$' then
          st := 'PASS'; det := 'ran; nothing changed and nothing useful came back (' || coalesce(nullif(left(res_clean, 40), ''), 'no result') || ')';
        elsif f.pronargs = 0 then
          st := 'PASS'; det := 'a helper about the caller themself, not about the school: ' || left(res_clean, 60);
        elsif ctl_ok and res_clean is not distinct from ctl_res then
          if f.prorettype = 'boolean'::regtype then
            st := 'REVIEW'; det := 'a true/false answer about the school''s rows, the same as its own user gets: ' || res_clean;
          else
            st := 'FAIL'; det := 'returned the same data as the school''s own user (' || ctl_actor || '): ' || left(res_clean, 80);
          end if;
        else st := 'REVIEW'; det := 'ran and returned data: ' || left(res_clean, 100); end if;
        insert into qa_fn values (f.proname, f.provolatile::text, v.slug, a.actor, st, det);
      end loop;
    end loop;
  end loop;
end $$;

select pg_temp.qa_fn_attack();

do $$
declare r record; own text;
begin
  for r in
    select fn, max(volatility) as vol,
           count(*) filter (where status = 'FAIL') as f,
           count(*) filter (where status = 'REVIEW') as rv,
           count(*) filter (where status = 'INCONCLUSIVE') as inc,
           count(*) filter (where status = 'PASS') as p,
           min(detail) filter (where status = 'FAIL') as fd,
           min(detail) filter (where status = 'REVIEW') as rd,
           min(detail) filter (where status = 'INCONCLUSIVE') as id_,
           (select count(*) from qa_fn_control c where c.fn = x.fn and c.ok) as ctl_ok
      from qa_fn x group by fn order by fn
  loop
    if r.f > 0 then raise notice 'FAIL function %: % outsider call(s) leaked: %', r.fn, r.f, r.fd;
    elsif r.rv > 0 then raise notice 'REVIEW function %: % outsider call(s) need a human look: %', r.fn, r.rv, r.rd;
    elsif r.ctl_ok = 0 then raise notice 'INCONCLUSIVE function %: no owner could make the call work with the inferred arguments (outsiders: %)', r.fn, coalesce(r.id_, 'refused');
    else raise notice 'PASS function % (% outsider calls refused or harmless, the owner''s own call works)', r.fn, r.p;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- positive control
-- "No rows visible" only means something if the rows can be seen by somebody allowed to. For every school and table:
-- can that school's own admin read its own rows? If not, can platform staff?
create temp table qa_control (victim text, tbl text, admin_sees bigint, platform_sees bigint);
do $$
declare v record; t record; admin_id uuid; super_id uuid; n1 bigint; n2 bigint;
begin
  select id into super_id from profiles where role::text = 'super_admin' order by created_at limit 1;
  for v in select slug, id from tenants where slug in ('alliance', 'kijani-ridge') loop
    select user_id into admin_id from qa_actor where actor = v.slug || ':school_admin';
    for t in select * from qa_tables order by tbl loop
      select r.n into n1 from pg_temp.qa_run(admin_id, 'authenticated',
        format('select count(*) from public.%I where tenant_id = %L', t.tbl, v.id), 'count', null) r;
      n2 := null;
      if coalesce(n1, 0) = 0 then
        select r.n into n2 from pg_temp.qa_run(super_id, 'authenticated',
          format('select count(*) from public.%I where tenant_id = %L', t.tbl, v.id), 'count', null) r;
      end if;
      insert into qa_control values (v.slug, t.tbl, n1, n2);
    end loop;
  end loop;
  raise notice 'CONTROL: of % (school, table) pairs, % have rows that the school''s own admin can read, % only platform staff can read, % nobody could read (see INFO control lines)',
    (select count(*) from qa_control),
    (select count(*) from qa_control where coalesce(admin_sees, 0) > 0),
    (select count(*) from qa_control where coalesce(admin_sees, 0) = 0 and coalesce(platform_sees, 0) > 0),
    (select count(*) from qa_control where coalesce(admin_sees, 0) = 0 and coalesce(platform_sees, 0) = 0);
  for t in select tbl, string_agg(victim, ', ') as schools from qa_control
            where coalesce(admin_sees, 0) = 0 and coalesce(platform_sees, 0) = 0 group by tbl order by tbl loop
    raise notice 'INFO control %: neither the school admin nor platform staff can read the rows of (%), so cross-school reads of this table were checked against rows nobody can see', t.tbl, t.schools;
  end loop;
end $$;

do $$
declare r record;
begin
  for r in
    select (case run when 'full' then '' else run || ': ' end) || tbl as tbl, op,
           count(*) filter (where status = 'N/A')        as na,
           count(*) filter (where status = 'FAIL')       as f,
           count(*) filter (where status = 'ERROR')      as e,
           count(*) filter (where status = 'PASS')       as p,
           string_agg(distinct actor || ' -> ' || victim, ', ') filter (where status in ('FAIL', 'ERROR')) as bad,
           min(detail) filter (where status in ('FAIL', 'ERROR')) as first_detail
      from qa_results where run in ('full', 'suspended-org') group by run, tbl, op order by run, tbl, op
  loop
    if r.f > 0 then raise notice 'FAIL % %: % cell(s) leaked (%): %', r.tbl, r.op, r.f, r.bad, r.first_detail;
    elsif r.e > 0 then raise notice 'FAIL % %: % cell(s) could not be judged (%): %', r.tbl, r.op, r.e, r.bad, r.first_detail;
    elsif r.p = 0 and r.na > 0 then raise notice 'N/A % %: a public catalogue, reading is allowed by design', r.tbl, r.op;
    elsif r.p = 0 then raise notice 'SKIP % %: nothing to attack (no fixture could be made)', r.tbl, r.op;
    else raise notice 'PASS % % (% actor/school pairs refused)', r.tbl, r.op, r.p;
    end if;
  end loop;
end $$;

do $$
declare r record;
begin
  for r in
    select tbl, op, count(*) as cells, min(detail) as example
      from qa_results where run in ('full', 'suspended-org') and detail like 'TRIGGER-ONLY%' group by tbl, op order by tbl, op
  loop
    raise notice 'INFO % %: % cell(s) are refused by a trigger only (row-level security alone would not stop them): %', r.tbl, r.op, r.cells, left(r.example, 200);
  end loop;
end $$;

\if :{?cells}
  \pset tuples_only on
  \pset format unaligned
  \pset fieldsep '|'
  select run, victim, actor, tbl, op, status, detail from qa_results order by run, tbl, op, victim, actor;
  select 'FIXTURE', victim, tbl, kind, reason from qa_fixture order by tbl, victim;
  select 'FN', fn, volatility, victim, actor, status, detail from qa_fn order by fn, victim, actor;
  select 'FNCTL', fn, victim, ok, owner from qa_fn_control order by fn, victim;
\endif

rollback;
