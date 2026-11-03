\set ON_ERROR_STOP 1
\pset pager off
\pset format unaligned
\pset tuples_only on
-- QA 18: the hot queries of the apps, timed as the signed-in role they run as (RLS on) and, where it matters, as postgres (RLS off).
-- Needs the load school (tests/load/prepare.sh). Run it twice and read the second run (warm cache):
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < tests/load/queries.sql
-- Every block is rolled back. The Execution Time lines are the result; the P8 and P9 blocks take about 20 s each.
select id as t from tenants where slug = 'load-test' \gset
select id as teacher from profiles where login_id = 'TC-L001' \gset
select id as cls from classes where tenant_id = :'t' and class_teacher_id = :'teacher' \gset
select class_id as tcls, subject_id as tsubj from teaching_assignments where teacher_id = :'teacher' order by class_id limit 1 \gset
select id as parent from profiles where login_id = 'PT-L0001' \gset
select '{' || string_agg(student_id::text, ',') || '}' as kids from guardians where profile_id = :'parent' \gset
select id as kid1 from students where id = (select student_id from guardians where profile_id = :'parent' order by student_id limit 1) \gset
select class_id as kidcls from students where id = :'kid1' \gset
select id as admin from profiles where email = 'principal@load-test.sc.ke' \gset
select id as term from terms where tenant_id = :'t' and is_current \gset
select id as exam from exams where tenant_id = :'t' and term_id = :'term' and name = 'Opening exam' \gset

\echo ##### P1 teacher: class roster (42 learners) [RLS as teacher]
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'teacher', 'role', 'authenticated')::text, true);
explain (analyze, buffers, costs off) select id, full_name, admission_no from students where class_id = :'cls' order by full_name;
rollback;

\echo ##### P2 teacher: read today's register for one class and day [RLS as teacher]
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'teacher', 'role', 'authenticated')::text, true);
explain (analyze, buffers, costs off) select student_id, mark from attendance where class_id = :'cls' and taken_on = '2026-10-30';
rollback;

\echo ##### P3 teacher: SAVE a register of 42 (upsert, new day) [RLS as teacher, triggers on]
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'teacher', 'role', 'authenticated')::text, true);
explain (analyze, buffers, costs off) insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
  select :'t', s.id, s.class_id, :'term', :'teacher', '2026-11-02', 'present' from students s where s.class_id = :'cls'
  on conflict (student_id, taken_on) do update set mark = excluded.mark, taken_by = excluded.taken_by;
rollback;

\echo ##### P3b same save as postgres, org-summary triggers OFF for comparison
begin;
alter table attendance disable trigger refresh_org_summary_attendance;
explain (analyze, buffers, costs off) insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
  select :'t', s.id, s.class_id, :'term', :'teacher', '2026-11-02', 'present' from students s where s.class_id = :'cls'
  on conflict (student_id, taken_on) do update set mark = excluded.mark, taken_by = excluded.taken_by;
rollback;

\echo ##### P4 teacher: marks for one class and subject (read) [RLS as teacher]
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'teacher', 'role', 'authenticated')::text, true);
explain (analyze, buffers, costs off) select student_id, score from marks where exam_id = :'exam' and subject_id = :'tsubj' and student_id in (select id from students where class_id = :'tcls');
rollback;

\echo ##### P5 teacher: SAVE marks for one class and subject (upsert 42) [RLS as teacher]
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'teacher', 'role', 'authenticated')::text, true);
explain (analyze, buffers, costs off) insert into marks (tenant_id, exam_id, student_id, subject_id, score, entered_by)
  select :'t', :'exam', s.id, :'tsubj', 55, :'teacher' from students s where s.class_id = :'tcls'
  on conflict (exam_id, student_id, subject_id) do update set score = excluded.score;
rollback;

\echo ##### P6 admin Dashboard: all active learners [RLS as admin]
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'admin', 'role', 'authenticated')::text, true);
explain (analyze, buffers, costs off) select id, class_id from students where tenant_id = :'t' and active = true;
rollback;

\echo ##### P7 admin Dashboard: invoices of the term (1,512 rows) [RLS as admin]
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'admin', 'role', 'authenticated')::text, true);
explain (analyze, buffers, costs off) select total_cents, paid_cents from fee_invoices where tenant_id = :'t' and term_id = :'term';
rollback;

