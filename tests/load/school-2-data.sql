\set ON_ERROR_STOP 1
-- Load test, step 3: the school's data. LOCAL DATABASE ONLY. One transaction: an error undoes all of it.
--
--   psql ... -v streams=9 -v per_class=42 -v teachers=60 < school-2-data.sql
--
-- Defaults give 4 forms x 9 streams = 36 classes of 42 = 1,512 learners, about 170,000 attendance rows,
-- 54,000 marks, 3,000 invoices, 4,300 payments and 1,000 guardian links. Needs the accounts from accounts.ts.
\if :{?streams} \else \set streams 9 \endif
\if :{?per_class} \else \set per_class 42 \endif
\if :{?teachers} \else \set teachers 60 \endif
begin;

-- The three org-summary triggers recount the whole school on EVERY row. Off for the bulk load only
-- (DDL is transactional, so a failure puts them back); the summary is refreshed once at the end.
alter table attendance   disable trigger refresh_org_summary_attendance;
alter table students     disable trigger refresh_org_summary_students;
alter table fee_invoices disable trigger refresh_org_summary_fee_invoices;

select id as t from tenants where slug = 'load-test' \gset
select id as alliance from tenants where slug = 'alliance' \gset

insert into subjects (tenant_id, name, code, is_core)
select :'t', name, code, is_core from subjects where tenant_id = :'alliance';

-- Form 1-4 x streams; class teacher = teacher number 1.. (every class gets one while there are enough teachers)
insert into classes (tenant_id, name, form_level, stream, level, class_teacher_id, room)
select :'t', 'Form ' || f || ' ' || chr(64 + sx), f, chr(64 + sx), 'secondary',
       (select id from profiles where tenant_id = :'t' and login_id = 'TC-L' || lpad(((f - 1) * :streams + sx)::text, 3, '0')),
       'R' || ((f - 1) * :streams + sx)
from generate_series(1, 4) f cross join generate_series(1, :streams) sx;

-- who teaches what: every (class, subject) has exactly one teacher
with c as (select id, row_number() over (order by form_level, stream) as ci from classes where tenant_id = :'t'),
     s as (select id, row_number() over (order by code) as si from subjects where tenant_id = :'t')
insert into teaching_assignments (tenant_id, teacher_id, class_id, subject_id)
select :'t', (select id from profiles where tenant_id = :'t' and login_id = 'TC-L' || lpad((((c.ci * 3 + s.si * 5) % :teachers) + 1)::text, 3, '0')), c.id, s.id
from c cross join s;

insert into students (tenant_id, admission_no, full_name, class_id, boarding, gender, date_of_birth)
select :'t', 'L-' || lpad(n::text, 5, '0'), 'Learner ' || n, c.id, (n % 3 = 0), case when n % 2 = 0 then 'female' else 'male' end,
       date '2008-01-01' + (n % 1500)::int
from (select id, row_number() over (order by form_level, stream) as ci from classes where tenant_id = :'t') c
cross join lateral generate_series((c.ci - 1) * :per_class + 1, c.ci * :per_class) n;

insert into terms (tenant_id, name, year, index, starts_on, ends_on, is_current) values
  (:'t', 'Term 1, 2026', 2026, 1, '2026-01-05', '2026-04-03', false),
  (:'t', 'Term 2, 2026', 2026, 2, '2026-05-04', '2026-08-01', false),
  (:'t', 'Term 3, 2026', 2026, 3, '2026-08-31', '2026-11-27', true);

-- every weekday of Terms 2 and 3 up to 30 October, taken by the class teacher
insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
select :'t', s.id, s.class_id, tm.id, c.class_teacher_id, d::date,
       (case when r > 0.94 then 'absent' when r > 0.90 then 'late' else 'present' end)::attendance_mark
from students s
join classes c on c.id = s.class_id
join terms tm on tm.tenant_id = :'t' and tm.index in (2, 3)
cross join lateral generate_series(tm.starts_on, least(tm.ends_on, date '2026-10-30'), interval '1 day') d
cross join lateral (select random() as r) rnd
where s.tenant_id = :'t' and extract(isodow from d) < 6;

