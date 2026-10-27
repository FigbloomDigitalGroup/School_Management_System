-- Charging a learner for a lost or damaged item.
--
-- A term's invoice is one total per learner (fee_invoices.total_cents), with
-- no line items, and a trigger (20261022000001) refuses any change to
-- paid_cents/status that isn't a recorded payment. The office now needs to
-- add a one-off amount to what a family owes: a textbook that never came
-- back, a broken microscope. Always by hand, never automatic: closing an
-- issue as lost doesn't bill anyone, it offers the office a charge
-- prefilled with the item's cost, which it can change or not make at all.
--
-- Decision: a charge is a row in fee_charges, attached to the learner's
-- invoice for the current term, and it raises that invoice's total_cents
-- (and charges_cents, the part of the total that is charges). Cancelling a
-- charge (void_fee_charge) lowers them again. The row is the line item and
-- the audit trail: who charged what, why, for which issue, and who
-- cancelled it and why. Rows are never deleted.
--
-- Why fold it into total_cents: every place that works out a balance
-- already reads total_cents - paid_cents: the web Fees screens (parent,
-- learner, office), the dashboards and reports, record_payment()'s "more
-- than the outstanding balance" check, apply_payment's paid / part-paid
-- status, the mpesa-stk-push amount check, the report card's fee line, and
-- the phone app (through packages/shared parentData/studentData). With the
-- charge inside the total, all of them agree the moment it's made, and none
-- had to change, including the phone app already in families' hands.
--
-- Alternatives considered:
--   * a charges table that balances add on top of the invoice. Cleaner
--     separation, but every balance above would have to learn to add it,
--     and the ones that didn't (an old phone build, the STK push check, the
--     payment status trigger) would quietly disagree. Payments would also
--     need somewhere to go: they belong to invoices.
--   * editing total_cents by hand with an audit event. No line item for the
--     family to see, and nothing stops the next hand edit erasing it.
--   * full invoice line items (fee items copied per invoice). The right end
--     state for itemised statements, but a rewrite of billing for one use.
--
-- What it costs: total_cents now means "fees billed plus charges", so a
-- screen that wants the fees alone takes total_cents - charges_cents, and
-- the family's statement lists the charges (fee_charges is readable by
-- whoever can read the invoice). A bursar's e-signature on an invoice
-- covers the total it was signed at; adding a charge changes the total, so
-- the signature shows as made on an earlier version and the bursar signs
-- again. That is the honest answer: the signed amount is no longer owed.
--
-- A charge needs the learner to have been billed for the current term,
-- since that is the invoice families pay against. It doesn't create an
-- invoice itself: the billing run only bills learners without one, so a
-- charge-only invoice would stop the term's fees ever being billed.

-- ---------------------------------------------------------------- invoices
alter table fee_invoices
  add column charges_cents bigint not null default 0 check (charges_cents >= 0),
  -- an office editing the billed amount by hand can't edit a charge away
  add constraint fee_invoices_charges_within_total check (charges_cents <= total_cents);

-- charges_cents only moves with a charge (apply_fee_charge, one trigger level down).
create or replace function guard_invoice_charges() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null or pg_trigger_depth() > 1 then return new; end if;
  if tg_op = 'INSERT' then
    if new.charges_cents <> 0 then
      raise exception 'A new invoice starts with no charges. Add charges to it instead.' using errcode = '42501';
    end if;
  elsif new.charges_cents is distinct from old.charges_cents then
    raise exception 'An invoice''s charges only change when a charge is added or cancelled.' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger fee_invoices_guard_charges before insert or update on fee_invoices
  for each row execute function guard_invoice_charges();

-- ---------------------------------------------------------------- charges
create table fee_charges (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants on delete cascade,
  invoice_id   uuid not null references fee_invoices on delete cascade,
  student_id   uuid not null references students on delete cascade,
  amount_cents bigint not null check (amount_cents > 0),
  -- what the family reads on their statement: "Lost: KLB Biology Form 2"
  reason       text not null check (char_length(trim(reason)) between 1 and 200),
  -- the hand-out it's for, when it's for a lost or damaged item
  issue_id     uuid references inventory_issues on delete set null,
  created_by   uuid references profiles on delete set null,
  created_at   timestamptz not null default now(),
  voided_at    timestamptz,
  voided_by    uuid references profiles on delete set null,
  void_reason  text check (void_reason is null or char_length(trim(void_reason)) between 1 and 200),
  check ((voided_at is null) = (void_reason is null))
);
create index on fee_charges (invoice_id);
create index on fee_charges (student_id, created_at desc);
-- one standing charge per lost or damaged hand-out
create unique index fee_charges_one_per_issue on fee_charges (issue_id) where issue_id is not null and voided_at is null;

alter table fee_charges enable row level security;

