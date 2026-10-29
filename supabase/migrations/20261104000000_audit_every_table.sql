-- FIG-1326: every change a user makes is in the audit log.
--
-- The rule (2026-10-29): every action in the app leaves an audit trail. Fee
-- records got theirs in 20261103300001; everywhere else, 80 tables that
-- signed-in users write to had no audit trigger at all.
--
-- One trigger function, audit_table_change(), is installed on each of them
-- from the list below, the way the fee triggers work:
--
--   * written by the database, so a screen or a direct API call can't skip it;
--   * one event per statement and school, so a whole class's attendance, or a
--     billing-sized import, is one line, with the rows' keys in metadata;
--   * an update says which columns changed, and from what to what;
--   * a write made inside another trigger is logged where it started, not
--     again. A foreign-key cascade isn't one of those (Postgres fires its
--     statement triggers at the top level), so deleting a class also logs
--     the timetable slots and enrolments it took with it, under the same
--     actor: the record of what the delete removed;
--   * the actor comes from the caller's profile (my_actor_label()), or
--     "System" for the service role (edge functions, seeds).
--
-- Values: for most tables the event keeps the old and new values (strings cut
-- at 120 characters). For the sensitive ones (health, documents, exam
-- answers, leave and gate visits) it keeps only which columns changed: the
-- audit log is readable by the school's admins, and copying a learner's
-- medication or an exam's answer key into it would show them to people the
-- table itself doesn't.
--
-- Left out on purpose, as noise rather than actions: chat and AI-helper
-- messages and chats, read receipts, push device tokens, notification
-- preferences, bus GPS pings, and organization_access_log (itself a log).
-- Tables already audited by their own triggers (the fee tables) keep those.
--
-- Rows with no tenant_id of their own (homework hand-ins, exam questions,
-- platform tables) are logged with no school, which only Figbloom staff read.
--
-- supabase/rls-checks/audit_log.sql checks it, including that every table
-- users can write to is either audited or on the list of exclusions above.

alter table audit_events drop constraint if exists audit_events_category_check;
alter table audit_events add constraint audit_events_category_check
  check (category in ('provisioning', 'access', 'academic', 'financial', 'health', 'transport', 'communication', 'operations'));

