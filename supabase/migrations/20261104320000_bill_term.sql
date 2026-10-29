-- FIG-1331: a billing run is one database call, and its audit event is what
-- was saved.
--
-- The Bill learners dialog saved invoices in batches of 500 from the
-- browser, then called log_admin_event() with the number it had planned.
-- Two admins billing at once (or a stale tab) both planned every learner,
-- the database kept one invoice each, and the log claimed twice as many; a
-- run that failed part-way logged nothing for the batches it had saved; and
-- the log call's own result was never checked.
--
-- bill_term(term, due date, invoices) inserts every missing invoice in one
-- statement, in one transaction, skipping learners already billed for the
-- term. The audit event comes from fee_invoices' own insert trigger
-- (audit_invoices_created, 20261103300001): one "N fee invoices created for
-- <term>" line with the real count, total and invoice ids, under the
-- caller's name. A run that saves nothing (everyone already billed) logs
-- nothing, and a run that fails saves nothing. The dialog shows what was
-- created and what was already billed, from the database's answer.
--
-- The amounts still come from the dialog's plan (planTermBilling, the same
-- maths the parent's bill breakdown uses), as they did before; who may bill
-- is has_perm(tenant, 'fees'), as for the invoice insert policy.
--
-- supabase/rls-checks/fees.sql checks it.

create or replace function bill_term(p_term_id uuid, p_due_on date, p_invoices jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  t terms;
  v_asked int := jsonb_array_length(coalesce(p_invoices, '[]'::jsonb));
  v_created int;
  v_total bigint;
begin
  select * into t from terms where id = p_term_id;
  if t.id is null or not has_perm(t.tenant_id, 'fees') then
    raise exception 'That term could not be found.' using errcode = '42501';
  end if;
  if p_due_on is null then
    raise exception 'Choose the date the fees are due.' using errcode = '22023';
  end if;

  with created as (
    insert into fee_invoices (tenant_id, student_id, term_id, total_cents, due_on)
    select t.tenant_id, (x ->> 'student_id')::uuid, t.id, (x ->> 'total_cents')::bigint, p_due_on
      from jsonb_array_elements(coalesce(p_invoices, '[]'::jsonb)) x
    on conflict (student_id, term_id) do nothing
    returning total_cents
  )
  select count(*), coalesce(sum(total_cents), 0) into v_created, v_total from created;

  return jsonb_build_object('created', v_created, 'total_cents', v_total, 'already_billed', v_asked - v_created);
end $$;

revoke execute on function bill_term(uuid, date, jsonb) from public, anon;
grant execute on function bill_term(uuid, date, jsonb) to authenticated;
