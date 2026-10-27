-- Signed payment receipts.
--
-- The e-signature model (20261027050000) signs four kinds of document, keyed
-- by (doc_kind, doc_id). This adds a fifth, payment_receipt: a successful
-- payments row, signed by the bursar (the office) the way an invoice is,
-- one at a time or every receipt of a term at once. Families see the
-- signature and its date beside each receipt on their Fees screen.
--
-- Only a payment that went through is a receipt: pending, failed and
-- cancelled M-Pesa prompts can't be signed. What the signature vouches for
-- (document_fingerprint) is the payment as recorded: invoice, amount, how it
-- was paid, its reference and when it completed. None of those change after
-- a payment succeeds, so a receipt signature stays current.
--
-- The doc_kind checks are recreated with the full list (the four kinds
-- already allowed plus this one), and the four functions that know each kind
-- are restated whole with a payment_receipt branch added; nothing else in
-- them changes. The bursar capacity already exists.

alter table signature_requests drop constraint signature_requests_doc_kind_check;
alter table signature_requests add constraint signature_requests_doc_kind_check
  check (doc_kind in ('student_document', 'attachment', 'report_card', 'fee_invoice', 'payment_receipt'));
alter table signatures drop constraint signatures_doc_kind_check;
alter table signatures add constraint signatures_doc_kind_check
  check (doc_kind in ('student_document', 'attachment', 'report_card', 'fee_invoice', 'payment_receipt'));

-- Which school a document belongs to, or null when it doesn't exist.
create or replace function signed_document_tenant(p_kind text, p_id uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select case p_kind
    when 'student_document' then (select tenant_id from student_documents where id = p_id)
    when 'attachment' then (select tenant_id from attachments where id = p_id and announcement_id is not null)
    when 'report_card' then (select tenant_id from report_cards where id = p_id)
    when 'fee_invoice' then (select tenant_id from fee_invoices where id = p_id)
    when 'payment_receipt' then (select tenant_id from payments where id = p_id and status = 'success')
  end
$$;

-- The same people who can read the document itself. A receipt: the office,
-- and the learner's own family (or the learner), as for the invoice it paid.
create or replace function may_read_signed_document(p_kind text, p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case p_kind
    when 'student_document' then exists (
      select 1 from student_documents d where d.id = p_id
        and (may_administer(d.tenant_id) or (d.tenant_id = my_tenant() and (is_staff() or d.student_id in (select my_students())))))
    when 'attachment' then exists (
      select 1 from attachments a where a.id = p_id and a.announcement_id is not null and may_read_announcement(a.announcement_id))
    when 'report_card' then exists (
      select 1 from report_cards r where r.id = p_id
        and (may_administer(r.tenant_id) or (r.tenant_id = my_tenant() and is_staff())
             or (r.published_at is not null and r.student_id in (select my_students()))))
    when 'fee_invoice' then exists (
      select 1 from fee_invoices i where i.id = p_id
        and (may_administer(i.tenant_id) or (i.tenant_id = my_tenant() and i.student_id in (select my_students()))))
    when 'payment_receipt' then exists (
      select 1 from payments p join fee_invoices i on i.id = p.invoice_id
       where p.id = p_id and p.status = 'success'
         and (may_administer(i.tenant_id) or (i.tenant_id = my_tenant() and i.student_id in (select my_students()))))
    else false
  end
$$;

-- What a signature on a row-backed document vouches for; null for files.
-- A report card's comments are part of it; an invoice's payments are not
-- (paying doesn't change what the bursar signed). A receipt is the payment
-- as recorded.
create or replace function document_fingerprint(p_kind text, p_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select case p_kind
    when 'report_card' then (
      select encode(sha256(convert_to(jsonb_build_object(
               'data', r.data, 'teacher_comment', r.teacher_comment, 'principal_comment', r.principal_comment)::text, 'UTF8')), 'hex')
        from report_cards r where r.id = p_id)
    when 'fee_invoice' then (
      select encode(sha256(convert_to(jsonb_build_object(
               'id', i.id, 'student_id', i.student_id, 'term_id', i.term_id, 'total_cents', i.total_cents, 'due_on', i.due_on)::text, 'UTF8')), 'hex')
        from fee_invoices i where i.id = p_id)
    when 'payment_receipt' then (
      select encode(sha256(convert_to(jsonb_build_object(
               'id', p.id, 'invoice_id', p.invoice_id, 'amount_cents', p.amount_cents, 'method', p.method,
               'mpesa_receipt', p.mpesa_receipt, 'reference', p.reference, 'completed_at', p.completed_at)::text, 'UTF8')), 'hex')
        from payments p where p.id = p_id and p.status = 'success')
  end
$$;
revoke execute on function document_fingerprint(text, uuid) from public, anon, authenticated;

-- Whether the caller may sign this document in this capacity without being
-- asked: the office as principal or bursar, a class teacher for their own
-- class's cards, staff on a learner's records.
create or replace function may_sign_unasked(p_kind text, p_id uuid, p_capacity text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when p_kind = 'report_card' and p_capacity = 'principal' then exists (
      select 1 from report_cards r where r.id = p_id and may_administer(r.tenant_id))
    when p_kind = 'report_card' and p_capacity = 'class_teacher' then exists (
      select 1 from report_cards r join classes c on c.id = r.class_id
       where r.id = p_id and r.tenant_id = my_tenant() and c.class_teacher_id = auth.uid())
    when p_kind = 'fee_invoice' and p_capacity = 'bursar' then exists (
      select 1 from fee_invoices i where i.id = p_id and may_administer(i.tenant_id))
    when p_kind = 'payment_receipt' and p_capacity = 'bursar' then exists (
      select 1 from payments p where p.id = p_id and p.status = 'success' and may_administer(p.tenant_id))
    when p_kind = 'student_document' and p_capacity = 'staff' then exists (
      select 1 from student_documents d where d.id = p_id and (may_administer(d.tenant_id) or (d.tenant_id = my_tenant() and is_staff())))
    else false
  end
$$;