\echo ##### P7b same invoices as postgres (no RLS)
begin;
explain (analyze, buffers, costs off) select total_cents, paid_cents from fee_invoices where tenant_id = :'t' and term_id = :'term';
rollback;

\echo ##### P8 admin Dashboard: latest register date, then that day for the whole school [RLS as admin]
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'admin', 'role', 'authenticated')::text, true);
explain (analyze, buffers, costs off) select taken_on from attendance where tenant_id = :'t' and term_id = :'term' order by taken_on desc limit 1;
explain (analyze, buffers, costs off) select class_id, mark from attendance where tenant_id = :'t' and term_id = :'term' and taken_on = '2026-10-30';
rollback;

\echo ##### P9 admin Reports: whole term of attendance, no day filter (the app caps this at 1,000 rows) [RLS as admin]
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'admin', 'role', 'authenticated')::text, true);
explain (analyze, buffers, costs off) select class_id, mark from attendance where tenant_id = :'t' and term_id = :'term';
rollback;

\echo ##### P9b same, no RLS (postgres)
begin;
explain (analyze, buffers, costs off) select class_id, mark from attendance where tenant_id = :'t' and term_id = :'term';
rollback;

\echo ##### P10 admin Fees screen: invoices with learner and class, first page [RLS as admin]
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'admin', 'role', 'authenticated')::text, true);
explain (analyze, buffers, costs off) select i.id, i.total_cents, i.charges_cents, i.paid_cents, s.full_name, c.name
  from fee_invoices i join students s on s.id = i.student_id left join classes c on c.id = s.class_id
  where i.tenant_id = :'t' and i.term_id = :'term' order by i.id limit 1000;
rollback;

\echo ##### P11 admin Reports: every mark of one exam (12,096 rows) [RLS as admin]
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'admin', 'role', 'authenticated')::text, true);
explain (analyze, buffers, costs off) select student_id, score from marks where tenant_id = :'t' and exam_id = :'exam';
rollback;

\echo ##### P11b same, no RLS (postgres)
begin;
explain (analyze, buffers, costs off) select student_id, score from marks where tenant_id = :'t' and exam_id = :'exam';
rollback;

\echo ##### P12 parent: own children with class (guardians -> students -> classes) [RLS as parent]
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'parent', 'role', 'authenticated')::text, true);
explain (analyze, buffers, costs off) select s.id, s.full_name, s.admission_no, c.name from guardians g join students s on s.id = g.student_id left join classes c on c.id = s.class_id where g.profile_id = :'parent';
rollback;

\echo ##### P13 parent: attendance of own children, EVERY term (no term filter) [RLS as parent]
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'parent', 'role', 'authenticated')::text, true);
explain (analyze, buffers, costs off) select student_id, mark, taken_on from attendance where student_id = any(:'kids'::uuid[]);
rollback;

\echo ##### P14 parent: published marks of own children with exam name [RLS as parent]
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'parent', 'role', 'authenticated')::text, true);
explain (analyze, buffers, costs off) select m.student_id, m.exam_id, m.score, e.name, e.published_at from marks m left join exams e on e.id = m.exam_id
  where m.student_id = any(:'kids'::uuid[]) order by m.exam_id, m.student_id, m.subject_id limit 1000;
rollback;

\echo ##### P15 parent: class means for one exam (server-side function) [RLS as parent]
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'parent', 'role', 'authenticated')::text, true);
explain (analyze, buffers, costs off) select * from class_means_for_exam(:'exam', :'kidcls');
rollback;

\echo ##### P16 parent: invoice and payments of own children [RLS as parent]
begin; set local role authenticated; select set_config('request.jwt.claims', json_build_object('sub', :'parent', 'role', 'authenticated')::text, true);
explain (analyze, buffers, costs off) select i.id, i.student_id, i.total_cents, i.paid_cents, i.due_on from fee_invoices i join terms tm on tm.id = i.term_id where i.student_id = any(:'kids'::uuid[]) and tm.is_current;
explain (analyze, buffers, costs off) select p.id, p.amount_cents, p.completed_at from payments p join fee_invoices i on i.id = p.invoice_id where i.student_id = any(:'kids'::uuid[]) and p.status = 'success' order by p.completed_at desc;
rollback;

\echo ##### P17 org summary refresh, one call (what every attendance/student/invoice row write runs)
begin;
explain (analyze, costs off) select refresh_organization_tenant_summary(:'t');
rollback;
