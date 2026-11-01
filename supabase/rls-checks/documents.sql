-- Document and payment-proof checks for 20261026070000_office_only_documents_and_proofs.
--
-- Runs against a local database that has the migrations applied and
-- `npm run db:seed` data, inside one transaction that is rolled back.
-- Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/documents.sql

\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------- fixtures (as postgres)
select set_config('t.a',       (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.admin',   (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.a')::uuid limit 1), true);
-- a teacher, and a class and subject they teach
select set_config('t.teacher', (select ta.teacher_id::text from teaching_assignments ta join profiles p on p.id = ta.teacher_id
                                 where p.tenant_id = current_setting('t.a')::uuid limit 1), true);
select set_config('t.cls',     (select class_id::text from teaching_assignments where teacher_id = current_setting('t.teacher')::uuid limit 1), true);
select set_config('t.sub',     (select subject_id::text from teaching_assignments where teacher_id = current_setting('t.teacher')::uuid limit 1), true);
-- a class and subject pair that teacher does NOT teach
select set_config('t.cls2',    (select c.id::text from classes c, subjects sj
                                 where c.tenant_id = current_setting('t.a')::uuid and sj.tenant_id = current_setting('t.a')::uuid
                                   and not exists (select 1 from teaching_assignments m where m.teacher_id = current_setting('t.teacher')::uuid
                                                    and m.class_id = c.id and m.subject_id = sj.id)
                                 order by c.id, sj.id limit 1), true);
select set_config('t.sub2',    (select sj.id::text from classes c, subjects sj
                                 where c.id = current_setting('t.cls2')::uuid and sj.tenant_id = current_setting('t.a')::uuid
                                   and not exists (select 1 from teaching_assignments m where m.teacher_id = current_setting('t.teacher')::uuid
                                                    and m.class_id = c.id and m.subject_id = sj.id)
                                 order by sj.id limit 1), true);
select set_config('t.inv',     (select id::text from fee_invoices where tenant_id = current_setting('t.a')::uuid limit 1), true);
select set_config('t.stu',     (select student_id::text from fee_invoices where id = current_setting('t.inv')::uuid), true);

insert into exam_papers (tenant_id, title, class_id, subject_id)
  values (current_setting('t.a')::uuid, 'check mine',  current_setting('t.cls')::uuid,  current_setting('t.sub')::uuid);
insert into exam_papers (tenant_id, title, class_id, subject_id)
  values (current_setting('t.a')::uuid, 'check other', current_setting('t.cls2')::uuid, current_setting('t.sub2')::uuid);
select set_config('t.paper1', (select id::text from exam_papers where title = 'check mine'), true);
select set_config('t.paper2', (select id::text from exam_papers where title = 'check other'), true);

insert into payment_proofs (tenant_id, invoice_id, uploaded_by, file_path, file_name)
  values (current_setting('t.a')::uuid, current_setting('t.inv')::uuid, current_setting('t.admin')::uuid, 'p/check.png', 'check.png');
select set_config('t.proof', (select id::text from payment_proofs where file_name = 'check.png'), true);
insert into student_documents (tenant_id, student_id, uploaded_by, doc_type, file_path, file_name)
  values (current_setting('t.a')::uuid, current_setting('t.stu')::uuid, current_setting('t.admin')::uuid, 'birth certificate', 'p/check.pdf', 'check.pdf');
select set_config('t.doc', (select id::text from student_documents where file_name = 'check.pdf'), true);
-- a learner document and a payment slip already in the bucket
insert into storage.objects (bucket_id, name)
  values ('private-documents', current_setting('t.a') || '/students/' || current_setting('t.stu') || '/check.pdf'),
         ('private-documents', current_setting('t.a') || '/invoices/' || current_setting('t.inv') || '/check.png');

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when ok then 'PASS' else 'FAIL' end, label; end $$;
-- A statement that must be refused with this SQLSTATE.
create function pg_temp.expect_error(label text, stmt text, errcode text) returns void language plpgsql as $$
begin
  begin execute stmt; raise notice 'FAIL %: allowed', label;
  exception when others then
    if sqlstate = errcode then raise notice 'PASS % (%)', label, sqlerrm;
    else raise notice 'FAIL %: % %', label, sqlstate, sqlerrm; end if;
  end;
end $$;
create function pg_temp.expect_rows(label text, stmt text, expected bigint) returns void language plpgsql as $$
declare n bigint;
begin
  execute stmt;
  get diagnostics n = row_count;
  if n = expected then raise notice 'PASS %', label;
  else raise notice 'FAIL %: % rows, expected %', label, n, expected; end if;
end $$;
create function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema pg_temp to authenticated;

select pg_temp.check('the fixture has a teacher with a class, and a second class they do not teach',
  current_setting('t.teacher', true) <> '' and current_setting('t.cls2', true) <> '' and current_setting('t.sub2', true) <> ''
  and current_setting('t.inv', true) <> '');

-- ---------------------------------------------------------------- the teacher: what is still allowed
select pg_temp.act_as(current_setting('t.teacher'));
set local role authenticated;

select pg_temp.expect_rows('a teacher can still read the payment proofs',
  format($q$select 1 from payment_proofs where id = %L$q$, current_setting('t.proof')), 1);
