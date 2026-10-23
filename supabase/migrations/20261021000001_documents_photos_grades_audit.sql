-- Four read/write gaps from the 2026-10-21 production-readiness audit.
--
-- 1. Private documents were readable by everyone in the school.
--    private_docs_read (20260918000000) let anyone whose tenant matched the
--    first folder read any file in private-documents -- every learner's
--    records, every family's payment proof, every hand-in -- and
--    student_documents_read did the same for the rows describing them. Staff
--    keep full access; a family now only reaches its own children's files.
--    Paths (apps/web/src/lib/uploads.ts):
--      <tenant>/students/<student_id>/<file>                  learner records
--      <tenant>/submissions/<assignment_id>/<student_id>/<file> hand-ins
--      <tenant>/invoices/<invoice_id>/<file>                  payment proof
--    Segments are compared as text, so a stray non-uuid folder can never make
--    the policy itself throw.
--
-- 2. Anyone, signed in or not, could list the public-assets bucket -- every
--    school's crest and every learner's photo, with the tenant and student
--    ids in the paths. The bucket stays public (avatars and crests are shown
--    by URL, which doesn't go through RLS), but listing it now needs to be
--    someone from that school.
--
-- 3. Higher-ed students could write their own grades. course_assessments,
--    course_marks and course_grades still had the WITH CHECK
--    `... or tenant_id = my_tenant()` that 20260924010000 removed from K-12
--    marks and attendance: an INSERT is checked against WITH CHECK only, so
--    any member of the school could insert rows. WITH CHECK now repeats USING.
--
-- 4. Anyone could write to the audit log (`with check (true)`, even anon).
--    Every real writer is an edge function or seed using the service role,
--    which bypasses RLS, so the policy is simply dropped.

-- 1 ------------------------------------------------------------ private documents
drop policy private_docs_read on storage.objects;
create policy private_docs_read on storage.objects for select
  using (
    bucket_id = 'private-documents' and (
      is_super()
      or may_administer((storage.foldername(name))[1]::uuid)
      or ((storage.foldername(name))[1] = my_tenant()::text and (
        is_staff()
        or ((storage.foldername(name))[2] = 'students'
            and (storage.foldername(name))[3] in (select id::text from my_students() as id))
        or ((storage.foldername(name))[2] = 'submissions'
            and (storage.foldername(name))[4] in (select id::text from my_students() as id))
        or ((storage.foldername(name))[2] = 'invoices'
            and exists (select 1 from fee_invoices i
                        where i.id::text = (storage.foldername(name))[3]
                          and i.student_id in (select my_students())))
      ))
    )
  );

drop policy student_documents_read on student_documents;
create policy student_documents_read on student_documents for select
  using (
    is_super() or may_administer(tenant_id)
    or (tenant_id = my_tenant() and (is_staff() or student_id in (select my_students())))
  );

-- 2 ------------------------------------------------------------ public assets listing
drop policy public_assets_read on storage.objects;
create policy public_assets_read on storage.objects for select
  using (
    bucket_id = 'public-assets'
    and (is_super() or (storage.foldername(name))[1] = my_tenant()::text)
  );

-- 3 ------------------------------------------------------------ higher-ed grade writes
drop policy course_assessment_write on course_assessments;
create policy course_assessment_write on course_assessments for all
  using (
    is_super() or may_administer(tenant_id)
    or ((tenant_id = my_tenant()) and (my_role() = 'school_admin'))
    or ((tenant_id = my_tenant()) and (my_role() = 'teacher') and teaches_section(course_section_id))
  )
  with check (
    is_super() or may_administer(tenant_id)
    or ((tenant_id = my_tenant()) and (my_role() = 'school_admin'))
    or ((tenant_id = my_tenant()) and (my_role() = 'teacher') and teaches_section(course_section_id))
  );

drop policy course_mark_write on course_marks;
create policy course_mark_write on course_marks for all
  using (
    is_super() or may_administer(tenant_id)
    or ((tenant_id = my_tenant()) and (my_role() = 'school_admin'))
    or ((tenant_id = my_tenant()) and (my_role() = 'teacher')
        and exists (select 1 from course_assessments a where a.id = course_marks.assessment_id and teaches_section(a.course_section_id)))
  )
  with check (
    is_super() or may_administer(tenant_id)
    or ((tenant_id = my_tenant()) and (my_role() = 'school_admin'))
    or ((tenant_id = my_tenant()) and (my_role() = 'teacher')
        and exists (select 1 from course_assessments a where a.id = course_marks.assessment_id and teaches_section(a.course_section_id)))
  );

drop policy course_grade_write on course_grades;
create policy course_grade_write on course_grades for all
  using (
    is_super() or may_administer(tenant_id)
    or ((tenant_id = my_tenant()) and (my_role() = 'school_admin'))
    or ((tenant_id = my_tenant()) and (my_role() = 'teacher') and teaches_section(course_section_id))
  )
  with check (
    is_super() or may_administer(tenant_id)
    or ((tenant_id = my_tenant()) and (my_role() = 'school_admin'))
    or ((tenant_id = my_tenant()) and (my_role() = 'teacher') and teaches_section(course_section_id))
  );

-- 4 ------------------------------------------------------------ audit log
drop policy audit_insert on audit_events;
