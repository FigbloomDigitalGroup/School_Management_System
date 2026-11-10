-- Every teacher could read every signature in the school (audit F-027, the part FIG-1303 left).
--
-- 20261105400000 stopped teachers reading fees, private documents and health school-wide, but the signatures on those documents
-- still said is_staff() (school admin OR teacher): the signatures tables themselves, signature_status() ("who has signed"), and
-- may_read_signed_document(), whose family branches used my_students() -- which returns every learner of the school to any staff
-- user. A teacher could read the bursar's signature on any invoice or receipt, and every signature (drawn strokes included) on any
-- learner's private documents.
--
-- Now a signature is read by whoever may read the document it is on, under FIG-1303's rulings:
--
--   fee_invoice, payment_receipt   the fees area, and the learner's own family
--   student_document               the people area, and the learner's own family
--   attachment                     whoever the message reached (unchanged)
--   report_card                    unchanged: report cards themselves are still readable by every teacher (FIG-1303 left that to
--                                  decide separately), so their signatures follow the card
--
-- plus the signer (their own signatures and requests) and, for "who has signed", whoever asked (a teacher's permission slip).
-- The app reads signatures only through document_signatures(), signature_status() and my_signature_requests(); the table policies
-- below close the direct API path.

-- ---------------------------------------------------------------- the tables
alter policy signature_requests_read on signature_requests using (
  signer_id = auth.uid()
  or requested_by = auth.uid()
  or has_perm(tenant_id, signed_doc_area(doc_kind))
);

alter policy signatures_read on signatures using (
  signer_id = auth.uid()
  or has_perm(tenant_id, signed_doc_area(doc_kind))
);

-- ---------------------------------------------------------------- who may read a signed document's signatures
create or replace function may_read_signed_document(p_kind text, p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case p_kind
    when 'student_document' then exists (
      select 1 from student_documents d where d.id = p_id
        and (has_perm(d.tenant_id, 'people') or d.student_id in (select my_family_students())))
    when 'attachment' then exists (
      select 1 from attachments a where a.id = p_id and a.announcement_id is not null and may_read_announcement(a.announcement_id))
    when 'report_card' then exists (
      select 1 from report_cards r where r.id = p_id
        and (has_perm(r.tenant_id, 'academics') or (r.tenant_id = my_tenant() and is_staff())
             or (r.published_at is not null and r.student_id in (select my_family_students()))))
    when 'fee_invoice' then exists (
      select 1 from fee_invoices i where i.id = p_id
        and (has_perm(i.tenant_id, 'fees') or i.student_id in (select my_family_students())))
    when 'payment_receipt' then exists (
      select 1 from payments p join fee_invoices i on i.id = p.invoice_id
       where p.id = p_id and p.status = 'success'
         and (has_perm(i.tenant_id, 'fees') or i.student_id in (select my_family_students())))
    else false
  end
$$;

-- ---------------------------------------------------------------- "12 of 30 families have signed"
create or replace function signature_status(p_kind text, p_ids uuid[])
returns table(doc_id uuid, signer_id uuid, signer_name text, capacity text, requested_at timestamptz, signed_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.doc_id, r.signer_id, p.full_name, r.capacity, r.requested_at, x.signed_at
    from signature_requests r
    join profiles p on p.id = r.signer_id
    left join signatures x on x.doc_kind = r.doc_kind and x.doc_id = r.doc_id and x.signer_id = r.signer_id
                          and x.capacity = r.capacity and x.voided_at is null
   where r.doc_kind = p_kind
     and r.doc_id = any(p_ids)
     and (has_perm(r.tenant_id, signed_doc_area(r.doc_kind)) or r.requested_by = auth.uid())
   order by x.signed_at nulls first, p.full_name
$$;
