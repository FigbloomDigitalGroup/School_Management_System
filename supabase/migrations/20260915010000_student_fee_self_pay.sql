-- FIG-329: a student with no guardian (the common case for an adult
-- higher-ed learner) needs to see and pay their own fees. Guardian access to
-- fees is untouched — this only adds a second, independent OR-branch mirroring
-- the guardian one but keyed off the student's own profile_id, the same
-- pattern my_students() already uses for attendance/marks/announcements.
--
-- mpesa-stk-push (supabase/functions/mpesa-stk-push/index.ts) needs no code
-- change: it authorizes purely by trusting RLS on the caller's own session
-- ("RLS on the user client proves this guardian may pay this invoice"), so a
-- self-paying student is authorized the same way once these policies exist.

drop policy invoice_read on fee_invoices;
create policy invoice_read on fee_invoices for select
  using (
    is_super()
    or (tenant_id = my_tenant() and is_staff())
    or exists (select 1 from guardians g where g.student_id = fee_invoices.student_id and g.profile_id = auth.uid())
    or exists (select 1 from students s where s.id = fee_invoices.student_id and s.profile_id = auth.uid())
  );

drop policy payment_read on payments;
create policy payment_read on payments for select
  using (
    is_super()
    or (tenant_id = my_tenant() and is_staff())
    or exists (
      select 1 from fee_invoices i join guardians g on g.student_id = i.student_id
      where i.id = payments.invoice_id and g.profile_id = auth.uid())
    or exists (
      select 1 from fee_invoices i join students s on s.id = i.student_id
      where i.id = payments.invoice_id and s.profile_id = auth.uid())
  );

drop policy payment_insert on payments;
create policy payment_insert on payments for insert
  with check (
    tenant_id = my_tenant() and status = 'pending' and (
      exists (select 1 from fee_invoices i join guardians g on g.student_id = i.student_id
              where i.id = invoice_id and g.profile_id = auth.uid())
      or exists (select 1 from fee_invoices i join students s on s.id = i.student_id
                 where i.id = invoice_id and s.profile_id = auth.uid())
    )
  );

-- Same gap on payment proof uploads (bank slip / cash-at-office evidence) —
-- payment_proofs_read already has a staff/guardian branch, this adds the
-- student-self one; the guardian insert policy stays untouched, a parallel
-- student policy is added alongside it.
drop policy payment_proofs_read on payment_proofs;
create policy payment_proofs_read on payment_proofs for select
  using (
    is_super()
    or (tenant_id = my_tenant() and is_staff())
    or exists (select 1 from fee_invoices i join guardians g on g.student_id = i.student_id
               where i.id = payment_proofs.invoice_id and g.profile_id = auth.uid())
    or exists (select 1 from fee_invoices i join students s on s.id = i.student_id
               where i.id = payment_proofs.invoice_id and s.profile_id = auth.uid())
  );

create policy payment_proofs_insert_student on payment_proofs for insert
  with check (
    tenant_id = my_tenant()
    and status = 'pending'
    and exists (select 1 from fee_invoices i join students s on s.id = i.student_id
                where i.id = invoice_id and s.profile_id = auth.uid())
  );

-- Storage: a student may upload (never overwrite/delete) proof against their
-- own invoice, mirroring private_docs_guardian_proof_write.
create policy private_docs_student_proof_write on storage.objects for insert
  with check (
    bucket_id = 'private-documents'
    and (storage.foldername(name))[1] = my_tenant()::text
    and (storage.foldername(name))[2] = 'invoices'
    and exists (
      select 1 from fee_invoices i join students s on s.id = i.student_id
      where i.id::text = (storage.foldername(name))[3] and s.profile_id = auth.uid()
    )
  );
