-- Fees that can actually be collected outside the M-Pesa prompt.
--
-- Until now the only thing that ever credited an invoice was a successful
-- STK push. Confirming a parent's uploaded bank slip just flipped the
-- proof's status, so the balance never moved; cash, cheques, bank deposits
-- and M-Pesa paid straight to the school's paybill had no way in at all.
-- And because invoice_write lets a school admin update any column, the only
-- way to make a balance "right" was to edit paid_cents by hand, with no
-- payment row and no audit trail.
--
-- record_payment() is the one way staff credit an invoice: it writes a real
-- payments row (status success, so apply_payment moves the invoice exactly as
-- it does for M-Pesa), optionally confirms the proof it came from, and logs an
-- audit event -- all in one transaction. A trigger now refuses any other
-- change to paid_cents/status, so a balance only ever moves with a payment
-- behind it.
--
-- log_admin_event() lets the console record an action in the audit log
-- (e.g. a billing run) now that audit_events has no client insert policy
-- (20261021000001). The actor comes from the caller's own profile, never
-- from the request.

alter table payments add column reference text;
alter table payments add column recorded_by uuid references profiles on delete set null;

-- ------------------------------------------------------------ paid_cents only moves with a payment
create or replace function guard_invoice_payment_fields() returns trigger
language plpgsql as $$
begin
  -- service role (edge functions, seeds), and apply_payment's own update,
  -- which runs one trigger level down from the payments row it applies
  if auth.uid() is null or pg_trigger_depth() > 1 then return new; end if;

  if tg_op = 'INSERT' then
    if new.paid_cents <> 0 or new.status <> 'unpaid' then
      raise exception 'A new invoice starts with nothing paid. Record payments against it instead.'
        using errcode = '42501';
    end if;
  elsif new.paid_cents is distinct from old.paid_cents or new.status is distinct from old.status then
    raise exception 'An invoice''s paid amount only changes when a payment is recorded.'
      using errcode = '42501';
  end if;
  return new;
end $$;

create trigger fee_invoices_guard_payment_fields before insert or update on fee_invoices
  for each row execute function guard_invoice_payment_fields();

-- ------------------------------------------------------------ helpers
create or replace function my_actor_label() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select full_name || ' · ' || replace(role::text, '_', ' ') from profiles where id = auth.uid()),
    'Unknown'
  )
$$;

-- ------------------------------------------------------------ record_payment
create or replace function record_payment(
  p_invoice_id uuid,
  p_amount_cents bigint,
  p_method payment_method,
  p_reference text,
  p_proof_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  inv fee_invoices;
  learner text;
  ref text := nullif(trim(p_reference), '');
  payment_id uuid;
begin
  select * into inv from fee_invoices where id = p_invoice_id for update;
  if inv.id is null or not may_administer(inv.tenant_id) then
    raise exception 'That invoice could not be found.' using errcode = '42501';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'Enter the amount received.' using errcode = '22023';
  end if;
  if p_amount_cents > inv.total_cents - inv.paid_cents then
    raise exception 'That is more than the outstanding balance.' using errcode = '22023';
  end if;
  if ref is null and p_method <> 'cash' then
    raise exception 'Enter the receipt, slip or cheque number.' using errcode = '22023';
  end if;
  if p_method = 'mpesa' then ref := upper(ref); end if;

  begin
    insert into payments (tenant_id, invoice_id, amount_cents, method, mpesa_receipt, reference,
                          status, completed_at, recorded_by)
    values (inv.tenant_id, inv.id, p_amount_cents, p_method,
            case when p_method = 'mpesa' then ref end, ref,
            'success', now(), auth.uid())
    returning id into payment_id;
  exception when unique_violation then
    raise exception 'M-Pesa receipt % has already been recorded.', ref using errcode = '23505';
  end;

  if p_proof_id is not null then
    update payment_proofs
       set status = 'confirmed', reviewed_by = auth.uid(), reviewed_at = now()
     where id = p_proof_id and invoice_id = inv.id and status = 'pending';
    if not found then
      raise exception 'That payment proof is no longer waiting for review on this invoice.' using errcode = '22023';
    end if;
  end if;

  select full_name into learner from students where id = inv.student_id;
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (
    inv.tenant_id, auth.uid(), my_actor_label(),
    format('%s payment recorded for %s%s',
           case p_method::text when 'mpesa' then 'M-Pesa' else initcap(p_method::text) end, learner,
           case when ref is not null then ', ref ' || ref else '' end),
    'financial',
    jsonb_build_object('invoice_id', inv.id, 'payment_id', payment_id, 'amount_cents', p_amount_cents,
                       'method', p_method, 'proof_id', p_proof_id)
  );

  return payment_id;
end $$;

revoke execute on function record_payment(uuid, bigint, payment_method, text, uuid) from public, anon;
grant execute on function record_payment(uuid, bigint, payment_method, text, uuid) to authenticated;

-- ------------------------------------------------------------ log_admin_event
create or replace function log_admin_event(
  p_tenant_id uuid, p_event text, p_category text, p_metadata jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not may_administer(p_tenant_id) then
    raise exception 'You do not administer this school.' using errcode = '42501';
  end if;
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (p_tenant_id, auth.uid(), my_actor_label(), p_event, p_category, coalesce(p_metadata, '{}'::jsonb));
end $$;

revoke execute on function log_admin_event(uuid, text, text, jsonb) from public, anon;
grant execute on function log_admin_event(uuid, text, text, jsonb) to authenticated;
