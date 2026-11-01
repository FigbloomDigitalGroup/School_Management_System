-- FIG-1315: what a family owes changes only through adjust_invoice_total(),
-- with a reason, and the stored status follows.
--
-- Triggers already refused a client change to paid_cents, charges_cents and
-- status, but total_cents was open to anyone invoice_update lets in (the
-- office, and staff holding the fees area). Setting the total to what had
-- been paid wrote a debt off with no payment, no reason and (before
-- 20261103300001) no audit event, and nothing recomputed the status: an
-- invoice lowered to what was paid stayed part_paid, one raised above it
-- stayed paid, and a total could go below what had already been paid.
--
-- Waivers, discounts and bursaries aren't in the app, so this is the one
-- honest way to change a total: adjust_invoice_total(invoice, new total,
-- reason). Only a full admin (may_administer, as for charges) may, the
-- new total can't go below what's been paid or below the invoice's own
-- charges, the status is recomputed, and the audit event carries the old
-- and new amounts and the reason. A client updating total_cents directly is
-- refused. Charges (apply_fee_charge, one trigger level down), the billing
-- run's insert, and the service role are unaffected.
--
-- Stored statuses already out of step are left as they are: nothing reads
-- the column for a decision (the screens work from total - paid), and
-- 'overdue' isn't kept up to date by anything as the days pass either.
--
-- supabase/rls-checks/fees.sql checks it.

-- Not security definer, so current_user is whoever made the change:
-- adjust_invoice_total()'s owner, or authenticated for a client.
create or replace function guard_invoice_total() returns trigger
language plpgsql as $$
begin
  if new.total_cents is distinct from old.total_cents and current_user = 'authenticated' then
    raise exception 'Change what a family owes with Adjust total, giving a reason.' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger fee_invoices_guard_total before update of total_cents on fee_invoices
  for each row execute function guard_invoice_total();

-- 20261022000001's guard, now letting adjust_invoice_total() recompute the
-- status of the one invoice it is adjusting. paid_cents still only moves
-- with a payment.
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
  elsif new.paid_cents is distinct from old.paid_cents
     or (new.status is distinct from old.status
         and current_setting('figbloom.invoice_adjusted', true) is distinct from new.id::text) then
    raise exception 'An invoice''s paid amount only changes when a payment is recorded.'
      using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function adjust_invoice_total(p_invoice_id uuid, p_total_cents bigint, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  inv fee_invoices;
  reason text := nullif(trim(p_reason), '');
  learner text;
begin
  select * into inv from fee_invoices where id = p_invoice_id for update;
  if inv.id is null or not may_administer(inv.tenant_id) then
    raise exception 'That invoice could not be found.' using errcode = '42501';
  end if;
  if reason is null then
    raise exception 'Say why the total is changing.' using errcode = '22023';
  end if;
  if p_total_cents is null or p_total_cents < 0 then
    raise exception 'Enter the new total.' using errcode = '22023';
  end if;
  if p_total_cents = inv.total_cents then
    raise exception 'That is already the total.' using errcode = '22023';
  end if;
  if p_total_cents < inv.paid_cents then
    raise exception 'The total can''t go below what has already been paid.' using errcode = '22023';
  end if;
  if p_total_cents < inv.charges_cents then
    raise exception 'The total can''t go below the charges on this invoice. Cancel a charge instead.' using errcode = '22023';
  end if;

  -- this function writes the event, with the reason; audit_invoice_edited() skips it
  perform set_config('figbloom.invoice_adjusted', inv.id::text, true);
  update fee_invoices
     set total_cents = p_total_cents,
         status = (case
           when paid_cents >= p_total_cents then 'paid'
           when due_on < current_date then 'overdue'
           when paid_cents > 0 then 'part_paid'
           else 'unpaid' end)::invoice_status
   where id = inv.id;
  perform set_config('figbloom.invoice_adjusted', '', true);

  select full_name into learner from students where id = inv.student_id;
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (
    inv.tenant_id, auth.uid(), my_actor_label(),
    format('Invoice total for %s changed from %s to %s: %s', coalesce(learner, 'a learner'),
           to_char(inv.total_cents / 100.0, 'FM999,999,999,990.00'), to_char(p_total_cents / 100.0, 'FM999,999,999,990.00'), reason),
    'financial',
    jsonb_build_object('invoice_id', inv.id, 'from_cents', inv.total_cents, 'to_cents', p_total_cents, 'reason', reason)
  );
end $$;

revoke execute on function adjust_invoice_total(uuid, bigint, text) from public, anon;
grant execute on function adjust_invoice_total(uuid, bigint, text) to authenticated;

-- 20261103300001's edit audit, now skipping the invoice adjust_invoice_total() is logging itself
create or replace function audit_invoice_edited() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  changed jsonb;
  learner text;
begin
  if pg_trigger_depth() > 1 then return new; end if;
  if current_setting('figbloom.invoice_adjusted', true) = new.id::text then return new; end if;
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
