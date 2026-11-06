\set ON_ERROR_STOP 1
\pset pager off
\pset format unaligned
\pset tuples_only on
set lock_timeout = '5s';
-- What would two changes buy? Run queries.sql first for the "before" figures on the same school; this file prints the "after".
-- Both experiments run inside a transaction that is ROLLED BACK; nothing is kept:
--   E1  split every FOR ALL policy into insert / update / delete, so a SELECT no longer evaluates the write check
--   E2  an index on attendance (tenant_id, term_id, taken_on desc)
select id as t from tenants where slug = 'load-test' \gset
select id as admin from profiles where email = 'principal@load-test.sc.ke' \gset
select id as teacher from profiles where login_id = 'TC-L001' \gset
select id as cls from classes where tenant_id = :'t' and class_teacher_id = :'teacher' \gset
select id as parent from profiles where login_id = 'PT-L0001' \gset
select '{' || string_agg(student_id::text, ',') || '}' as kids from guardians where profile_id = :'parent' \gset
select id as term from terms where tenant_id = :'t' and is_current \gset
select id as exam from exams where tenant_id = :'t' and term_id = :'term' and name = 'Opening exam' \gset
select count(*) as all_policies from pg_policies where schemaname = 'public' and cmd = 'ALL' \gset
\echo FOR ALL policies in the public schema: :all_policies

\echo ##### E2 index only: Dashboard latest register date, as admin
begin;
create index load_tmp_att on attendance (tenant_id, term_id, taken_on desc);
analyze attendance;
set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'admin', 'role', 'authenticated')::text, true);
explain (analyze, costs off) select taken_on from attendance where tenant_id = :'t' and term_id = :'term' order by taken_on desc limit 1;
rollback;

\echo ##### E1 split FOR ALL policies
begin;
do $$
declare r record; n int := 0;
begin
  for r in select schemaname, tablename, policyname, roles, qual, with_check from pg_policies where schemaname = 'public' and cmd = 'ALL' loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
    execute format('create policy %I on %I.%I for insert to %s with check (%s)', r.policyname || '_ins', r.schemaname, r.tablename, array_to_string(r.roles, ','), coalesce(r.with_check, r.qual));
    execute format('create policy %I on %I.%I for update to %s using (%s) with check (%s)', r.policyname || '_upd', r.schemaname, r.tablename, array_to_string(r.roles, ','), coalesce(r.qual, r.with_check), coalesce(r.with_check, r.qual));
    execute format('create policy %I on %I.%I for delete to %s using (%s)', r.policyname || '_del', r.schemaname, r.tablename, array_to_string(r.roles, ','), coalesce(r.qual, r.with_check));
    n := n + 1;
  end loop;
  raise notice 'split % FOR ALL policies', n;
end $$;

\echo --- E1 admin: latest register date
set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'admin', 'role', 'authenticated')::text, true);
explain (analyze, costs off) select taken_on from attendance where tenant_id = :'t' and term_id = :'term' order by taken_on desc limit 1;
\echo --- E1 admin: invoices of the term
explain (analyze, costs off) select total_cents, paid_cents from fee_invoices where tenant_id = :'t' and term_id = :'term';
\echo --- E1 admin: whole term of attendance
explain (analyze, costs off) select class_id, mark from attendance where tenant_id = :'t' and term_id = :'term';
\echo --- E1 admin: every mark of one exam
explain (analyze, costs off) select student_id, score from marks where tenant_id = :'t' and exam_id = :'exam';
\echo --- E1 admin: active learners
explain (analyze, costs off) select id, class_id from students where tenant_id = :'t' and active = true;
reset role;
select set_config('request.jwt.claims', json_build_object('sub', :'parent', 'role', 'authenticated')::text, true);
set local role authenticated;
\echo --- E1 parent: attendance of own children, every term
explain (analyze, costs off) select student_id, mark, taken_on from attendance where student_id = any(:'kids'::uuid[]);
\echo --- E1 parent: published marks of own children
explain (analyze, costs off) select m.student_id, m.exam_id, m.score, e.name, e.published_at from marks m left join exams e on e.id = m.exam_id where m.student_id = any(:'kids'::uuid[]) order by m.exam_id, m.student_id, m.subject_id limit 1000;
\echo --- E1 parent: payments of own children
explain (analyze, costs off) select p.id, p.amount_cents, p.completed_at from payments p join fee_invoices i on i.id = p.invoice_id where i.student_id = any(:'kids'::uuid[]) and p.status = 'success' order by p.completed_at desc;
reset role;
\echo --- E1 teacher: save a register of 42, new day
select set_config('request.jwt.claims', json_build_object('sub', :'teacher', 'role', 'authenticated')::text, true);
set local role authenticated;
explain (analyze, costs off) insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
  select :'t', s.id, s.class_id, :'term', :'teacher', '2026-11-02', 'present' from students s where s.class_id = :'cls'
  on conflict (student_id, taken_on) do update set mark = excluded.mark;
rollback;
