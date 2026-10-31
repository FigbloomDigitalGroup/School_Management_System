-- FIG-1333: an invoice's stored status is true whenever it's read.
--
-- fee_invoices.status was only written the moment a payment, a charge or an
-- adjustment landed. Nothing ran when a due date passed, so an unpaid or
-- part-paid invoice stayed that way for ever: on the seed, 231 of Alliance's
-- invoices were past their due date with a balance and still said unpaid.
-- Nothing reads the column for a decision today (the screens work from
-- total - paid), but it is stored data that was wrong by design, and a trap
-- for the first report or export that does read it.
--
-- One rule, invoice_status_for(total, paid, due date), the same one
-- apply_fee_charge() and adjust_invoice_total() already use (apply_payment()
-- agrees: a payment is never zero, so it never lands on "unpaid"):
--   paid       nothing left to pay
--   overdue    a balance, and the due date has passed
--   part_paid  a balance, something paid, not yet due
--   unpaid     nothing paid, not yet due
--
-- refresh_invoice_statuses() sets every invoice to what that rule says, and
-- runs now and every night just after midnight in Nairobi (pg_cron, 21:15
-- UTC). Its changes are the system's, not someone's action, so instead of a
-- line per invoice it writes one financial event per school ("12 invoices
-- now overdue") with the invoice ids. audit_invoice_edited() skips the rows
-- it touches.
--
-- supabase/rls-checks/fees.sql checks it.

create or replace function invoice_status_for(p_total bigint, p_paid bigint, p_due_on date) returns invoice_status
language sql stable as $$
  select (case
    when p_paid >= p_total then 'paid'
    when p_due_on < current_date then 'overdue'
    when p_paid > 0 then 'part_paid'
    else 'unpaid' end)::invoice_status
$$;

create or replace function refresh_invoice_statuses() returns int
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  -- the system bringing statuses up to date: one summary event, not a line per invoice
  perform set_config('figbloom.status_refresh', 'true', true);
  with changed as (
    update fee_invoices i
       set status = invoice_status_for(i.total_cents, i.paid_cents, i.due_on)
     where i.status is distinct from invoice_status_for(i.total_cents, i.paid_cents, i.due_on)
    returning i.id, i.tenant_id, i.status
  ), logged as (
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    select c.tenant_id, null, 'System',
           format('%s invoice%s now %s', count(*), case when count(*) = 1 then '' else 's' end, replace(c.status::text, '_', ' ')),
           'financial',
           jsonb_build_object('status', c.status, 'invoices', count(*), 'invoice_ids', jsonb_agg(c.id))
      from changed c
     group by c.tenant_id, c.status
    returning 1
  )
  select count(*) into n from changed;
  perform set_config('figbloom.status_refresh', '', true);
  return n;
end $$;
revoke execute on function refresh_invoice_statuses() from public, anon, authenticated;

-- 20261103500000's edit audit, now skipping the system's status refresh
create or replace function audit_invoice_edited() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  changed jsonb;
  learner text;
begin
  if pg_trigger_depth() > 1 then return new; end if;
  if current_setting('figbloom.invoice_adjusted', true) = new.id::text then return new; end if;
  if current_setting('figbloom.status_refresh', true) = 'true' then return new; end if;
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

-- today's stale statuses
select refresh_invoice_statuses();

-- and every night from now on
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron is not available here: invoice statuses will only refresh when this runs by hand';
    return;
  end if;
  create extension if not exists pg_cron with schema pg_catalog;
  perform cron.unschedule(jobid) from cron.job where jobname = 'refresh-invoice-statuses';
  perform cron.schedule('refresh-invoice-statuses', '15 21 * * *', 'select public.refresh_invoice_statuses()');
end $$;
