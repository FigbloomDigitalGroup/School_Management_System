-- FIG-1316: a payment that takes an invoice above its total is recorded as
-- an overpayment, not silently absorbed.
--
-- record_payment() refuses more than the balance, and mpesa-stk-push checks
-- the balance when it raises the prompt. But the money arrives later, with
-- the callback, and apply_payment added it with no check. If the balance
-- moved in between (the office took cash at the front desk while the
-- parent's prompt was pending, or a second prompt went out after the
-- 90-second in-flight guard), both payments credited: an invoice of
-- 1,000,000 ended at paid_cents 2,000,000, every screen showed nothing owed,
-- and nothing said the family had overpaid.
--
-- The callback can't refuse the money: the family has already paid it. So
-- the payment is still applied in full (paid_cents is what was received),
-- and apply_payment now writes an audit event saying how much of it was
-- above what was owed. The office Fees screen lists every invoice whose paid
-- amount is above its total, which also catches the other way in: a charge
-- cancelled after the invoice was paid.
--
-- Refunds and carrying credit forward aren't in the app yet; the office
-- settles an overpayment with the family itself.
--
-- supabase/rls-checks/fees.sql checks it.

create or replace function apply_payment() returns trigger language plpgsql as $$
declare
  inv fee_invoices;
  excess bigint;
  learner text;
begin
  if new.status = 'success' and (old.status is distinct from 'success') then
    update fee_invoices
       set paid_cents = paid_cents + new.amount_cents,
           status = (case
             when paid_cents + new.amount_cents >= total_cents then 'paid'
             when due_on < current_date then 'overdue'
             else 'part_paid' end)::invoice_status
     where id = new.invoice_id
     returning * into inv;

    excess := least(new.amount_cents, inv.paid_cents - inv.total_cents);
    if excess > 0 then
      select full_name into learner from students where id = inv.student_id;
      insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
      values (
        inv.tenant_id, auth.uid(),
        case when auth.uid() is null and new.method = 'mpesa' then 'M-Pesa' else my_actor_label() end,
        format('Overpayment for %s: %s received above what was owed. Refund it or agree to carry it forward.',
               coalesce(learner, 'a learner'), to_char(excess / 100.0, 'FM999,999,999,990.00')),
        'financial',
        jsonb_build_object('invoice_id', inv.id, 'payment_id', new.id, 'excess_cents', excess,
                           'paid_cents', inv.paid_cents, 'total_cents', inv.total_cents)
      );
    end if;
  end if;
  return new;
end $$;

-- Every invoice, in any term, paid above its total. PostgREST can't compare
-- two columns in a filter, so the office screen reads this. security_invoker:
-- the caller's own invoice_read policy decides which rows they see.
create view overpaid_invoices with (security_invoker = true) as
  select id, tenant_id, student_id, term_id, total_cents, paid_cents,
         paid_cents - total_cents as overpaid_cents
    from fee_invoices
   where paid_cents > total_cents;
revoke all on overpaid_invoices from public, anon;
grant select on overpaid_invoices to authenticated;
