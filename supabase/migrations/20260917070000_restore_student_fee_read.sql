-- Fix (found live: a student's own Fees page showed "no balance" while the
-- same learner's parent correctly saw one owing) -- 20260916110000
-- (org_admin_full_school_access) dropped and recreated invoice_read and
-- payment_read from their PRE-FIG-329 shape while widening them for
-- org_admin via may_administer(), silently reverting the student-self
-- branch 20260915010000 (student_fee_self_pay) had added. Its own header
-- claimed to be purely additive ("nothing a school_admin, teacher, parent,
-- or student could already do changes") but missed these two.
--
-- payment_proofs_read/payment_proofs_insert_student/payment_insert were
-- never touched by that migration, so their student branches are intact --
-- only these two needed restoring.

drop policy invoice_read on fee_invoices;
create policy invoice_read on fee_invoices for select
  using (
    is_super()
    or (tenant_id = my_tenant() and is_staff())
    or may_administer(tenant_id)
    or exists (select 1 from guardians g where g.student_id = fee_invoices.student_id and g.profile_id = auth.uid())
    or exists (select 1 from students s where s.id = fee_invoices.student_id and s.profile_id = auth.uid())
  );

drop policy payment_read on payments;
create policy payment_read on payments for select
  using (
    is_super()
    or (tenant_id = my_tenant() and is_staff())
    or may_administer(tenant_id)
    or exists (
      select 1 from fee_invoices i join guardians g on g.student_id = i.student_id
      where i.id = payments.invoice_id and g.profile_id = auth.uid())
    or exists (
      select 1 from fee_invoices i join students s on s.id = i.student_id
      where i.id = payments.invoice_id and s.profile_id = auth.uid())
  );
