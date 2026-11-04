-- Roles inside one school (QA 04, FIG-1237): can a parent, student, teacher or driver reach a record that is not theirs?
--
-- Runs against a local database that has the migrations applied and `npm run db:seed` data (the driver, trip, leave and
-- bus checks also need `npm run db:seed-org`, which adds Kijani Ridge; without it they print SKIPPED). Everything happens
-- inside one transaction that is rolled back. Each check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/roles_in_school.sql
--
-- How a check reads:
--   * "must refuse" attempts (a write, or a function call) are a PASS when the database refuses them or changes 0 rows, and a
--     FAIL when rows change. They print NOT PROVEN when there was no row to attack, so an empty table can never pass quietly.
--   * "must see 0" reads count what the user can see among rows that really exist for someone else.
--   * CONTROL lines are the same attempt by the person who IS allowed. They show the attack is capable of succeeding.
--   * INFO lines are things the database allows today that the issue may not expect. They are for a human to decide.
-- Run it on its own: the e2e suite writes to the same database. Check the psql exit code too, not only the FAIL count.

\set ON_ERROR_STOP 1
begin;

create temp table qa_out (kind text, label text);

create function pg_temp.say(p_kind text, p_label text) returns void language plpgsql as $$
begin
  insert into qa_out values (p_kind, p_label);
  raise notice '% %', p_kind, p_label;
end $$;

-- One statement as one user (authenticated, JWT sub = p_user), undone straight away. Returns rows changed, or the refusal.
create function pg_temp.try(p_user uuid, p_sql text) returns table (n bigint, code text, msg text) language plpgsql as $$
begin
  n := null; code := null; msg := null;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
    set local role authenticated;
    execute p_sql;
    get diagnostics n = row_count;
    reset role;
    raise exception using errcode = 'QA003';
  exception when others then
    if sqlstate <> 'QA003' then code := sqlstate; msg := sqlerrm; end if;
  end;
  return next;
end $$;

-- How many rows a "select count(*)" shows this user (-1 = the read was refused)
create function pg_temp.cnt(p_user uuid, p_sql text) returns bigint language plpgsql as $$
declare c bigint;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
    set local role authenticated;
    execute p_sql into c;
    reset role;
    raise exception using errcode = 'QA003';
  exception when others then
    if sqlstate <> 'QA003' then c := -1; end if;
  end;
  return c;
end $$;

-- A write or call that must be refused. p_pre = how many target rows exist (0 means nothing was really attacked).
create function pg_temp.refuse(p_label text, p_pre bigint, p_user uuid, p_sql text) returns void language plpgsql as $$
declare r record;
begin
  select * into r from pg_temp.try(p_user, p_sql);
  if p_pre = 0 then perform pg_temp.say('NOT PROVEN', p_label || ' (no target rows)');
  elsif r.code like '23%' then perform pg_temp.say('FAIL', p_label || ': got past the policy and failed later (' || r.code || ' ' || left(r.msg, 60) || ')');
  elsif r.code is not null then perform pg_temp.say('PASS', p_label || ' (refused: ' || left(r.msg, 60) || ')');
  elsif coalesce(r.n, 0) = 0 then perform pg_temp.say('PASS', p_label || ' (0 rows changed of ' || p_pre || ')');
  else perform pg_temp.say('FAIL', p_label || ' (' || r.n || ' rows changed)'); end if;
end $$;

-- The same kind of attempt by someone who is allowed to
create function pg_temp.allow(p_label text, p_user uuid, p_sql text) returns void language plpgsql as $$
declare r record;
begin
  select * into r from pg_temp.try(p_user, p_sql);
  if r.code is null and coalesce(r.n, 1) > 0 then perform pg_temp.say('CONTROL', p_label || ' (allowed, ' || coalesce(r.n::text, 'ran') || ')');
  else perform pg_temp.say('FAIL', 'CONTROL ' || p_label || ' was not allowed, so the matching refusal proves nothing: ' || coalesce(r.msg, '0 rows')); end if;
end $$;

-- A read that must show this user nothing of what exists for someone else
create function pg_temp.see0(p_label text, p_exist bigint, p_user uuid, p_sql text) returns void language plpgsql as $$
declare c bigint;
begin
  c := pg_temp.cnt(p_user, p_sql);
  if p_exist = 0 then perform pg_temp.say('NOT PROVEN', p_label || ' (no rows exist for anyone else)');
  elsif c > 0 then perform pg_temp.say('FAIL', p_label || ' (sees ' || c || ' of ' || p_exist || ')');
  else perform pg_temp.say('PASS', p_label || ' (sees 0 of ' || p_exist || ')'); end if;
end $$;

-- ================================================================ Alliance (db:seed): teacher, parent, student
do $$
declare
  tid uuid; teacher uuid; parent uuid; stu_p uuid; admin uuid; drv uuid; recep uuid;
  good uuid; bad uuid; ex uuid; cx uuid; stu uuid; inv uuid; kid uuid; stu_row uuid; other_kid uuid; other_inv uuid; my_inv uuid;
  pre bigint; doc uuid; prf uuid; ann uuid; other_class uuid; r record; tbl text; kids uuid[]; rte uuid; trp uuid;
  far uuid; expected bigint; o1 uuid; o2 uuid;
