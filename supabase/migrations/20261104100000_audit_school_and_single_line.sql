-- FIG-1326 follow-up to 20261104000000: two gaps in the generic audit log.
--
-- 1. Rows with no tenant_id of their own were logged with no school, so the
--    school's admins couldn't see them (audit_read is may_administer(tenant)).
--    Four of those tables belong to a school through their parent row:
--    homework hand-ins (their assignment), exam paper texts and questions
--    (their paper), and answer keys (their question, then its paper).
--    audit_table_config.tenant_via names the path; audit_row_tenant() walks
--    it. The rest (learning areas, organizations, platform tables) really
--    have no school, and stay that way.
--
-- 2. Functions that already write their own, worded audit event (archiving
--    learners, releasing results, sending scores to the gradebook, ...) got a
--    second, generic line for the table they write. Each now sets
--    figbloom.self_audited for its transaction, and audit_table_change()
--    skips writes made under it. A function can't carry that setting in its
--    own definition on Supabase (it needs superuser), so the line is added
--    at the top of each function body, found from the catalog: every
--    security-definer plpgsql function that inserts into audit_events and
--    writes a table audit_table_change() covers. Clients can't set the flag
--    (set_config isn't exposed through the API). The flag lasts the rest of
--    the transaction, which for an API call is the call itself.
--
-- supabase/rls-checks/audit_log.sql checks both.

alter table audit_table_config add column tenant_via text;
update audit_table_config set tenant_via = 'assignment_id>assignments' where table_name = 'assignment_submissions';
update audit_table_config set tenant_via = 'paper_id>exam_papers' where table_name in ('exam_paper_texts', 'exam_questions');
update audit_table_config set tenant_via = 'question_id>exam_questions,paper_id>exam_papers' where table_name = 'exam_question_keys';

-- Follows "column>table" hops from a row to the school of the row it belongs to.
create or replace function audit_row_tenant(p_row jsonb, p_via text) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  hop text;
  cur jsonb := p_row;
begin
  if p_via is null then return null; end if;
  foreach hop in array string_to_array(p_via, ',') loop
    exit when cur is null or cur ->> split_part(hop, '>', 1) is null;
    execute format('select to_jsonb(t) from %I t where t.id = $1', split_part(hop, '>', 2))
      into cur using (cur ->> split_part(hop, '>', 1))::uuid;
  end loop;
  return (cur ->> 'tenant_id')::uuid;
end $$;
revoke execute on function audit_row_tenant(jsonb, text) from public, anon, authenticated;

create or replace function audit_table_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_category text := tg_argv[0];
  v_values boolean := tg_argv[1]::boolean;
  v_keys text[] := string_to_array(tg_argv[2], ',');
  v_label text := upper(left(replace(tg_table_name, '_', ' '), 1)) || substr(replace(tg_table_name, '_', ' '), 2);
  v_actor text := case when auth.uid() is null then 'System' else my_actor_label() end;
  v_via text := (select tenant_via from audit_table_config where table_name = tg_table_name);
  v_rows jsonb;
begin
  -- another trigger's own write: logged where it started
  if pg_trigger_depth() > 1 then return null; end if;
  -- a function that writes its own, worded audit event
  if current_setting('figbloom.self_audited', true) = 'true' then return null; end if;

  if tg_op = 'UPDATE' then
    -- each changed row: its school, its key, its name if it has one, and what changed
    select coalesce(jsonb_agg(jsonb_build_object(
             'tenant', coalesce((n.j ->> 'tenant_id')::uuid, audit_row_tenant(n.j, v_via)),
             'key', (select jsonb_object_agg(k, n.j -> k) from unnest(v_keys) k),
             'name', coalesce(n.j ->> 'full_name', n.j ->> 'name', n.j ->> 'title'),
             'changes', ch.changes)), '[]'::jsonb)
      into v_rows
      from (select to_jsonb(x) as j from old_rows x) o
      join (select to_jsonb(y) as j from new_rows y) n
        on (select bool_and(o.j -> k = n.j -> k) from unnest(v_keys) k)
     cross join lateral (
       select jsonb_object_agg(e.key, case when v_values
                then jsonb_build_object('from', audit_trim(e.value), 'to', audit_trim(n.j -> e.key))
                else 'null'::jsonb end) as changes
         from jsonb_each(o.j) e
        where e.key <> 'updated_at' and e.value is distinct from n.j -> e.key
     ) ch
     where ch.changes is not null;

    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    select (select t.id from tenants t where t.id = (g.tenant #>> '{}')::uuid), auth.uid(), v_actor,
           format('%s: %s changed (%s)', v_label,
                  case when g.n = 1 and g.name is not null then '"' || g.name || '"'
                       else g.n || case when g.n = 1 then ' record' else ' records' end end,
                  g.cols),
           v_category,
           jsonb_build_object('table', tg_table_name, 'op', 'update', 'count', g.n,
                              'changes', jsonb_path_query_array(g.items, '$[0 to 49]'))
      from (
        select r -> 'tenant' as tenant, count(*) as n, max(r ->> 'name') as name,
               jsonb_agg(jsonb_build_object('key', r -> 'key', 'changes', r -> 'changes')) as items,
               (select string_agg(distinct replace(c, '_', ' '), ', ')
                  from jsonb_array_elements(jsonb_agg(r -> 'changes')) ch2, jsonb_object_keys(ch2) c) as cols
          from jsonb_array_elements(v_rows) r
         group by r -> 'tenant'
      ) g;
    return null;
  end if;

  if tg_op = 'INSERT' then
    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_rows from new_rows x;
  else
    select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_rows from old_rows x;
  end if;

  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  select (select t.id from tenants t where t.id = g.tenant), auth.uid(), v_actor,
         format('%s: %s %s', v_label,
                case when g.n = 1 and g.name is not null then '"' || g.name || '"'
                     else g.n || case when g.n = 1 then ' record' else ' records' end end,
                case tg_op when 'INSERT' then 'added' else 'removed' end),
         v_category,
         jsonb_build_object('table', tg_table_name, 'op', lower(tg_op), 'count', g.n,
                            'rows', jsonb_path_query_array(g.items, '$[0 to 49]'))
    from (
      select x.tenant, count(*) as n,
             max(coalesce(x.r ->> 'full_name', x.r ->> 'name', x.r ->> 'title')) as name,
             jsonb_agg(case when v_values
                         then (select jsonb_object_agg(e.key, audit_trim(e.value)) from jsonb_each(x.r) e)
                         else (select jsonb_object_agg(k, x.r -> k) from unnest(v_keys) k) end) as items
        from (select r, coalesce((r ->> 'tenant_id')::uuid, audit_row_tenant(r, v_via)) as tenant
                from jsonb_array_elements(v_rows) r) x
       group by x.tenant
    ) g;
  return null;
end $$;

-- 2. The flag, at the top of each function that writes its own audit event.
do $$
declare
  f record;
  def text;
begin
  for f in
    select distinct p.oid
      from pg_proc p
      join pg_language l on l.oid = p.prolang and l.lanname = 'plpgsql'
     cross join audit_table_config c
     where p.pronamespace = 'public'::regnamespace and p.prosecdef
       and p.prorettype <> 'trigger'::regtype
       and p.prosrc ilike '%insert into audit_events%'
       and p.prosrc !~ 'figbloom\.self_audited'
       and p.prosrc ~* ('(insert into|update|delete from)\s+' || c.table_name || '\M')
  loop
    def := pg_get_functiondef(f.oid);
    -- the body's first "begin", after the opening $function$
    def := regexp_replace(def, '(\$function\$.*?\mbegin\M)',
                          E'\\1\n  perform set_config(''figbloom.self_audited'', ''true'', true);  -- its own audit event (FIG-1326)',
                          'is');
    if def !~ 'figbloom\.self_audited' then
      raise exception 'Could not add the self-audited flag to %', f.oid::regprocedure;
    end if;
    execute def;
    raise notice 'self-audited: %', f.oid::regprocedure;
  end loop;
end $$;