-- Whoever can read the invoice reads its charges (invoice_read decides:
-- staff, the office, the learner's guardians, the learner). No write
-- policies: charge_learner() and void_fee_charge() are the only way in.
create policy fee_charges_read on fee_charges for select
  using (exists (select 1 from fee_invoices i where i.id = fee_charges.invoice_id));

-- What a charge does to its invoice: adding raises the total, cancelling
-- lowers it, and the status follows (a paid invoice with a new charge is
-- part-paid again). A charge already paid for can't be cancelled: that
-- would leave the family owed money, and there is no refund flow yet.
create or replace function apply_fee_charge() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_delta bigint;
  v_inv   fee_invoices;
begin
  if tg_op = 'INSERT' then
    v_delta := new.amount_cents;
  elsif old.voided_at is null and new.voided_at is not null then
    v_delta := -new.amount_cents;
  else
    return new;
  end if;

  select * into v_inv from fee_invoices where id = new.invoice_id for update;
  if v_delta < 0 and v_inv.paid_cents > v_inv.total_cents + v_delta then
    raise exception 'This charge has already been paid for, so it can''t be cancelled.' using errcode = '22023';
  end if;
  update fee_invoices
     set total_cents   = total_cents + v_delta,
         charges_cents = charges_cents + v_delta,
         status = (case
           when paid_cents >= total_cents + v_delta then 'paid'
           when due_on < current_date then 'overdue'
           when paid_cents > 0 then 'part_paid'
           else 'unpaid' end)::invoice_status
   where id = new.invoice_id;
  return new;
end $$;

create trigger apply_fee_charge after insert or update of voided_at on fee_charges
  for each row execute function apply_fee_charge();

-- ---------------------------------------------------------------- functions the app calls

-- Adds a charge to the learner's invoice for the current term. p_issue_id,
-- when given, is the lost or damaged hand-out it's for; it must be this
-- learner's, closed as lost or damaged, and not already charged.
create or replace function charge_learner(
  p_student_id uuid, p_amount_cents bigint, p_reason text, p_issue_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_student students;
  v_inv     fee_invoices;
  v_issue   inventory_issues;
  v_reason  text := nullif(trim(p_reason), '');
  v_id      uuid;
begin
  select * into v_student from students where id = p_student_id;
  if v_student.id is null or not may_administer(v_student.tenant_id) then
    raise exception 'That learner could not be found.' using errcode = '42501';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'Enter the amount to charge.' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'Say what the charge is for.' using errcode = '22023';
  end if;
  if p_issue_id is not null then
    select * into v_issue from inventory_issues where id = p_issue_id;
    if v_issue.id is null or v_issue.student_id is distinct from p_student_id or v_issue.status not in ('lost', 'damaged') then
      raise exception 'Only an item this learner lost or returned damaged can be charged for.' using errcode = '22023';
    end if;
  end if;

  select i.* into v_inv
    from fee_invoices i join terms t on t.id = i.term_id
   where i.student_id = p_student_id and t.is_current and t.tenant_id = v_student.tenant_id
   for update of i;
  if v_inv.id is null then
    raise exception '% hasn''t been billed for this term yet. Bill the term first, then add the charge.', v_student.full_name
      using errcode = '22023';
  end if;

  begin
    insert into fee_charges (tenant_id, invoice_id, student_id, amount_cents, reason, issue_id, created_by)
    values (v_student.tenant_id, v_inv.id, p_student_id, p_amount_cents, v_reason, p_issue_id, auth.uid())
    returning id into v_id;
  exception when unique_violation then
    raise exception 'That item has already been charged for.' using errcode = '23505';
  end;

  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (
    v_student.tenant_id, auth.uid(), my_actor_label(),
    format('Charge added for %s: %s', v_student.full_name, v_reason),
    'financial',
    jsonb_build_object('charge_id', v_id, 'invoice_id', v_inv.id, 'amount_cents', p_amount_cents, 'issue_id', p_issue_id)
  );
  return v_id;
end $$;

-- Cancels a charge (a mistake, or the item turned up). The row stays, marked.
create or replace function void_fee_charge(p_charge_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_charge  fee_charges;
  v_reason  text := nullif(trim(p_reason), '');
begin
  select * into v_charge from fee_charges where id = p_charge_id for update;
  if v_charge.id is null or not may_administer(v_charge.tenant_id) then
    raise exception 'That charge could not be found.' using errcode = '42501';
  end if;
  if v_charge.voided_at is not null then
    raise exception 'That charge has already been cancelled.' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'Say why the charge is being cancelled.' using errcode = '22023';
  end if;

  update fee_charges set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason where id = p_charge_id;

  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (
    v_charge.tenant_id, auth.uid(), my_actor_label(),
    format('Charge cancelled for %s: %s (%s)', (select full_name from students where id = v_charge.student_id), v_charge.reason, v_reason),
    'financial',
    jsonb_build_object('charge_id', v_charge.id, 'invoice_id', v_charge.invoice_id, 'amount_cents', v_charge.amount_cents)
  );
end $$;

revoke execute on function charge_learner(uuid, bigint, text, uuid) from public, anon;
revoke execute on function void_fee_charge(uuid, text) from public, anon;
grant execute on function charge_learner(uuid, bigint, text, uuid) to authenticated;
grant execute on function void_fee_charge(uuid, text) to authenticated;
