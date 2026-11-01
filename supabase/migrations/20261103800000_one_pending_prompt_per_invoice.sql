-- FIG-1321: one pending M-Pesa prompt per invoice, held by the database.
--
-- mpesa-stk-push checked "any pending payment for this invoice in the last
-- 90 seconds?" and then inserted one, with nothing in between: two requests
-- arriving together (the web app and the phone app, or a retry after the
-- app's timeout) both raised a prompt. Once two were pending, the check's
-- maybeSingle() errored and the error read as "nothing in flight", so every
-- further request raised another. That is how a family ends up paying twice
-- (FIG-1316).
--
-- A partial unique index makes the second insert fail; the function catches
-- 23505 and answers with the prompt already in flight. A prompt whose
-- callback never came used to sit pending for ever, which this index would
-- turn into an invoice nobody can pay by M-Pesa again, so mpesa-stk-push now
-- settles a prompt older than two minutes by asking Daraja, as the callback
-- does.
--
-- Existing duplicates have to go before the index can be built. A pending
-- prompt more than a day old is long dead (Safaricom gives up on a prompt
-- within minutes) and is marked timeout, keeping the newest pending prompt
-- per invoice. If two prompts younger than that are pending for the same
-- invoice, one of them might still be paid: the migration stops and says so,
-- rather than guessing which.

with ranked as (
  select id, row_number() over (partition by invoice_id order by created_at desc) as n
    from payments
   where status = 'pending'
)
update payments p
   set status = 'timeout', failure_reason = 'timeout', completed_at = now()
  from ranked r
 where p.id = r.id and r.n > 1 and p.created_at < now() - interval '1 day';

do $$
declare
  dupes int;
begin
  select count(*) into dupes from (
    select invoice_id from payments where status = 'pending' group by invoice_id having count(*) > 1
  ) d;
  if dupes > 0 then
    raise exception '% invoice(s) have more than one pending M-Pesa prompt from the last day. Settle them (ask Daraja, or wait for the callbacks), then run this again.', dupes;
  end if;
end $$;

create unique index payments_one_pending_per_invoice on payments (invoice_id) where status = 'pending';
