-- What the sick bay (20261101300000) changes in existing objects: where a
-- guardian's prescription photo is kept and who reads it, and a Medical
-- category for the medicine stock.
--
-- A. Prescription photos go to private-documents at
--    <tenant>/medical/<student>/<file>, through the existing upload code
--    (apps/web/src/lib/uploads.ts).
--
--    * private_doc_area() (20261031000000) maps the 'medical' folder to the
--      medical area, so private_docs_office_write and the has_perm branch of
--      private_docs_read (20261031000001) open it to the area's holders and
--      full admins, as they do every other folder for its area. Recreated
--      from its only definition with that one line added.
--    * private_docs_read (as last altered in 20261031000001) lets any
--      teacher or school admin of the school read any file in the bucket
--      (its is_staff() branch). That branch now skips the 'medical' folder:
--      a teacher without the medical area must not open a prescription.
--      Everything else in the policy is as it was.
--    * Two new policies let a guardian upload, and read back, files in their
--      own child's medical folder only (guardians directly, not
--      my_students(), which answers every learner to a teacher).
--
-- B. inventory_items.category gains 'medical' (Medical supplies), so the
--    storekeeper keeps a stock line of paracetamol like any other, and a
--    medicine given in the sick bay can come off it (visit_medications,
--    20261101300000). The check is replaced with the same list plus
--    'medical'.

-- ================================================================ A. prescription photos

create or replace function private_doc_area(p_folder text) returns text
language sql immutable as $$
  select case p_folder
    when 'students' then 'people'
    when 'invoices' then 'fees'
    when 'submissions' then 'academics'
    when 'exam-papers' then 'academics'
    when 'paper-imports' then 'academics'
    when 'medical' then 'medical'
  end
$$;

-- as in 20261031000001, with the is_staff() branch kept out of the medical folder
alter policy private_docs_read on storage.objects
  using ((bucket_id = 'private-documents'::text) AND (is_super()
    OR has_perm(((storage.foldername(name))[1])::uuid, private_doc_area((storage.foldername(name))[2]))
    OR (((storage.foldername(name))[1] = (my_tenant())::text) AND ((is_staff() AND ((storage.foldername(name))[2] IS DISTINCT FROM 'medical'::text))
      OR (((storage.foldername(name))[2] = 'students'::text) AND ((storage.foldername(name))[3] IN ( SELECT (id.id)::text AS id
           FROM my_students() id(id))))
      OR (((storage.foldername(name))[2] = 'submissions'::text) AND ((storage.foldername(name))[4] IN ( SELECT (id.id)::text AS id
           FROM my_students() id(id))))
      OR (((storage.foldername(name))[2] = 'invoices'::text) AND (EXISTS ( SELECT 1
           FROM fee_invoices i
          WHERE (((i.id)::text = (storage.foldername(objects.name))[3]) AND (i.student_id IN ( SELECT my_students() AS my_students))))))))));

drop policy if exists private_docs_medical_guardian_write on storage.objects;
create policy private_docs_medical_guardian_write on storage.objects for insert
  with check ((bucket_id = 'private-documents'::text)
              AND ((storage.foldername(name))[1] = (my_tenant())::text)
              AND ((storage.foldername(name))[2] = 'medical'::text)
              AND (EXISTS ( SELECT 1 FROM guardians g
                            WHERE ((g.student_id)::text = (storage.foldername(objects.name))[3]) AND (g.profile_id = auth.uid()))));

drop policy if exists private_docs_medical_guardian_read on storage.objects;
create policy private_docs_medical_guardian_read on storage.objects for select
  using ((bucket_id = 'private-documents'::text)
         AND ((storage.foldername(name))[1] = (my_tenant())::text)
         AND ((storage.foldername(name))[2] = 'medical'::text)
         AND (EXISTS ( SELECT 1 FROM guardians g
                       WHERE ((g.student_id)::text = (storage.foldername(objects.name))[3]) AND (g.profile_id = auth.uid()))));

-- ================================================================ B. medical stock

alter table inventory_items drop constraint if exists inventory_items_category_check;
alter table inventory_items add constraint inventory_items_category_check check (category in (
  'textbooks', 'furniture', 'lab_equipment', 'sports', 'ict', 'uniforms',
  'music', 'kitchen', 'stationery', 'tools', 'medical', 'other'));
