-- apply_payment's CASE yields untyped string literals, which resolve to text,
-- and Postgres won't assign text to fee_invoices.status (invoice_status) in
-- an UPDATE: "column status is of type invoice_status but expression is of
-- type text". So every successful payment -- the Safaricom callback marking
-- one success, or a seed inserting one -- failed and rolled back, and no
-- invoice ever moved. Same logic, with the result cast to the enum.
create or replace function apply_payment() returns trigger language plpgsql as $$
begin
  if new.status = 'success' and (old.status is distinct from 'success') then
    update fee_invoices
       set paid_cents = paid_cents + new.amount_cents,
           status = (case
             when paid_cents + new.amount_cents >= total_cents then 'paid'
             when due_on < current_date then 'overdue'
             else 'part_paid' end)::invoice_status
     where id = new.invoice_id;
  end if;
  return new;
end $$;