select pg_temp.expect_rows('a teacher can still read learner documents',
  format($q$select 1 from student_documents where id = %L$q$, current_setting('t.doc')), 1);
select pg_temp.expect_rows('a teacher can upload the file of a paper in a class and subject they teach',
  format($q$insert into storage.objects (bucket_id, name) values ('private-documents', %L)$q$,
         current_setting('t.a') || '/exam-papers/' || current_setting('t.paper1') || '/paper.pdf'), 1);
select pg_temp.expect_rows('... and replace it',
  format($q$update storage.objects set name = name where bucket_id = 'private-documents' and name = %L$q$,
         current_setting('t.a') || '/exam-papers/' || current_setting('t.paper1') || '/paper.pdf'), 1);

-- ---------------------------------------------------------------- the teacher: what is now refused
select pg_temp.expect_rows('a teacher cannot confirm a payment proof (no policy matches the update)',
  format($q$update payment_proofs set status = 'confirmed' where id = %L$q$, current_setting('t.proof')), 0);
select pg_temp.expect_rows('a teacher cannot reject one either',
  format($q$update payment_proofs set status = 'rejected' where id = %L$q$, current_setting('t.proof')), 0);
select pg_temp.expect_rows('a teacher cannot delete a payment proof',
  format($q$delete from payment_proofs where id = %L$q$, current_setting('t.proof')), 0);
select pg_temp.expect_error('a teacher cannot file a payment proof',
  format($q$insert into payment_proofs (tenant_id, invoice_id, uploaded_by, file_path, file_name, status)
            values (%L, %L, %L, 'p/x.png', 'x.png', 'confirmed')$q$,
         current_setting('t.a'), current_setting('t.inv'), current_setting('t.teacher')), '42501');

select pg_temp.expect_error('a teacher cannot add a learner document',
  format($q$insert into student_documents (tenant_id, student_id, uploaded_by, doc_type, file_path, file_name)
            values (%L, %L, %L, 'medical', 'p/y.pdf', 'y.pdf')$q$,
         current_setting('t.a'), current_setting('t.stu'), current_setting('t.teacher')), '42501');
select pg_temp.expect_rows('a teacher cannot change a learner document record',
  format($q$update student_documents set file_name = 'gone.pdf' where id = %L$q$, current_setting('t.doc')), 0);
select pg_temp.expect_rows('a teacher cannot delete a learner document record',
  format($q$delete from student_documents where id = %L$q$, current_setting('t.doc')), 0);

select pg_temp.expect_rows('a teacher cannot overwrite a learner document file',
  format($q$update storage.objects set name = name where bucket_id = 'private-documents' and name = %L$q$,
         current_setting('t.a') || '/students/' || current_setting('t.stu') || '/check.pdf'), 0);
select pg_temp.expect_rows('a teacher cannot overwrite a payment slip file',
  format($q$update storage.objects set name = name where bucket_id = 'private-documents' and name = %L$q$,
         current_setting('t.a') || '/invoices/' || current_setting('t.inv') || '/check.png'), 0);
select pg_temp.expect_error('a teacher cannot put a file in a learner''s folder',
  format($q$insert into storage.objects (bucket_id, name) values ('private-documents', %L)$q$,
         current_setting('t.a') || '/students/' || current_setting('t.stu') || '/forged.pdf'), '42501');
select pg_temp.expect_error('a teacher cannot put a file in an invoice''s folder',
  format($q$insert into storage.objects (bucket_id, name) values ('private-documents', %L)$q$,
         current_setting('t.a') || '/invoices/' || current_setting('t.inv') || '/forged.png'), '42501');
select pg_temp.expect_error('a teacher cannot upload the file of a paper in a class they do not teach',
  format($q$insert into storage.objects (bucket_id, name) values ('private-documents', %L)$q$,
         current_setting('t.a') || '/exam-papers/' || current_setting('t.paper2') || '/paper.pdf'), '42501');
select pg_temp.expect_error('a teacher cannot write into another school''s folder',
  format($q$insert into storage.objects (bucket_id, name) values ('private-documents', %L)$q$,
         gen_random_uuid()::text || '/exam-papers/' || current_setting('t.paper1') || '/paper.pdf'), '42501');

reset role;

-- ---------------------------------------------------------------- the office still can
select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
-- confirming goes through record_payment() (20261103300001); rejecting is a direct update
select pg_temp.expect_rows('the school admin rejects a payment proof',
  format($q$update payment_proofs set status = 'rejected', rejection_reason = 'check' where id = %L$q$, current_setting('t.proof')), 1);
select pg_temp.expect_rows('the school admin changes a learner document record',
  format($q$update student_documents set doc_type = 'medical form' where id = %L$q$, current_setting('t.doc')), 1);
select pg_temp.expect_rows('the school admin uploads a learner document file',
  format($q$insert into storage.objects (bucket_id, name) values ('private-documents', %L)$q$,
         current_setting('t.a') || '/students/' || current_setting('t.stu') || '/second.pdf'), 1);
-- a payment slip is kept as sent (20261103300001)
select pg_temp.expect_rows('not even the school admin overwrites a payment slip file',
  format($q$update storage.objects set name = name where bucket_id = 'private-documents' and name = %L$q$,
         current_setting('t.a') || '/invoices/' || current_setting('t.inv') || '/check.png'), 0);
reset role;

rollback;
