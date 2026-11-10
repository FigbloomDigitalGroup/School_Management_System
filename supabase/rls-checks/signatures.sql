-- Who can read a signature (20261110110000, audit F-027): whoever may read the document it is on, the signer, and for
-- "who has signed", whoever asked. A teacher without the fees or people area must not read the bursar's signature on an
-- invoice or a family's signature on a learner's private document.
--
-- Runs against a local database that has the migrations applied and `npm run db:seed` data, inside one transaction that is
-- rolled back. Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/signatures.sql

\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------- fixtures (as postgres)
select set_config('t.a', (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.admin', (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.a')::uuid limit 1), true);
-- a teacher holding no admin area at all, so only the teacher role speaks for them
select set_config('t.teacher', (
  select p.id::text from profiles p
   where p.role = 'teacher' and p.tenant_id = current_setting('t.a')::uuid
     and not exists (select 1 from staff_permissions sp where sp.profile_id = p.id)
     and not exists (select 1 from staff_role_assignments ra where ra.profile_id = p.id)
   limit 1), true);
-- a parent, their child, and the child's invoice
select set_config('t.parent', (select g.profile_id::text from guardians g join fee_invoices i on i.student_id = g.student_id
                               where i.tenant_id = current_setting('t.a')::uuid order by g.profile_id limit 1), true);
select set_config('t.child', (select g.student_id::text from guardians g join fee_invoices i on i.student_id = g.student_id
                              where g.profile_id = current_setting('t.parent')::uuid and i.tenant_id = current_setting('t.a')::uuid limit 1), true);
select set_config('t.invoice', (select id::text from fee_invoices where student_id = current_setting('t.child')::uuid limit 1), true);

insert into student_documents (tenant_id, student_id, uploaded_by, doc_type, file_path, file_name)
  values (current_setting('t.a')::uuid, current_setting('t.child')::uuid, current_setting('t.admin')::uuid,
          'birth_certificate', current_setting('t.a') || '/students/' || current_setting('t.child') || '/bc.pdf', 'bc.pdf');
select set_config('t.doc', (select id::text from student_documents where file_name = 'bc.pdf' and student_id = current_setting('t.child')::uuid), true);
select set_config('t.attachment', gen_random_uuid()::text, true);

-- the bursar (the admin) signed the invoice; the parent was asked by the office to sign the document, and signed it
insert into signatures (tenant_id, doc_kind, doc_id, signer_id, capacity, full_name, style, doc_hash)
  values (current_setting('t.a')::uuid, 'fee_invoice', current_setting('t.invoice')::uuid, current_setting('t.admin')::uuid, 'bursar',
          'The Bursar', 'typed', repeat('a', 64));
insert into signature_requests (tenant_id, doc_kind, doc_id, signer_id, capacity, requested_by)
  values (current_setting('t.a')::uuid, 'student_document', current_setting('t.doc')::uuid, current_setting('t.parent')::uuid, 'guardian',
          current_setting('t.admin')::uuid);
insert into signatures (tenant_id, doc_kind, doc_id, signer_id, capacity, full_name, style, strokes, doc_hash)
  values (current_setting('t.a')::uuid, 'student_document', current_setting('t.doc')::uuid, current_setting('t.parent')::uuid, 'guardian',
          'A Parent', 'drawn', '[[1,2,3,4]]', repeat('b', 64));
-- the teacher's permission slip went to the parent
insert into signature_requests (tenant_id, doc_kind, doc_id, signer_id, capacity, requested_by)
  values (current_setting('t.a')::uuid, 'attachment', current_setting('t.attachment')::uuid, current_setting('t.parent')::uuid, 'recipient',
          current_setting('t.teacher')::uuid);

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when ok then 'PASS' else 'FAIL' end, label; end $$;
-- How many rows a query gives this user.
create function pg_temp.seen(uid text, stmt text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute 'select count(*) from (' || stmt || ') q' into n;
  reset role;
  return n;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

select pg_temp.check('the fixture has a teacher with no admin area, a parent, a child, an invoice and a document',
  current_setting('t.teacher', true) <> '' and current_setting('t.parent', true) <> '' and current_setting('t.invoice', true) <> ''
  and current_setting('t.doc', true) <> '');

-- ---------------------------------------------------------------- a teacher with no fees or people area
select pg_temp.check('a teacher cannot read the signatures on an invoice or a learner''s document from the table',
  pg_temp.seen(current_setting('t.teacher'), format($q$select 1 from signatures where doc_id in (%L, %L)$q$, current_setting('t.invoice'), current_setting('t.doc'))) = 0);
select pg_temp.check('a teacher cannot read who was asked to sign a learner''s document',
  pg_temp.seen(current_setting('t.teacher'), format($q$select 1 from signature_requests where doc_id = %L$q$, current_setting('t.doc'))) = 0);
select pg_temp.check('a teacher gets no signatures on an invoice through document_signatures()',
  pg_temp.seen(current_setting('t.teacher'), format($q$select * from document_signatures('fee_invoice', array[%L]::uuid[])$q$, current_setting('t.invoice'))) = 0);
select pg_temp.check('a teacher gets no signatures on a learner''s document through document_signatures()',
  pg_temp.seen(current_setting('t.teacher'), format($q$select * from document_signatures('student_document', array[%L]::uuid[])$q$, current_setting('t.doc'))) = 0);
select pg_temp.check('a teacher cannot see who has signed a learner''s document',
  pg_temp.seen(current_setting('t.teacher'), format($q$select * from signature_status('student_document', array[%L]::uuid[])$q$, current_setting('t.doc'))) = 0);
select pg_temp.check('a teacher still sees who has signed their own permission slip',
  pg_temp.seen(current_setting('t.teacher'), format($q$select * from signature_status('attachment', array[%L]::uuid[])$q$, current_setting('t.attachment'))) = 1);
select pg_temp.check('...and the requests they sent',
  pg_temp.seen(current_setting('t.teacher'), format($q$select 1 from signature_requests where doc_id = %L$q$, current_setting('t.attachment'))) = 1);

-- ---------------------------------------------------------------- the office (control)
select pg_temp.check('the school admin reads both signatures',
  pg_temp.seen(current_setting('t.admin'), format($q$select 1 from signatures where doc_id in (%L, %L)$q$, current_setting('t.invoice'), current_setting('t.doc'))) = 2);
select pg_temp.check('the school admin sees who has signed the learner''s document',
  pg_temp.seen(current_setting('t.admin'), format($q$select * from signature_status('student_document', array[%L]::uuid[])$q$, current_setting('t.doc'))) = 1);

-- ---------------------------------------------------------------- the family (control)
select pg_temp.check('the parent sees the bursar''s signature on their child''s invoice',
  pg_temp.seen(current_setting('t.parent'), format($q$select * from document_signatures('fee_invoice', array[%L]::uuid[])$q$, current_setting('t.invoice'))) = 1);
select pg_temp.check('the parent sees the signature on their child''s document',
  pg_temp.seen(current_setting('t.parent'), format($q$select * from document_signatures('student_document', array[%L]::uuid[])$q$, current_setting('t.doc'))) = 1);
select pg_temp.check('the parent reads their own signature from the table, and not the bursar''s',
  pg_temp.seen(current_setting('t.parent'), format($q$select 1 from signatures where doc_id in (%L, %L)$q$, current_setting('t.invoice'), current_setting('t.doc'))) = 1);

rollback;
