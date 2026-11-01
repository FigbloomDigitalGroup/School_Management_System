-- FIG-1319 follow-up: the rules the team set for fee records.
--
--   1. Only a full admin deletes an invoice, even an empty one. invoice_write
--      was `for all` on has_perm(tenant_id, 'fees'), so a staff member given
--      the fees area could delete too. They keep creating (the billing run)
--      and editing; deleting needs may_administer().
--   2. No one deletes a proof of payment: not the row, not the file. The
--      office reviews a proof (pending -> confirmed or rejected) and nothing
--      else about it changes. Confirming only happens inside record_payment(),
--      so a proof can't be marked confirmed without the payment it shows.
--   3. Every change to an invoice or a proof is in the audit log, written by
--      the database so a client can't leave it out.
--
-- What was already audited stays as it was: record_payment() (the payment,
-- and the proof it confirms), the M-Pesa callback, fee charges, and invoice
-- deletion (20261103300000). The billing run's own summary event
-- (log_admin_event from the console) also stays; the insert trigger below is
-- the record a client can't skip.
--
-- A whole school being removed still takes its proofs with it: the tenant row
-- is gone by the time the cascade arrives, as in guard_invoice_delete().
--
-- supabase/rls-checks/fees.sql checks it.

-- ------------------------------------------------------------ 1. who deletes an invoice
drop policy invoice_write on fee_invoices;
create policy invoice_insert on fee_invoices for insert to authenticated
  with check (has_perm(tenant_id, 'fees'));
create policy invoice_update on fee_invoices for update to authenticated
  using (has_perm(tenant_id, 'fees')) with check (has_perm(tenant_id, 'fees'));
create policy invoice_delete on fee_invoices for delete to authenticated
  using (may_administer(tenant_id));

-- ------------------------------------------------------------ 2. proofs are kept
drop policy payment_proofs_office_manage on payment_proofs;
create policy payment_proofs_office_insert on payment_proofs for insert to authenticated
  with check (may_administer(tenant_id));
create policy payment_proofs_office_review on payment_proofs for update to authenticated
  using (may_administer(tenant_id)) with check (may_administer(tenant_id));

create or replace function guard_payment_proof_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    -- the whole school is being removed
    if not exists (select 1 from tenants where id = old.tenant_id) then return old; end if;
    raise exception 'A proof of payment is kept for good. Reject it instead.' using errcode = '42501';
  end if;

  if (to_jsonb(new) - array['status', 'reviewed_by', 'reviewed_at', 'rejection_reason'])
     is distinct from (to_jsonb(old) - array['status', 'reviewed_by', 'reviewed_at', 'rejection_reason']) then
    raise exception 'A proof of payment can''t be changed once it''s sent. Only its review can.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and old.status <> 'pending' then
    raise exception 'That proof of payment has already been reviewed.' using errcode = '22023';
  end if;
  return new;
end $$;

create trigger payment_proofs_guard_change before update or delete on payment_proofs
  for each row execute function guard_payment_proof_change();

-- Not security definer, so current_user is whoever made the change:
-- record_payment()'s owner when it confirms, authenticated for a client.
create or replace function guard_payment_proof_confirm() returns trigger
language plpgsql as $$
begin
  if new.status = 'confirmed' and old.status <> 'confirmed' and current_user = 'authenticated' then
    raise exception 'Confirm a proof of payment by recording the payment it shows.' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger payment_proofs_guard_confirm before update of status on payment_proofs
  for each row execute function guard_payment_proof_confirm();

-- the file: private-documents/{tenant}/invoices/{invoice}/..., written by the
-- family's insert policy or the office's (private_docs_office_write, `for all`)
create policy private_docs_proofs_kept on storage.objects as restrictive for delete to public
  using (not (bucket_id = 'private-documents' and (storage.foldername(name))[2] = 'invoices'));
create policy private_docs_proofs_not_replaced on storage.objects as restrictive for update to public
  using (not (bucket_id = 'private-documents' and (storage.foldername(name))[2] = 'invoices'));

-- ------------------------------------------------------------ 3. the audit trail
create or replace function audit_payment_proof() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  learner text;
begin
  select s.full_name into learner from fee_invoices i join students s on s.id = i.student_id where i.id = new.invoice_id;
  if tg_op = 'INSERT' then
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    values (new.tenant_id, auth.uid(), my_actor_label(),
            format('Proof of payment sent for %s%s', coalesce(learner, 'a learner'),
                   case when new.txn_code is not null then ', ref ' || new.txn_code else '' end),
            'financial',
            jsonb_build_object('invoice_id', new.invoice_id, 'proof_id', new.id, 'txn_code', new.txn_code,
                               'txn_amount_cents', new.txn_amount_cents, 'file_name', new.file_name));
  -- a confirmation is logged by record_payment() with the payment it came with
  elsif new.status = 'rejected' and old.status <> 'rejected' then
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    values (new.tenant_id, auth.uid(), my_actor_label(),
            format('Proof of payment rejected for %s%s', coalesce(learner, 'a learner'),
                   coalesce(': ' || new.rejection_reason, '')),
            'financial',
            jsonb_build_object('invoice_id', new.invoice_id, 'proof_id', new.id, 'reason', new.rejection_reason));
  end if;
  return new;
end $$;

create trigger payment_proofs_audit after insert or update of status on payment_proofs
  for each row execute function audit_payment_proof();

-- One event per statement: a billing run inserts hundreds of invoices at once.
create or replace function audit_invoices_created() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  select n.tenant_id, auth.uid(), my_actor_label(),
         format('%s fee invoice%s created for %s', count(*), case when count(*) = 1 then '' else 's' end,
                coalesce(t.name, 'a term')),
         'financial',
         jsonb_build_object('term_id', n.term_id, 'invoices', count(*), 'total_cents', sum(n.total_cents),
                            'invoice_ids', jsonb_agg(n.id))
    from new_rows n
    left join terms t on t.id = n.term_id
   group by n.tenant_id, n.term_id, t.name;
  return null;
end $$;

create trigger fee_invoices_audit_insert after insert on fee_invoices
  referencing new table as new_rows
  for each statement execute function audit_invoices_created();

-- An edit by hand. A payment (apply_payment) or a charge (apply_fee_charge)
-- moves an invoice one trigger level down and is logged where it's made.
create or replace function audit_invoice_edited() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  changed jsonb;
  learner text;
begin
  if pg_trigger_depth() > 1 then return new; end if;
  select jsonb_object_agg(o.key, jsonb_build_object('from', o.value, 'to', to_jsonb(new) -> o.key))
    into changed
    from jsonb_each(to_jsonb(old)) o
   where o.value is distinct from to_jsonb(new) -> o.key;
  if changed is null then return new; end if;

  select full_name into learner from students where id = new.student_id;
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (new.tenant_id, auth.uid(), my_actor_label(),
          format('Fee invoice for %s changed: %s', coalesce(learner, 'a learner'),
                 (select string_agg(replace(k, '_', ' '), ', ' order by k) from jsonb_object_keys(changed) k)),
          'financial',
          jsonb_build_object('invoice_id', new.id, 'changes', changed));
  return new;
end $$;

create trigger fee_invoices_audit_update after update on fee_invoices
  for each row execute function audit_invoice_edited();