insert into exams (tenant_id, term_id, name, out_of)
select :'t', tm.id, v.n, 100 from terms tm cross join (values ('Opening exam'), ('End of term')) v(n)
where tm.tenant_id = :'t' and tm.index in (2, 3);

insert into marks (tenant_id, exam_id, student_id, subject_id, score, entered_by)
select :'t', e.id, s.id, ta.subject_id, 30 + floor(random() * 65)::int, ta.teacher_id
from exams e
join students s on s.tenant_id = :'t'
join teaching_assignments ta on ta.class_id = s.class_id and ta.tenant_id = :'t'
where e.tenant_id = :'t';

-- results out: Term 2 "End of term" and Term 3 "Opening exam", every class and subject
insert into mark_publications (tenant_id, exam_id, class_id, subject_id)
select :'t', e.id, ta.class_id, ta.subject_id
from exams e join terms tm on tm.id = e.term_id
join teaching_assignments ta on ta.tenant_id = :'t'
where e.tenant_id = :'t' and ((tm.index = 2 and e.name = 'End of term') or (tm.index = 3 and e.name = 'Opening exam'));

insert into fee_items (tenant_id, term_id, name, amount_cents, applies_to, form_level, level)
select :'t', tm.id, fi.name, fi.amount_cents, fi.applies_to, fi.form_level, fi.level
from fee_items fi cross join terms tm
where fi.tenant_id = :'alliance' and fi.term_id = (select id from terms where tenant_id = :'alliance' and is_current)
  and tm.tenant_id = :'t' and tm.index in (2, 3);

insert into fee_invoices (tenant_id, student_id, term_id, total_cents, due_on)
select :'t', s.id, tm.id, case when s.boarding then 4500000 else 2800000 end, tm.starts_on + 14
from students s cross join terms tm
where s.tenant_id = :'t' and tm.tenant_id = :'t' and tm.index in (2, 3);

-- payments (the apply_payment trigger credits each invoice): 15% pay nothing, 30% pay 60%, 55% pay 60% then the rest
insert into payments (tenant_id, invoice_id, amount_cents, method, reference, status, completed_at)
select :'t', i.id, (i.total_cents * 6 / 10 / 1000) * 1000, 'bank', 'LOAD-A-' || substr(i.id::text, 1, 8), 'success', now() - interval '20 days'
from fee_invoices i where i.tenant_id = :'t' and abs(hashtext(i.id::text)) % 100 >= 15;

insert into payments (tenant_id, invoice_id, amount_cents, method, reference, status, completed_at)
select :'t', i.id, i.total_cents - (i.total_cents * 6 / 10 / 1000) * 1000, 'bank', 'LOAD-B-' || substr(i.id::text, 1, 8), 'success', now() - interval '5 days'
from fee_invoices i where i.tenant_id = :'t' and abs(hashtext(i.id::text)) % 100 >= 45;

-- parent k holds 1 to 3 children
with p as (select id, row_number() over (order by login_id) as k from profiles where tenant_id = :'t' and role = 'parent'),
     st as (select id, row_number() over (order by admission_no) as rn from students where tenant_id = :'t')
insert into guardians (tenant_id, profile_id, student_id, relationship, is_primary_payer)
select :'t', p.id, st.id, 'mother', true
from p join st on st.rn between (p.k - 1) * 3 + 1 and (p.k - 1) * 3 + 1 + (p.k % 3);

alter table attendance   enable trigger refresh_org_summary_attendance;
alter table students     enable trigger refresh_org_summary_students;
alter table fee_invoices enable trigger refresh_org_summary_fee_invoices;
select refresh_organization_tenant_summary(:'t');

commit;
analyze;

select 'students' as tbl, count(*) from students where tenant_id = :'t'
union all select 'classes', count(*) from classes where tenant_id = :'t'
union all select 'attendance', count(*) from attendance where tenant_id = :'t'
union all select 'marks', count(*) from marks where tenant_id = :'t'
union all select 'fee_invoices', count(*) from fee_invoices where tenant_id = :'t'
union all select 'payments', count(*) from payments where tenant_id = :'t'
union all select 'guardians', count(*) from guardians where tenant_id = :'t';