begin
  select id into tid from tenants where slug = 'alliance';
  select id into teacher from profiles where tenant_id = tid and role = 'teacher' order by id limit 1;
  select id into parent from profiles where tenant_id = tid and role = 'parent' order by id limit 1;
  select id into stu_p from profiles where tenant_id = tid and role = 'student' order by id limit 1;
  select id into admin from profiles where tenant_id = tid and role = 'school_admin' order by id limit 1;
  select id into drv from profiles where tenant_id = tid and role = 'driver' order by id limit 1;
  select id into recep from profiles where tenant_id = tid and role = 'receptionist' order by id limit 1;
  select subject_id into good from teaching_assignments where teacher_id = teacher limit 1;
  select id into bad from subjects where tenant_id = tid and id not in (select subject_id from teaching_assignments where teacher_id = teacher) order by id limit 1;
  select id into ex from exams where tenant_id = tid order by id limit 1;
  -- the class that holds the seeded marks and attendance
  select s.class_id into cx from marks m join students s on s.id = m.student_id where m.tenant_id = tid group by s.class_id order by count(*) desc limit 1;
  -- a class that neither the parent's children nor the student are in (the learners' classes differ on every reseed, so "the first other
  -- class" was sometimes one of the parent's own children's classes, and then the parent rightly reads the notice)
  select id into other_class from classes where tenant_id = tid and id <> cx
     and id not in (select s.class_id from students s join guardians g on g.student_id = s.id where g.profile_id = parent and s.class_id is not null)
     and id not in (select class_id from students where profile_id = stu_p and class_id is not null)
   order by id limit 1;
  select g.student_id into kid from guardians g where g.profile_id = parent order by (select count(*) from marks m where m.student_id = g.student_id) desc, g.student_id limit 1;   -- the child with results
  select array_agg(g.student_id) into kids from guardians g where g.profile_id = parent;     -- the parent may have several children
  select id into stu_row from students where profile_id = stu_p;
  select id into stu from students where tenant_id = tid and class_id = cx and id <> all (kids) and id <> stu_row order by id limit 1;
  select id into inv from fee_invoices where tenant_id = tid and student_id = stu limit 1;
  perform pg_temp.say('INFO', format('Alliance: teacher assigned %s, not assigned %s; the marks and attendance sit in %s',
    (select name from subjects where id = good), (select name from subjects where id = bad), (select name from classes where id = cx)));

  -- the marks the attacks aim at (a row in a subject the teacher does not teach)
  insert into marks (tenant_id, exam_id, student_id, subject_id, score, entered_by) values (tid, ex, stu, bad, 50, teacher) on conflict do nothing;
  insert into marks (tenant_id, exam_id, student_id, subject_id, score, entered_by) values (tid, ex, stu, good, 50, teacher) on conflict do nothing;   -- so there is something to publish

  -- ---------------------------------------------------------------- teacher: marks, exams, fees, publish
  select count(*) into pre from marks where tenant_id = tid and subject_id = bad;
  perform pg_temp.refuse('teacher: change a mark in a subject they are NOT assigned', pre, teacher, format('update marks set score = score + 1 where tenant_id=%L and subject_id=%L', tid, bad));
  perform pg_temp.refuse('teacher: delete a mark in a subject they are NOT assigned', pre, teacher, format('delete from marks where tenant_id=%L and subject_id=%L', tid, bad));
  perform pg_temp.refuse('teacher: add a mark in a subject they are NOT assigned', 1, teacher, format('insert into marks (tenant_id, exam_id, student_id, subject_id, score, entered_by) values (%L,%L,%L,%L,40,%L)', tid, ex, (select id from students where tenant_id = tid and id <> stu order by id limit 1), bad, teacher));
  perform pg_temp.allow('teacher: change a mark in the subject they ARE assigned', teacher, format('update marks set score = score where tenant_id=%L and subject_id=%L', tid, good));
  select count(*) into pre from exams where tenant_id = tid;
  perform pg_temp.refuse('teacher: edit an exam', pre, teacher, format('update exams set name = name || ''x'' where tenant_id=%L', tid));
  perform pg_temp.refuse('teacher: delete an exam', pre, teacher, format('delete from exams where tenant_id=%L', tid));
  perform pg_temp.refuse('teacher: create an exam', 1, teacher, format('insert into exams (tenant_id, term_id, name) select tenant_id, term_id, ''qa'' from exams where tenant_id=%L limit 1', tid));
  select count(*) into pre from fee_invoices where tenant_id = tid;
  perform pg_temp.refuse('teacher: change an invoice (fee data)', pre, teacher, format('update fee_invoices set paid_cents = total_cents where tenant_id=%L', tid));
  perform pg_temp.refuse('teacher: delete an invoice (fee data)', pre, teacher, format('delete from fee_invoices where tenant_id=%L', tid));
  perform pg_temp.refuse('teacher: create an invoice (fee data)', 1, teacher, format('insert into fee_invoices (tenant_id, student_id, term_id, total_cents, due_on) select tenant_id, student_id, term_id, 100, current_date from fee_invoices where tenant_id=%L limit 1', tid));
  perform pg_temp.refuse('teacher: publish_marks for a subject they are NOT assigned', 1, teacher, format('select public.publish_marks(%L,%L,%L)', ex, cx, bad));
  perform pg_temp.refuse('teacher: unpublish_marks for a subject they are NOT assigned', 1, teacher, format('select public.unpublish_marks(%L,%L,%L)', ex, cx, bad));
  perform pg_temp.allow('teacher: publish_marks for the subject they ARE assigned', teacher, format('select public.publish_marks(%L,%L,%L)', ex, cx, good));
  perform pg_temp.refuse('teacher: set homework for a subject they are NOT assigned', 1, teacher, format('insert into assignments (tenant_id, class_id, subject_id, set_by, title, body, due_on) values (%L,%L,%L,%L,''qa'',''qa'',current_date)', tid, cx, bad, teacher));
  perform pg_temp.allow('teacher: set homework for the subject they ARE assigned', teacher, format('insert into assignments (tenant_id, class_id, subject_id, set_by, title, body, due_on) values (%L,%L,%L,%L,''qa'',''qa'',current_date)', tid, cx, good, teacher));
  perform pg_temp.allow('teacher: change attendance of the class they teach', teacher, format('update attendance set mark = mark where class_id=%L', cx));

  -- rows of ANOTHER learner (neither the parent's children nor the student), so every "reads other learners" check below has something to hide
  insert into report_cards (tenant_id, term_id, student_id, class_id, data, published_at) values (tid, (select term_id from exams where id = ex), stu, cx, '{}'::jsonb, now());
  -- health details need a recorded consent first (20261103100000_health_consent.sql). Older databases have no such table.
  if to_regclass('public.health_consents') is not null then
    execute format('insert into health_consents (student_id, tenant_id, status, method, signed_by) values (%L, %L, ''given'', ''paper'', ''QA fixture'')', stu, tid);
  end if;
  insert into student_health (student_id, tenant_id, notes) values (stu, tid, 'qa fixture');
  insert into routes (tenant_id, name) values (tid, 'QA route') returning id into rte;
  insert into student_transport (tenant_id, student_id, route_id) values (tid, stu, rte);
  insert into trips (tenant_id, vehicle_id, driver_id) values (tid, (select id from vehicles where tenant_id = tid limit 1), drv) returning id into trp;
  insert into trip_riders (tenant_id, trip_id, student_id) values (tid, trp, stu);

  -- ---------------------------------------------------------------- teacher: private documents and payment proofs (known gap)
  insert into student_documents (tenant_id, student_id, uploaded_by, doc_type, file_path, file_name) values (tid, stu, admin, 'other', 'qa/x.pdf', 'x.pdf') returning id into doc;
  insert into payment_proofs (tenant_id, invoice_id, uploaded_by, file_path, file_name) values (tid, inv, parent, 'qa/p.png', 'p.png') returning id into prf;
  perform pg_temp.refuse('teacher: overwrite a private document', 1, teacher, format('update student_documents set file_path = ''qa/evil.pdf'' where id=%L', doc));
  perform pg_temp.refuse('teacher: delete a private document', 1, teacher, format('delete from student_documents where id=%L', doc));
  perform pg_temp.refuse('teacher: confirm or change a payment proof', 1, teacher, format('update payment_proofs set status = status, reviewed_by = %L where id=%L', teacher, prf));
  perform pg_temp.refuse('teacher: delete a payment proof', 1, teacher, format('delete from payment_proofs where id=%L', prf));
  -- ---------------------------------------------------------------- teacher: fees, private documents, health and marks (FIG-1303)
  -- A teacher reads only what their own work needs: no fee data, no private documents, no health record (a short flag for the learners of
  -- classes they teach), and the marks of the classes and subjects they are assigned plus every subject of the class they are the class
  -- teacher of.
  perform pg_temp.see0('teacher reads fee invoices', (select count(*) from fee_invoices where tenant_id = tid), teacher, 'select count(*) from fee_invoices');
  perform pg_temp.see0('teacher reads payments', (select count(*) from payments where tenant_id = tid), teacher, 'select count(*) from payments');
  perform pg_temp.see0('teacher reads payment proofs', 1, teacher, format('select count(*) from payment_proofs where id=%L', prf));
  perform pg_temp.see0('teacher reads private documents', 1, teacher, format('select count(*) from student_documents where id=%L', doc));
  perform pg_temp.see0('teacher reads health records', (select count(*) from student_health where tenant_id = tid), teacher, 'select count(*) from student_health');
  perform pg_temp.say(case when pg_temp.cnt(admin, 'select count(*) from fee_invoices') > 0 and pg_temp.cnt(admin, format('select count(*) from student_documents where id=%L', doc)) = 1
                           and pg_temp.cnt(admin, format('select count(*) from payment_proofs where id=%L', prf)) = 1 and pg_temp.cnt(admin, 'select count(*) from student_health') > 0
                      then 'CONTROL' else 'FAIL' end, 'the school admin reads the invoices, the document, the proof and the health records (so the 0s above are the teacher, not an empty table)');
  -- the files behind a document and a proof
  insert into storage.objects (bucket_id, name) values ('private-documents', tid || '/students/' || stu || '/qa.pdf') returning id into o1;
  insert into storage.objects (bucket_id, name) values ('private-documents', tid || '/invoices/' || inv || '/qa.png') returning id into o2;
  perform pg_temp.see0('teacher reads the file of a learner''s private document', 1, teacher, format('select count(*) from storage.objects where id=%L', o1));
  perform pg_temp.see0('teacher reads the file of a payment proof', 1, teacher, format('select count(*) from storage.objects where id=%L', o2));
  perform pg_temp.say(case when pg_temp.cnt(admin, format('select count(*) from storage.objects where id in (%L, %L)', o1, o2)) = 2 then 'CONTROL' else 'FAIL' end, 'the school admin reads both files');
  -- a mark in a class and subject the teacher has nothing to do with: it exists and must stay hidden
  select s.id into far from students s join classes c on c.id = s.class_id where s.tenant_id = tid and s.class_id <> cx and c.class_teacher_id is distinct from teacher order by s.id limit 1;
  insert into marks (tenant_id, exam_id, student_id, subject_id, score, entered_by) values (tid, ex, far, bad, 33, teacher) on conflict do nothing;
  perform pg_temp.see0('teacher reads a mark in a subject and class they are not assigned to', 1, teacher, format('select count(*) from marks where student_id=%L and subject_id=%L', far, bad));
  select count(*) into expected from marks m join students s on s.id = m.student_id
   where m.tenant_id = tid and (exists (select 1 from teaching_assignments ta where ta.teacher_id = teacher and ta.subject_id = m.subject_id and ta.class_id = s.class_id)
                              or exists (select 1 from classes c where c.id = s.class_id and c.class_teacher_id = teacher));
  perform pg_temp.say(case when pg_temp.cnt(teacher, 'select count(*) from marks') = expected and expected > 0 and expected < (select count(*) from marks where tenant_id = tid) then 'PASS' else 'FAIL' end,
    format('teacher reads exactly the marks of their assigned classes and subjects, and every subject of their own class (%s of %s)', pg_temp.cnt(teacher, 'select count(*) from marks'), (select count(*) from marks where tenant_id = tid)));
  -- the health flags: a learner of a class they teach, and only the five flag fields
  perform pg_temp.say(case when pg_temp.cnt(teacher, format('select count(*) from teacher_health_flags(array[%L]::uuid[])', stu)) = 1 then 'CONTROL' else 'FAIL' end, 'teacher: the health flags of a learner in a class they teach');
  perform pg_temp.say(case when pg_get_function_result('teacher_health_flags(uuid[])'::regprocedure) !~ '(blood|notes|doctor|emergency)' then 'PASS' else 'FAIL' end, 'the health flags answer holds no blood group, notes, doctor or emergency contact');
  perform pg_temp.say(case when has_function_privilege('anon', 'teacher_health_flags(uuid[])', 'execute') then 'FAIL' else 'PASS' end, 'a signed-out visitor cannot call teacher_health_flags');

  -- ---------------------------------------------------------------- parent: reads, then writes
  select s.id into other_kid from students s where s.tenant_id = tid and s.id not in (select student_id from guardians where profile_id = parent) order by s.id limit 1;
  select id into other_inv from fee_invoices where student_id = other_kid limit 1;
  select id into my_inv from fee_invoices where student_id = kid limit 1;
  for tbl in select unnest(array['attendance','cbe_results','cbe_assessment_comments','assignment_submissions','fee_invoices','marks','report_cards','student_documents','student_health','student_transport','trip_riders','student_bio_requests','exam_attempts']
                                 || case when to_regclass('public.health_consents') is not null then array['health_consents'] else array[]::text[] end) loop
    execute format('select count(*) from public.%I where student_id <> all (%L::uuid[]) and student_id in (select id from students where tenant_id = %L)', tbl, kids, tid) into pre;
    perform pg_temp.see0('parent reads other learners'' ' || tbl, pre, parent, format('select count(*) from public.%I where student_id <> all (%L::uuid[])', tbl, kids));
  end loop;
  perform pg_temp.see0('parent reads other learners (students table)', (select count(*) from students where tenant_id = tid and id <> all (kids)), parent, format('select count(*) from students where id <> all (%L::uuid[])', kids));
  perform pg_temp.see0('parent reads payment proofs on other learners'' invoices', (select count(*) from payment_proofs p join fee_invoices i on i.id = p.invoice_id where i.student_id <> all (kids)), parent,
    format('select count(*) from payment_proofs p join fee_invoices i on i.id = p.invoice_id where i.student_id <> all (%L::uuid[])', kids));
  perform pg_temp.say('INFO', format('parent has %s linked children and sees %s learners', cardinality(kids), pg_temp.cnt(parent, 'select count(*) from students')));
  perform pg_temp.refuse('parent: upload a payment proof on ANOTHER learner''s invoice', 1, parent, format('insert into payment_proofs (tenant_id, invoice_id, uploaded_by, file_path, file_name) values (%L,%L,%L,''qa/p.png'',''p.png'')', tid, other_inv, parent));
  perform pg_temp.allow('parent: upload a payment proof on their OWN child''s invoice', parent, format('insert into payment_proofs (tenant_id, invoice_id, uploaded_by, file_path, file_name) values (%L,%L,%L,''qa/p.png'',''p.png'')', tid, my_inv, parent));
  perform pg_temp.refuse('parent: mark an invoice paid', 1, parent, format('update fee_invoices set paid_cents = total_cents where id=%L', my_inv));
  perform pg_temp.refuse('parent: change ANOTHER learner''s record', 1, parent, format('update students set full_name = ''x'' where id=%L', other_kid));
  perform pg_temp.refuse('parent: edit attendance', (select count(*) from attendance where student_id = kid), parent, format('update attendance set mark = mark where student_id=%L', kid));
  perform pg_temp.refuse('parent: link themself to ANOTHER learner', 1, parent, format('insert into guardians (tenant_id, profile_id, student_id, relationship) values (%L,%L,%L,''father'')', tid, parent, other_kid));
  perform pg_temp.refuse('parent: re-point their link to ANOTHER learner', 1, parent, format('update guardians set student_id=%L where profile_id=%L', other_kid, parent));

  -- ---------------------------------------------------------------- student: own record only
  select id into other_kid from students where tenant_id = tid and id <> stu_row order by id limit 1;
  select id into other_inv from fee_invoices where student_id = other_kid limit 1;
  perform pg_temp.see0('student reads other learners (students table)', (select count(*) from students where tenant_id = tid and id <> stu_row), stu_p, format('select count(*) from students where id <> %L', stu_row));
  for tbl in select unnest(array['fee_invoices','attendance','marks','cbe_results','report_cards','student_documents','student_health','trip_riders','assignment_submissions']
                                 || case when to_regclass('public.health_consents') is not null then array['health_consents'] else array[]::text[] end) loop
    execute format('select count(*) from public.%I where student_id <> %L and student_id in (select id from students where tenant_id = %L)', tbl, stu_row, tid) into pre;
    perform pg_temp.see0('student reads other learners'' ' || tbl, pre, stu_p, format('select count(*) from public.%I where student_id <> %L', tbl, stu_row));
  end loop;
  perform pg_temp.refuse('student: mark an invoice paid', (select count(*) from fee_invoices where student_id = stu_row), stu_p, format('update fee_invoices set paid_cents = total_cents where student_id=%L', stu_row));
  perform pg_temp.refuse('student: change their own results', (select count(*) from cbe_results where student_id = stu_row), stu_p, format('update cbe_results set id = id where student_id=%L', stu_row));
  perform pg_temp.refuse('student: change their own attendance', (select count(*) from attendance where student_id = stu_row), stu_p, format('update attendance set mark = mark where student_id=%L', stu_row));
  perform pg_temp.refuse('student: change their own marks', (select count(*) from marks where student_id = stu_row), stu_p, format('update marks set score = 100 where student_id=%L', stu_row));
  perform pg_temp.refuse('student: upload a payment proof on ANOTHER learner''s invoice', 1, stu_p, format('insert into payment_proofs (tenant_id, invoice_id, uploaded_by, file_path, file_name) values (%L,%L,%L,''qa/p.png'',''p.png'')', tid, other_inv, stu_p));

  -- ---------------------------------------------------------------- announcements: the read rule honours the audience
  select id into ann from announcements where tenant_id = tid and audience ->> 'kind' = 'class' limit 1;
  update announcements set audience = jsonb_build_object('kind', 'class', 'class_id', other_class) where id = ann;
  perform pg_temp.see0('notice aimed at another class: the parent in a different class does not read it', 1, parent, format('select count(*) from announcements where id=%L', ann));
  perform pg_temp.see0('notice aimed at another class: the student in a different class does not read it', 1, stu_p, format('select count(*) from announcements where id=%L', ann));
  perform pg_temp.see0('notice aimed at another class: the driver does not read it', 1, drv, format('select count(*) from announcements where id=%L', ann));
  perform pg_temp.see0('notice aimed at another class: the receptionist does not read it', 1, recep, format('select count(*) from announcements where id=%L', ann));
  update announcements set audience = jsonb_build_object('kind', 'class', 'class_id', cx) where id = ann;
  perform pg_temp.say(case when pg_temp.cnt(parent, format('select count(*) from announcements where id=%L', ann)) = 1 then 'CONTROL' else 'FAIL' end, 'notice aimed at the parent''s own class: the parent reads it');

  -- ---------------------------------------------------------------- results: only once published
  perform pg_temp.say(case when pg_temp.cnt(parent, format('select count(*) from marks where student_id=%L', kid)) > 0 then 'CONTROL' else 'FAIL' end, 'published results: the parent reads their child''s marks');
  delete from mark_publications where class_id = cx;
  perform pg_temp.see0('results not published: the parent reads none of their child''s marks', (select count(*) from marks where student_id = kid), parent, format('select count(*) from marks where student_id=%L', kid));
  perform pg_temp.see0('results not published: the student reads none of their own marks', (select count(*) from marks where student_id = stu_row), stu_p, format('select count(*) from marks where student_id=%L', stu_row));

  -- ---------------------------------------------------------------- teacher: a class they do not teach (last, it removes their assignment)
  delete from teaching_assignments where teacher_id = teacher and class_id = cx;
  update classes set class_teacher_id = null where id = cx;      -- the class teacher may take attendance too; this one no longer is
  select count(*) into pre from attendance where class_id = cx;
  perform pg_temp.refuse('teacher: change attendance of a class they do NOT teach', pre, teacher, format('update attendance set mark = mark where class_id=%L', cx));
  perform pg_temp.refuse('teacher: delete attendance of a class they do NOT teach', pre, teacher, format('delete from attendance where class_id=%L', cx));
  perform pg_temp.refuse('teacher: add attendance for a class they do NOT teach', pre, teacher, format('insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark) select tenant_id, student_id, class_id, term_id, %L, (select t.starts_on from terms t where t.id = attendance.term_id), mark from attendance where class_id=%L limit 1', teacher, cx));
  select count(*) into pre from marks m join students s on s.id = m.student_id where s.class_id = cx and m.subject_id = good;
  perform pg_temp.refuse('teacher: change marks of the same subject in a class they do NOT teach', pre, teacher, format('update marks set score = score + 1 where subject_id=%L and student_id in (select id from students where class_id=%L)', good, cx));
  perform pg_temp.refuse('teacher: set homework for a class they do NOT teach', 1, teacher, format('insert into assignments (tenant_id, class_id, subject_id, set_by, title, body, due_on) values (%L,%L,%L,%L,''qa'',''qa'',current_date)', tid, cx, good, teacher));
  perform pg_temp.refuse('teacher: publish_marks for a class they do NOT teach', 1, teacher, format('select public.publish_marks(%L,%L,%L)', ex, cx, good));
  perform pg_temp.see0('teacher reads the marks of a class they do not teach', (select count(*) from marks m join students s on s.id = m.student_id where s.class_id = cx), teacher,
    format('select count(*) from marks m join students s on s.id = m.student_id where s.class_id = %L', cx));
  perform pg_temp.see0('teacher reads the health flags of a learner in a class they do not teach', 1, teacher, format('select count(*) from teacher_health_flags(array[%L]::uuid[])', stu));

  -- ---------------------------------------------------------------- archived learner: the sign-in ends (FIG-1305)
  -- Archiving bans the learner's login the way suspending a school does; restoring lifts exactly that ban; reactivating a school does not
  -- lift the ban of a learner archived in the meantime. The parent still sees an archived child and their invoices (fees may be owed).
  perform set_config('request.jwt.claims', json_build_object('sub', admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform archive_learners(array[stu_row]::uuid[]);
  reset role;
  perform pg_temp.say(case when (select banned_until > now() + interval '50 years' and raw_app_meta_data ->> 'archived_learner' = 'true' from auth.users where id = stu_p) then 'PASS' else 'FAIL' end,
    'archiving a learner bans their login (banned_until far ahead, flagged archived_learner)');
  perform pg_temp.say(case when (select count(*) from auth.sessions where user_id = stu_p) = 0 then 'PASS' else 'FAIL' end, 'and ends their sessions');
  perform pg_temp.say(case when (select banned_until is null from auth.users u join profiles p on p.id = u.id where p.tenant_id = tid and p.role = 'teacher' order by u.id limit 1) then 'PASS' else 'FAIL' end,
    'nobody else is banned by it (a teacher of the school can still sign in)');
  update tenants set status = 'suspended' where id = tid;
  update tenants set status = 'active' where id = tid;
  perform pg_temp.say(case when (select banned_until > now() + interval '50 years' from auth.users where id = stu_p) then 'PASS' else 'FAIL' end,
    'reactivating the school does not lift the ban of a learner archived before or during the suspension');
  perform pg_temp.say(case when (select banned_until is null from auth.users u join profiles p on p.id = u.id where p.tenant_id = tid and p.role = 'teacher' order by u.id limit 1) then 'PASS' else 'FAIL' end,
    'but it does lift the school''s own ban on everyone else');
  perform set_config('request.jwt.claims', json_build_object('sub', admin, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform restore_learners(array[stu_row]::uuid[]);
  reset role;
  perform pg_temp.say(case when (select banned_until is null and not (raw_app_meta_data ? 'archived_learner') from auth.users where id = stu_p) then 'PASS' else 'FAIL' end,
    'restoring the learner lifts the ban');
  perform pg_temp.say(case when pg_temp.cnt(teacher, format('select count(*) from (select archive_learners(array[%L]::uuid[])) x', stu_row)) = -1 then 'PASS' else 'FAIL' end,
    'a teacher cannot archive a learner (and so cannot ban one)');

  -- ---------------------------------------------------------------- archived learner: what they and their parent still read
  update students set archived_at = now(), active = false where id in (stu_row, kid);
  perform pg_temp.say('INFO', format('archived learner: still reads own record %s, own invoices %s; the parent still sees the archived child %s and their invoices %s (sign-in itself is not checked here)',
    pg_temp.cnt(stu_p, format('select count(*) from students where id=%L', stu_row)), pg_temp.cnt(stu_p, format('select count(*) from fee_invoices where student_id=%L', stu_row)),
    pg_temp.cnt(parent, format('select count(*) from students where id=%L', kid)), pg_temp.cnt(parent, format('select count(*) from fee_invoices where student_id=%L', kid))));
end $$;

-- ================================================================ Kijani Ridge (db:seed-org): drivers, trips, leave, bus positions
do $$
declare
  tid uuid; teacher uuid; parent uuid; stu_p uuid; admin uuid; drv uuid; myveh uuid; othveh uuid; othdrv uuid; trp uuid; pend uuid; lv uuid; kid uuid;
  famveh uuid; rt uuid;
begin
  select id into tid from tenants where slug = 'kijani-ridge';
  if tid is null then perform pg_temp.say('SKIPPED', 'Kijani Ridge is not seeded (run npm run db:seed-org): driver, trip, leave and bus checks did not run'); return; end if;
  select id into teacher from profiles where tenant_id = tid and role = 'teacher' order by id limit 1;
  select id into parent from profiles where tenant_id = tid and role = 'parent' order by id limit 1;
  select id into stu_p from profiles where tenant_id = tid and role = 'student' order by id limit 1;
  select id into admin from profiles where tenant_id = tid and role = 'school_admin' order by id limit 1;
  select va.driver_id, va.vehicle_id into drv, myveh from vehicle_assignments va where va.tenant_id = tid order by va.driver_id limit 1;
  select va.driver_id, va.vehicle_id into othdrv, othveh from vehicle_assignments va where va.tenant_id = tid and va.vehicle_id <> myveh limit 1;
  select g.student_id into kid from guardians g where g.profile_id = parent limit 1;

  -- ---------------------------------------------------------------- driver
  perform pg_temp.refuse('driver: change speed_limit_kmh of their OWN vehicle', 1, drv, format('update vehicles set speed_limit_kmh = 250 where id=%L', myveh));
  perform pg_temp.allow('driver: update the position of their own vehicle', drv, format('update vehicles set last_lat = last_lat where id=%L', myveh));
  perform pg_temp.refuse('driver: change the speed limit of ANOTHER vehicle', 1, drv, format('update vehicles set speed_limit_kmh = 250 where id=%L', othveh));
  perform pg_temp.refuse('driver: move ANOTHER vehicle (fake position)', 1, drv, format('update vehicles set last_lat = 0, last_lng = 0 where id=%L', othveh));
  perform pg_temp.refuse('driver: delete ANOTHER vehicle', 1, drv, format('delete from vehicles where id=%L', othveh));
  insert into vehicle_locations (tenant_id, vehicle_id, lat, lng) values (tid, othveh, -1.0, 36.0) returning id into lv;
  perform pg_temp.see0('driver reads the pings of ANOTHER vehicle', 1, drv, format('select count(*) from vehicle_locations where vehicle_id=%L', othveh));
  perform pg_temp.refuse('driver: add a ping for ANOTHER vehicle', 1, drv, format('insert into vehicle_locations (tenant_id, vehicle_id, lat, lng) values (%L,%L,-1.0,36.0)', tid, othveh));
  insert into trips (tenant_id, vehicle_id, driver_id) values (tid, othveh, othdrv) returning id into trp;
  perform pg_temp.see0('driver reads ANOTHER driver''s trip', 1, drv, format('select count(*) from trips where id=%L', trp));
  perform pg_temp.refuse('driver: change ANOTHER driver''s trip', 1, drv, format('update trips set status = status where id=%L', trp));
  perform pg_temp.refuse('driver: delete ANOTHER driver''s trip', 1, drv, format('delete from trips where id=%L', trp));
  perform pg_temp.see0('driver reads learners'' fee invoices', (select count(*) from fee_invoices where tenant_id = tid), drv, 'select count(*) from fee_invoices');
  perform pg_temp.see0('driver reads learners'' marks', (select count(*) from marks where tenant_id = tid), drv, 'select count(*) from marks');
  perform pg_temp.see0('driver reads learners'' attendance', (select count(*) from attendance where tenant_id = tid), drv, 'select count(*) from attendance');

  -- ---------------------------------------------------------------- who can see which bus (FIG-1304)
  -- A driver reads only their own bus; a parent (or a learner) only the bus on the route their child (they) ride, that is a vehicle that
  -- runs a trip on it; teachers, the school admin and the transport area every bus.
  update vehicles set last_lat = -1.3, last_lng = 36.8, last_ping_at = now() where tenant_id = tid;
  select id into famveh from vehicles where tenant_id = tid and id <> myveh and id <> othveh order by id limit 1;
  insert into routes (tenant_id, name) values (tid, 'QA family route') returning id into rt;
  insert into trips (tenant_id, vehicle_id, route_id, driver_id) values (tid, famveh, rt, othdrv);
  -- the parent's child rides that route (a row per learner, so it replaces any seeded one); the learner who signs in does not ride yet
  insert into student_transport (tenant_id, student_id, route_id) values (tid, kid, rt)
    on conflict (student_id) do update set route_id = excluded.route_id;
  delete from student_transport where student_id = (select id from students where profile_id = stu_p);
  perform pg_temp.say(case when pg_temp.cnt(drv, 'select count(*) from vehicles') = 1 and pg_temp.cnt(drv, format('select count(*) from vehicles where id=%L', myveh)) = 1 then 'PASS' else 'FAIL' end,
    'a driver reads only their own bus (' || pg_temp.cnt(drv, 'select count(*) from vehicles') || ' of ' || (select count(*) from vehicles where tenant_id = tid) || ')');
  perform pg_temp.say(case when pg_temp.cnt(parent, 'select count(*) from vehicles') = 1 and pg_temp.cnt(parent, format('select count(*) from vehicles where id=%L', famveh)) = 1 then 'PASS' else 'FAIL' end,
    'a parent reads only the bus their child rides (' || pg_temp.cnt(parent, 'select count(*) from vehicles') || ' of ' || (select count(*) from vehicles where tenant_id = tid) || ')');
  perform pg_temp.say(case when pg_temp.cnt(stu_p, 'select count(*) from vehicles') = 0 then 'PASS' else 'FAIL' end, 'a learner who rides no bus reads no bus');
  insert into student_transport (tenant_id, student_id, route_id) select tid, id, rt from students where profile_id = stu_p;
  perform pg_temp.say(case when pg_temp.cnt(stu_p, 'select count(*) from vehicles') = 1 and pg_temp.cnt(stu_p, format('select count(*) from vehicles where id=%L', famveh)) = 1 then 'PASS' else 'FAIL' end,
    'a learner who rides reads only their own bus');
  perform pg_temp.say(case when pg_temp.cnt(teacher, 'select count(*) from vehicles') = (select count(*) from vehicles where tenant_id = tid) and (select count(*) from vehicles where tenant_id = tid) > 1 then 'CONTROL' else 'FAIL' end,
    'a teacher reads every bus of the school');
  perform pg_temp.say(case when pg_temp.cnt(admin, 'select count(*) from vehicles') = (select count(*) from vehicles where tenant_id = tid) then 'CONTROL' else 'FAIL' end, 'the school admin reads every bus');
  perform pg_temp.say(case when pg_temp.cnt(parent, 'select count(last_lat) from vehicles') = 1 then 'PASS' else 'FAIL' end, 'so a parent sees the position of one bus only');

  -- ---------------------------------------------------------------- teacher leave (known gap)
  select id into pend from leave_requests where teacher_id = teacher and status = 'pending' limit 1;
  if pend is null then
    insert into leave_requests (tenant_id, teacher_id, starts_on, ends_on) values (tid, teacher, current_date, current_date) returning id into pend;
  end if;
  perform pg_temp.refuse('teacher: approve their OWN leave request', 1, teacher, format('update leave_requests set status = ''approved'' where id=%L', pend));
  perform pg_temp.refuse('teacher: set reviewed_by on their OWN leave request', 1, teacher, format('update leave_requests set reviewed_by = %L where id=%L', teacher, pend));
  perform pg_temp.allow('teacher: withdraw their OWN pending leave request', teacher, format('update leave_requests set status = ''cancelled'' where id=%L', pend));
  perform pg_temp.refuse('teacher: file leave in SOMEONE ELSE''S name', 1, teacher, format('insert into leave_requests (tenant_id, teacher_id, starts_on, ends_on) values (%L,%L,current_date,current_date)', tid, admin));
end $$;

-- ================================================================ result
do $$
declare r record;
begin
  for r in select kind, count(*) c from qa_out group by kind order by kind loop
    raise notice 'TOTAL % : %', rpad(r.kind, 11), r.c;
  end loop;
  if exists (select 1 from qa_out where kind = 'FAIL') then raise notice 'RESULT: FAIL (% check(s) failed)', (select count(*) from qa_out where kind = 'FAIL');
  else raise notice 'RESULT: PASS (no check failed; read the INFO and NOT PROVEN lines)'; end if;
end $$;

rollback;