-- Strings past 120 characters are cut; nothing else changes.
create or replace function audit_trim(v jsonb) returns jsonb
language sql immutable as $$
  select case when jsonb_typeof(v) = 'string' and length(v #>> '{}') > 120
              then to_jsonb(left(v #>> '{}', 120) || '…') else v end
$$;

-- tg_argv: category, whether to keep values ('true'/'false'), the primary key's columns (comma-separated)
create or replace function audit_table_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_category text := tg_argv[0];
  v_values boolean := tg_argv[1]::boolean;
  v_keys text[] := string_to_array(tg_argv[2], ',');
  v_label text := upper(left(replace(tg_table_name, '_', ' '), 1)) || substr(replace(tg_table_name, '_', ' '), 2);
  v_actor text := case when auth.uid() is null then 'System' else my_actor_label() end;
  v_rows jsonb;
begin
  -- another trigger's own write: logged where it started
  if pg_trigger_depth() > 1 then return null; end if;

  if tg_op = 'UPDATE' then
    -- each changed row: its key, its name if it has one, and what changed
    select coalesce(jsonb_agg(jsonb_build_object(
             'tenant', n.j -> 'tenant_id',
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
  select (select t.id from tenants t where t.id = (g.tenant #>> '{}')::uuid), auth.uid(), v_actor,
         format('%s: %s %s', v_label,
                case when g.n = 1 and g.name is not null then '"' || g.name || '"'
                     else g.n || case when g.n = 1 then ' record' else ' records' end end,
                case tg_op when 'INSERT' then 'added' else 'removed' end),
         v_category,
         jsonb_build_object('table', tg_table_name, 'op', lower(tg_op), 'count', g.n,
                            'rows', jsonb_path_query_array(g.items, '$[0 to 49]'))
    from (
      select r -> 'tenant_id' as tenant, count(*) as n,
             max(coalesce(r ->> 'full_name', r ->> 'name', r ->> 'title')) as name,
             jsonb_agg(case when v_values
                         then (select jsonb_object_agg(e.key, audit_trim(e.value)) from jsonb_each(r) e)
                         else (select jsonb_object_agg(k, r -> k) from unnest(v_keys) k) end) as items
        from jsonb_array_elements(v_rows) r
       group by r -> 'tenant_id'
    ) g;
  return null;
end $$;

-- What each table is, and whether its values may go in the log.
create table audit_table_config (
  table_name text primary key,
  category text not null,
  keep_values boolean not null default true
);
alter table audit_table_config enable row level security;  -- no policies: owner only

insert into audit_table_config (table_name, category, keep_values) values
  -- people and schools
  ('profiles', 'provisioning', true), ('students', 'provisioning', true), ('guardians', 'provisioning', true),
  ('invites', 'provisioning', true), ('tenants', 'provisioning', true), ('organizations', 'provisioning', true),
  ('organization_admins', 'access', true), ('impersonation_sessions', 'access', true),
  ('student_documents', 'provisioning', false),
  ('plan_pricing', 'financial', true), ('platform_invoices', 'financial', true),
  ('platform_incidents', 'operations', true), ('service_status', 'operations', true),
  -- teaching and records
  ('classes', 'academic', true), ('subjects', 'academic', true), ('terms', 'academic', true), ('semesters', 'academic', true),
  ('teacher_subjects', 'academic', true), ('teaching_assignments', 'academic', true), ('coverage_assignments', 'academic', true),
  ('timetable_slots', 'academic', true), ('remote_days', 'academic', true), ('online_lessons', 'academic', true),
  ('class_meeting_links', 'academic', true), ('attendance', 'academic', true), ('marks', 'academic', true),
  ('exams', 'academic', true), ('exam_papers', 'academic', true), ('exam_paper_texts', 'academic', false),
  ('exam_questions', 'academic', false), ('exam_question_keys', 'academic', false),
  ('assignments', 'academic', true), ('assignment_submissions', 'academic', true),
  ('cbe_assessments', 'academic', true), ('cbe_assessment_comments', 'academic', true), ('cbe_results', 'academic', true),
  ('learner_competencies', 'academic', true), ('learning_areas', 'academic', true), ('strands', 'academic', true),
  ('courses', 'academic', true), ('course_sections', 'academic', true), ('course_section_timetable_slots', 'academic', true),
  ('course_assessments', 'academic', true), ('course_marks', 'academic', true), ('course_grades', 'academic', true),
  ('enrollments', 'academic', true),
  -- fees
  ('fee_items', 'financial', true),
  -- health
  ('medical_settings', 'health', false), ('sick_bay_visits', 'health', false), ('visit_medications', 'health', false),
  ('medication_requests', 'health', false), ('medication_schedules', 'health', false), ('medication_doses', 'health', false),
  -- transport
  ('routes', 'transport', true), ('route_stops', 'transport', true), ('vehicles', 'transport', true),
  ('vehicle_assignments', 'transport', true), ('vehicle_alerts', 'transport', true), ('student_transport', 'transport', true),
  ('trips', 'transport', true), ('trip_riders', 'transport', true),
  -- messages to families
  ('announcements', 'communication', true), ('attachments', 'communication', true),
  -- the rest of the school day
  ('activities', 'operations', true), ('activity_events', 'operations', true), ('activity_members', 'operations', true),
  ('activity_patrons', 'operations', true), ('activity_event_participants', 'operations', true),
  ('inventory_items', 'operations', true), ('inventory_issues', 'operations', true),
  ('leave_requests', 'operations', false), ('visits', 'operations', false);

-- Install: three statement triggers per table (each event needs its own transition tables).
do $$
declare
  c record;
  keys text;
begin
  for c in select * from audit_table_config loop
    select string_agg(a.attname, ',' order by array_position(i.indkey, a.attnum))
      into keys
      from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
     where i.indrelid = format('public.%I', c.table_name)::regclass and i.indisprimary;
    execute format('create trigger %I after insert on %I referencing new table as new_rows for each statement execute function audit_table_change(%L, %L, %L)',
                   left(c.table_name, 50) || '_audit_ins', c.table_name, c.category, c.keep_values, coalesce(keys, ''));
    execute format('create trigger %I after update on %I referencing old table as old_rows new table as new_rows for each statement execute function audit_table_change(%L, %L, %L)',
                   left(c.table_name, 50) || '_audit_upd', c.table_name, c.category, c.keep_values, coalesce(keys, ''));
    execute format('create trigger %I after delete on %I referencing old table as old_rows for each statement execute function audit_table_change(%L, %L, %L)',
                   left(c.table_name, 50) || '_audit_del', c.table_name, c.category, c.keep_values, coalesce(keys, ''));
  end loop;
end $$;
