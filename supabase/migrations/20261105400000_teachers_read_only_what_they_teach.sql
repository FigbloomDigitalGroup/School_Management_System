-- FIG-1303: a teacher reads only what their own work needs.
--
-- Until now every teacher could READ, school-wide: every learner's fee invoices, payments and payment proofs, private documents,
-- health record and marks, because those read policies said is_staff() (school admin OR teacher) with no class or subject test, and
-- my_students() returned every learner of the school to any staff user. (Writes were already limited to the assigned class and
-- subject.) The school's rulings:
--
--   * fees (invoices, payments, payment proofs, their files): the school admin and staff holding the fees area, and the learner's own
--     family. Not teachers.
--   * private documents (birth certificates, transfer letters, ...): the school admin and staff holding the people area, and the
--     learner's own family. Not teachers.
--   * health: the school admin and staff holding the people or medical area (the nurse), and the learner's own family. A teacher
--     sees only a short safety flag, through teacher_health_flags(): allergies, conditions, medication, diet and support needs, and
--     only for learners of a class they teach or are the class teacher of. Not the blood group, notes, doctor or emergency contacts.
--   * marks: a teacher reads the marks of the classes and subjects they are assigned, and every subject of a class they are the class
--     teacher of (they write the report-card comments). The family still reads published marks of its own children.
--
-- my_family_students() is my_students() without the "any staff user sees every learner" branch: the learners the signed-in user is a
-- guardian of or is, and (for a group administrator) the learners of the group's schools. The private tables below use it. my_students()
-- itself is unchanged: the learner list and class rosters still show every learner of the school to a teacher.
--
-- Not covered here (the same reading in other tables, to decide separately): report_cards, cbe_results, course marks and the bio-data
-- columns of students are still readable by every teacher of the school.
--
-- supabase/rls-checks/roles_in_school.sql checks it.

-- ---------------------------------------------------------------- the family's own learners
create or replace function my_family_students() returns setof uuid
language sql stable security definer set search_path = public as $$
  select s.id from students s
  where (
    s.tenant_id = my_tenant()
    and (
      exists (select 1 from guardians g where g.student_id = s.id and g.profile_id = auth.uid())
      or s.profile_id = auth.uid()
    )
  )
  or (is_org_admin() and s.tenant_id in (select my_organization_tenant_ids()))
$$;

-- ---------------------------------------------------------------- fees
alter policy invoice_read on fee_invoices using (
  is_super()
  or has_perm(tenant_id, 'fees')
  or exists (select 1 from guardians g where g.student_id = fee_invoices.student_id and g.profile_id = auth.uid())
  or exists (select 1 from students s where s.id = fee_invoices.student_id and s.profile_id = auth.uid())
);

alter policy payment_read on payments using (
  is_super()
  or has_perm(tenant_id, 'fees')
  or exists (select 1 from fee_invoices i join guardians g on g.student_id = i.student_id
              where i.id = payments.invoice_id and g.profile_id = auth.uid())
  or exists (select 1 from fee_invoices i join students s on s.id = i.student_id
              where i.id = payments.invoice_id and s.profile_id = auth.uid())
);

alter policy payment_proofs_read on payment_proofs using (
  is_super()
  or has_perm(tenant_id, 'fees')
  or exists (select 1 from fee_invoices i join guardians g on g.student_id = i.student_id
              where i.id = payment_proofs.invoice_id and g.profile_id = auth.uid())
  or exists (select 1 from fee_invoices i join students s on s.id = i.student_id
              where i.id = payment_proofs.invoice_id and s.profile_id = auth.uid())
);

-- ---------------------------------------------------------------- private documents and health
alter policy student_documents_read on student_documents using (
  is_super()
  or has_perm(tenant_id, 'people')
  or (tenant_id = my_tenant() and student_id in (select my_family_students()))
);

alter policy student_health_read on student_health using (
  has_perm(tenant_id, 'people')
  or has_perm(tenant_id, 'medical')
  or student_id in (select my_family_students())
);

-- A teacher's register shows a small "Allergy" / "Medical" chip for each learner. This is all the teacher gets of the record, and only
-- for learners of a class they teach or are the class teacher of (the office and the medical area read the table itself).
create or replace function teacher_health_flags(p_student_ids uuid[])
returns table (student_id uuid, allergies text[], medical_conditions text[], medications text, dietary_needs text, special_needs text)
language sql stable security definer set search_path = public as $$
  select h.student_id, h.allergies, h.medical_conditions, h.medications, h.dietary_needs, h.special_needs
  from student_health h
  join students s on s.id = h.student_id
  where h.student_id = any(p_student_ids)
    and s.tenant_id = my_tenant()
    and (
      has_perm(s.tenant_id, 'people')
      or has_perm(s.tenant_id, 'medical')
      or (my_role() = 'teacher' and (
            exists (select 1 from teaching_assignments ta where ta.teacher_id = auth.uid() and ta.class_id = s.class_id)
         or exists (select 1 from classes c where c.id = s.class_id and c.class_teacher_id = auth.uid())
      ))
    )
$$;
revoke execute on function teacher_health_flags(uuid[]) from public, anon;
grant execute on function teacher_health_flags(uuid[]) to authenticated;

-- ---------------------------------------------------------------- marks
alter policy mark_read on marks using (
  is_super()
  or has_perm(tenant_id, 'academics')
  or (tenant_id = my_tenant() and my_role() = 'teacher' and (
        exists (select 1 from teaching_assignments ta join students s on s.id = marks.student_id
                 where ta.teacher_id = auth.uid() and ta.subject_id = marks.subject_id and ta.class_id = s.class_id)
     or exists (select 1 from students s join classes c on c.id = s.class_id
                 where s.id = marks.student_id and c.class_teacher_id = auth.uid())
  ))
  or (student_id in (select my_family_students())
      and exists (select 1 from students s where s.id = marks.student_id and marks_published(marks.exam_id, s.class_id, marks.subject_id)))
);

-- ---------------------------------------------------------------- the files behind documents and proofs
-- private-documents folders: students (documents, the people area), invoices (payment proofs, the fees area), medical, submissions
-- (homework hand-ins: a teacher reads those), exam-papers and paper-imports (their own policies). A teacher no longer reads every folder
-- but medical, and the family branches use my_family_students().
drop policy private_docs_read on storage.objects;
create policy private_docs_read on storage.objects for select using (
  bucket_id = 'private-documents'
  and (
    is_super()
    or has_perm(((storage.foldername(name))[1])::uuid, private_doc_area((storage.foldername(name))[2]))
    or (
      (storage.foldername(name))[1] = my_tenant()::text
      and (
        (is_staff() and (storage.foldername(name))[2] = 'submissions')
        or ((storage.foldername(name))[2] = 'students'
            and (storage.foldername(name))[3] in (select id.id::text from my_family_students() id(id)))
        or ((storage.foldername(name))[2] = 'submissions'
            and (storage.foldername(name))[4] in (select id.id::text from my_family_students() id(id)))
        or ((storage.foldername(name))[2] = 'invoices'
            and exists (select 1 from fee_invoices i
                         where i.id::text = (storage.foldername(objects.name))[3]
                           and i.student_id in (select my_family_students())))
      )
    )
  )
);
