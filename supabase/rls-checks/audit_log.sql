-- Audit trail checks for 20261104000000 (FIG-1326).
--
-- Runs against a local database that has the migrations applied and
-- `npm run db:seed` data, inside one transaction that is rolled back.
-- Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/audit_log.sql

\set ON_ERROR_STOP 1
begin;

select set_config('t.a', (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.admin', (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.a')::uuid limit 1), true);
select set_config('t.teacher', (select id::text from profiles where role = 'teacher' and tenant_id = current_setting('t.a')::uuid limit 1), true);
select set_config('t.since', now()::text, true);

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when coalesce(ok, false) then 'PASS' else 'FAIL' end, label; end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- events written in this transaction (now() is the transaction's start, so every one of them)
create function pg_temp.events(p_table text) returns setof audit_events language sql as $$
  select * from audit_events where metadata->>'table' = p_table and created_at = now() order by created_at, id
$$;

-- ---------------------------------------------------------------- every table users can write to is audited, or left out on purpose
select pg_temp.check('every table with a write policy is audited or deliberately left out (missing: '
    || coalesce(string_agg(w.t, ', '), 'none') || ')', count(*) = 0)
  from (select distinct tablename as t from pg_policies
         where schemaname = 'public' and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')) w
 where w.t not in ('ai_chat_messages', 'ai_chats', 'announcement_reads', 'chat_messages', 'device_tokens',
                   'notification_preferences', 'vehicle_locations', 'organization_access_log')
   and (select count(*) from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
         where tg.tgrelid = format('public.%I', w.t)::regclass and not tg.tgisinternal
           and p.prosrc ilike '%audit_events%') = 0;

select pg_temp.check('each table in audit_table_config has its insert, update and delete triggers',
  not exists (select 1 from audit_table_config c
               where (select count(*) from pg_trigger tg
                       where tg.tgrelid = format('public.%I', c.table_name)::regclass
                         and tg.tgfoid = 'audit_table_change'::regproc) <> 3));

-- ---------------------------------------------------------------- the school admin adds, changes and removes a class
select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;
insert into classes (tenant_id, name, form_level) values (current_setting('t.a')::uuid, 'Audit Check 1', 1);
update classes set name = 'Audit Check 2' where name = 'Audit Check 1' and tenant_id = current_setting('t.a')::uuid;
update classes set name = name where name = 'Audit Check 2' and tenant_id = current_setting('t.a')::uuid;
insert into timetable_slots (tenant_id, class_id, day, start_time, label)
  values (current_setting('t.a')::uuid, (select id from classes where name = 'Audit Check 2'), 'Mon', '08:00', 'Audit');
delete from classes where name = 'Audit Check 2' and tenant_id = current_setting('t.a')::uuid;
reset role;

select pg_temp.check('adding a class is logged, with the admin, the school and the name',
  (select count(*) from pg_temp.events('classes') e
    where e.event = 'Classes: "Audit Check 1" added' and e.actor_id = current_setting('t.admin')::uuid
      and e.tenant_id = current_setting('t.a')::uuid and e.category = 'academic'
      and e.actor_label like '% · school admin') = 1);
select pg_temp.check('renaming it is logged with what changed, from and to',
  (select count(*) from pg_temp.events('classes') e
    where e.event = 'Classes: "Audit Check 2" changed (name)'
      and e.metadata->'changes'->0->'changes'->'name'->>'from' = 'Audit Check 1'
      and e.metadata->'changes'->0->'changes'->'name'->>'to' = 'Audit Check 2') = 1);
select pg_temp.check('an update that changes nothing writes nothing',
  (select count(*) from pg_temp.events('classes') where metadata->>'op' = 'update') = 1);
select pg_temp.check('removing it is logged, with the row as it was',
  (select count(*) from pg_temp.events('classes') e
    where e.event = 'Classes: "Audit Check 2" removed' and e.metadata->'rows'->0->>'name' = 'Audit Check 2') = 1);
select pg_temp.check('the timetable slot its removal cascaded to is logged too, under the same admin',
  (select count(*) from pg_temp.events('timetable_slots') e
    where e.metadata->>'op' = 'delete' and e.event = 'Timetable slots: 1 record removed'
      and e.actor_id = current_setting('t.admin')::uuid) = 1);

-- ---------------------------------------------------------------- one line for a whole class's register
select set_config('t.cls', (select s.class_id::text from attendance a join students s on s.id = a.student_id
   where a.tenant_id = current_setting('t.a')::uuid group by s.class_id, a.taken_on having count(*) > 3 limit 1), true);
select set_config('t.day', (select taken_on::text from attendance a join students s on s.id = a.student_id
   where s.class_id = current_setting('t.cls')::uuid group by a.taken_on having count(*) > 3 limit 1), true);
select set_config('t.n', (select count(*)::text from attendance a join students s on s.id = a.student_id
   where s.class_id = current_setting('t.cls')::uuid and a.taken_on = current_setting('t.day')::date), true);
update attendance a set mark = case a.mark when 'present' then 'absent'::attendance_mark else 'present'::attendance_mark end
  from students s where s.id = a.student_id and s.class_id = current_setting('t.cls')::uuid and a.taken_on = current_setting('t.day')::date;
select pg_temp.check('a whole class''s register changed at once is one event, counting every learner',
  (select count(*) from pg_temp.events('attendance') e
    where e.metadata->>'op' = 'update' and (e.metadata->>'count')::int = current_setting('t.n')::int
      and e.event = format('Attendance: %s records changed (mark)', current_setting('t.n'))) = 1);

-- ---------------------------------------------------------------- the service role, and a table whose values stay out of the log
select set_config('request.jwt.claims', '', true);
insert into leave_requests (tenant_id, teacher_id, starts_on, ends_on, reason)
  values (current_setting('t.a')::uuid, current_setting('t.teacher')::uuid, '2027-02-01', '2027-02-03', 'Audit check: hospital appointment');
update leave_requests set reason = 'Audit check: surgery follow-up' where reason like 'Audit check:%';
select pg_temp.check('a write by the service role is logged as System',
  (select count(*) from pg_temp.events('leave_requests') where actor_label = 'System' and actor_id is null) = 2);
select pg_temp.check('a leave request''s reason is not copied into the log, only that it changed',
  (select count(*) from pg_temp.events('leave_requests') e
    where e.metadata::text like '%hospital%' or e.metadata::text like '%surgery%') = 0
  and (select count(*) from pg_temp.events('leave_requests') e
    where e.event = 'Leave requests: 1 record changed (reason)' and e.metadata->'changes'->0->'changes' ? 'reason') = 1);

-- ---------------------------------------------------------------- the categories the new events use are allowed
select pg_temp.check('every configured category is one audit_events accepts',
  not exists (select 1 from audit_table_config
               where category not in ('provisioning', 'access', 'academic', 'financial', 'health', 'transport', 'communication', 'operations')));

-- ---------------------------------------------------------------- the school, through the parent row (20261104100000)
select set_config('t.asg', (select id::text from assignments where tenant_id = current_setting('t.a')::uuid limit 1), true);
select set_config('t.learner', (select s.id::text from students s where s.tenant_id = current_setting('t.a')::uuid
   and not exists (select 1 from assignment_submissions x where x.assignment_id = current_setting('t.asg')::uuid and x.student_id = s.id)
   limit 1), true);
insert into assignment_submissions (assignment_id, student_id)
  values (current_setting('t.asg')::uuid, current_setting('t.learner')::uuid);
select pg_temp.check('a homework hand-in, which has no tenant_id of its own, is logged under its assignment''s school',
  (select count(*) from pg_temp.events('assignment_submissions') e
    where e.metadata->>'op' = 'insert' and e.tenant_id = current_setting('t.a')::uuid) = 1);
select pg_temp.check('every table that reaches its school through a parent row says how',
  (select count(*) from audit_table_config
    where table_name in ('assignment_submissions', 'exam_paper_texts', 'exam_questions', 'exam_question_keys')
      and tenant_via is not null) = 4);

-- ---------------------------------------------------------------- one line for a function that logs itself
select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;
select archive_learners(array[current_setting('t.learner')::uuid]);
reset role;
select pg_temp.check('archiving a learner is the function''s own line only, with no generic Students line',
  (select count(*) from audit_events where event = '1 learner archived' and actor_id = current_setting('t.admin')::uuid) = 1
  and (select count(*) from pg_temp.events('students')) = 0);

select pg_temp.check('every definer function that writes its own audit event and an audited table sets the flag (missing: '
    || coalesce(string_agg(distinct p.oid::regprocedure::text, ', '), 'none') || ')', count(*) = 0)
  from pg_proc p
  join pg_language l on l.oid = p.prolang and l.lanname = 'plpgsql'
 cross join audit_table_config c
 where p.pronamespace = 'public'::regnamespace and p.prosecdef
   and p.prorettype <> 'trigger'::regtype
   and p.prosrc ilike '%insert into audit_events%'
   and p.prosrc !~ 'figbloom\.self_audited'
   and p.prosrc ~* ('(insert into|update|delete from)\s+' || c.table_name || '\M');

-- ---------------------------------------------------------------- who reads the log: the "audit" area (20261104200000)
select set_config('t.other', (select id::text from tenants where id <> current_setting('t.a')::uuid order by slug limit 1), true);
insert into audit_events (tenant_id, actor_label, event, category)
  values (current_setting('t.other')::uuid, 'Check', 'Another school''s event', 'operations');
select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.teacher'), 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.check('a teacher without the area reads none of the log',
  (select count(*) from audit_events) = 0);
reset role;
insert into staff_permissions (tenant_id, profile_id, area) values (current_setting('t.a')::uuid, current_setting('t.teacher')::uuid, 'audit');
select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.teacher'), 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.check('given the audit area, the teacher reads their school''s log',
  (select count(*) from audit_events where tenant_id = current_setting('t.a')::uuid) > 0);
select pg_temp.check('and nothing of another school''s',
  (select count(*) from audit_events where tenant_id is distinct from current_setting('t.a')::uuid) = 0);
do $$ begin
  insert into audit_events (tenant_id, actor_label, event, category) values (current_setting('t.a')::uuid, 'Forged', 'Forged', 'access');
  raise notice 'FAIL the area holder writes an audit event: allowed';
exception when others then raise notice 'PASS the area holder can''t write an audit event (%)', sqlstate; end $$;
do $$ declare n int; begin
  delete from audit_events where tenant_id = current_setting('t.a')::uuid;
  get diagnostics n = row_count;
  raise notice '% the area holder can''t remove an audit event (% removed)', case when n = 0 then 'PASS' else 'FAIL' end, n;
exception when others then raise notice 'PASS the area holder can''t remove an audit event (%)', sqlstate; end $$;
reset role;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.check('the school admin still reads the log without any area',
  (select count(*) from audit_events where tenant_id = current_setting('t.a')::uuid) > 0);
reset role;

rollback;
