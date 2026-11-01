-- FIG-1319: an invoice with money behind it can't be deleted.
--
-- invoice_write lets the school admin (and staff holding the fees area) do
-- anything to fee_invoices, and payments, payment_proofs and fee_charges all
-- point at their invoice `on delete cascade`. So one DELETE on an invoice
-- erased every payment recorded against it, the family's uploaded proofs and
-- every charge, with no audit event. 20261022000001 made sure a balance only
-- moves with a payment behind it; this was the same result by another door.
-- Deleting a term reached it too: fee_invoices.term_id cascades from terms,
-- and admins can delete terms. (Deleting a learner already couldn't:
-- guard_student_delete refuses anyone with fee records.)
--
-- The guard looks at what hangs off the invoice, not at how the delete
-- arrived, so a direct DELETE and a cascade from terms are refused alike.
-- The one delete that goes through is a whole school being removed: the
-- tenant row is already gone by the time its cascade reaches the invoices.
-- No exception for the service role: nothing in the edge functions or seeds
-- deletes invoices.
--
-- An invoice with nothing behind it (a billing run made for the wrong
-- learner, say) can still be deleted, and the deletion is now in the audit
-- log. The cascades stay as they are, since a school removal relies on them.
--
-- supabase/rls-checks/fees.sql checks it.

create or replace function guard_invoice_delete() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  found_on text[] := '{}';
  learner text;
  term_name text;
begin
  -- the whole school is being removed
  if not exists (select 1 from tenants where id = old.tenant_id) then return old; end if;

  if old.paid_cents > 0 or exists (select 1 from payments where invoice_id = old.id) then
    found_on := array_append(found_on, 'payments');
  end if;
  if exists (select 1 from payment_proofs where invoice_id = old.id) then found_on := array_append(found_on, 'proofs of payment'); end if;
  if exists (select 1 from fee_charges where invoice_id = old.id) then found_on := array_append(found_on, 'charges'); end if;

  select full_name into learner from students where id = old.student_id;
  select name into term_name from terms where id = old.term_id;

  if cardinality(found_on) > 0 then
    raise exception '%''s invoice% has % recorded against it, so it can''t be deleted.',
      coalesce(learner, 'This learner'), coalesce(' for ' || term_name, ''), array_to_string(found_on, ', ')
      using errcode = '23001';
  end if;

  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (
    old.tenant_id, auth.uid(), my_actor_label(),
    format('Fee invoice deleted for %s%s', coalesce(learner, 'a learner'), coalesce(', ' || term_name, '')),
    'financial',
    jsonb_build_object('invoice_id', old.id, 'student_id', old.student_id, 'term_id', old.term_id,
                       'total_cents', old.total_cents)
  );
  return old;
end $$;

create trigger fee_invoices_guard_delete before delete on fee_invoices
  for each row execute function guard_invoice_delete();
