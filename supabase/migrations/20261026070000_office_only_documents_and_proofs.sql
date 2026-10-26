-- Teachers could overwrite or delete private documents and confirm payment proofs.
--
-- Three policies said "any member of staff in this school" (is_staff() is
-- school_admin or teacher) where they meant the office:
--
--   payment_proofs_staff_manage   ALL: a teacher could mark any parent's proof
--                                 'confirmed' or 'rejected'. record_payment()
--                                 already needs the office; this was the side door.
--   student_documents_write       ALL: a teacher could add, change or delete a
--                                 learner's birth certificate or medical form.
--   private_docs_staff_write      ALL on the private-documents bucket: a teacher
--                                 could overwrite or delete any file in the school's
--                                 folder, learner documents, payment slips and
--                                 other teachers' exam papers included.
--
-- Now the office (may_administer: school admin, org admin for their schools,
-- super admin) writes all three. A teacher keeps what they need: reading
-- (payment_proofs_read, student_documents_read, private_docs_read are
-- unchanged) and writing the file of an exam paper in a class and subject they
-- teach, which is the only thing the teacher screens upload to this bucket.

-- ------------------------------------------------------------ payment proofs
drop policy payment_proofs_staff_manage on payment_proofs;
create policy payment_proofs_office_manage on payment_proofs for all
  using (may_administer(tenant_id))
  with check (may_administer(tenant_id));

-- ------------------------------------------------------------ learner documents
drop policy student_documents_write on student_documents;
create policy student_documents_office_write on student_documents for all
  using (may_administer(tenant_id))
  with check (may_administer(tenant_id));

-- ------------------------------------------------------------ the private-documents bucket
-- May this person write the file of this exam paper? Only someone who may teach
-- the paper's class and subject (the same rule as exam_papers_write).
create or replace function exam_paper_file_writable_by_me(p_paper_id text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from exam_papers p
     where p.id::text = p_paper_id and may_teach_class_subject(p.tenant_id, p.class_id, p.subject_id)
  )
$$;

drop policy private_docs_staff_write on storage.objects;

create policy private_docs_office_write on storage.objects for all
  using (bucket_id = 'private-documents' and may_administer(((storage.foldername(name))[1])::uuid))
  with check (bucket_id = 'private-documents' and may_administer(((storage.foldername(name))[1])::uuid));

create policy private_docs_teacher_exam_papers_write on storage.objects for all
  using (
    bucket_id = 'private-documents'
    and (storage.foldername(name))[1] = my_tenant()::text
    and (storage.foldername(name))[2] = 'exam-papers'
    and exam_paper_file_writable_by_me((storage.foldername(name))[3])
  )
  with check (
    bucket_id = 'private-documents'
    and (storage.foldername(name))[1] = my_tenant()::text
    and (storage.foldername(name))[2] = 'exam-papers'
    and exam_paper_file_writable_by_me((storage.foldername(name))[3])
  );
