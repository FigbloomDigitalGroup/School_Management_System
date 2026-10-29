-- Fee collection checks for 20261022000001 (record_payment, the paid_cents
-- guard, log_admin_event) and the billing run's insert.
--
-- Runs against a local database that has the migrations applied and
-- `npm run db:seed` data, inside one transaction that is rolled back.
-- Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/fees.sql

\set ON_ERROR_STOP 1
begin;

select set_config('t.a',       (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.admin',   (select id::text from profiles where role = 'school_admin' and tenant_id = (select id from tenants where slug = 'alliance') limit 1), true);
select set_config('t.parent',  (select id::text from profiles where role = 'parent' and tenant_id = (select id from tenants where slug = 'alliance') limit 1), true);
select set_config('t.teacher', (select id::text from profiles where role = 'teacher' and tenant_id = (select id from tenants where slug = 'alliance') limit 1), true);
select set_config('t.inv', (select id::text from fee_invoices where paid_cents < total_cents and paid_cents = 0 order by id limit 1), true);
select set_config('t.inv2', (select id::text from fee_invoices where paid_cents < total_cents and id::text <> current_setting('t.inv') order by id limit 1), true);
select set_config('t.bal', (select (total_cents - paid_cents)::text from fee_invoices where id = current_setting('t.inv')::uuid), true);

insert into payment_proofs (tenant_id, invoice_id, uploaded_by, file_path, file_name)
  values (current_setting('t.a')::uuid, current_setting('t.inv')::uuid, current_setting('t.parent')::uuid, 'x', 'slip.jpg');
select set_config('t.proof', (select id::text from payment_proofs where file_name = 'slip.jpg'), true);

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when ok then 'PASS' else 'FAIL' end, label; end $$;
create function pg_temp.expect_error(label text, stmt text, errcode text) returns void language plpgsql as $$
begin
  begin execute stmt; raise notice 'FAIL %: allowed', label;
  exception when others then
    if sqlstate = errcode then raise notice 'PASS % (%)', label, sqlerrm;
    else raise notice 'FAIL %: % %', label, sqlstate, sqlerrm; end if;
  end;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- admin
select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;

select pg_temp.expect_error('admin edits paid_cents directly',
  format('update fee_invoices set paid_cents = total_cents where id = %L', current_setting('t.inv')), '42501');
select pg_temp.expect_error('admin marks an invoice paid directly',
  format('update fee_invoices set status = ''paid'' where id = %L', current_setting('t.inv')), '42501');
select pg_temp.expect_error('more than the balance',
  format('select record_payment(%L, %s, ''cash'', null)', current_setting('t.inv'), current_setting('t.bal')::bigint + 100), '22023');
select pg_temp.expect_error('bank payment without a reference',
  format('select record_payment(%L, 100, ''bank'', ''  '')', current_setting('t.inv')), '22023');

select record_payment(current_setting('t.inv')::uuid, 500000, 'bank', 'SLIP-001', current_setting('t.proof')::uuid);
select pg_temp.check('invoice credited by a recorded bank payment',
  (select paid_cents from fee_invoices where id = current_setting('t.inv')::uuid) = 500000);
select pg_temp.check('invoice status moved off unpaid (part_paid, or overdue past its due date)',
  (select status::text = case when due_on < current_date then 'overdue' else 'part_paid' end
     from fee_invoices where id = current_setting('t.inv')::uuid));
reset role;
select pg_temp.check('proof confirmed by the same call',
  (select status::text from payment_proofs where id = current_setting('t.proof')::uuid) = 'confirmed');
select pg_temp.check('audit event written with the admin as actor',
  (select count(*) from audit_events where actor_id = current_setting('t.admin')::uuid and event like 'Bank payment recorded for %SLIP-001') = 1);
select pg_temp.check('payment row records who entered it',
  (select recorded_by::text from payments where reference = 'SLIP-001') = current_setting('t.admin'));
set local role authenticated;

select pg_temp.expect_error('confirming the same proof twice',
  format('select record_payment(%L, 100, ''bank'', ''SLIP-002'', %L)', current_setting('t.inv'), current_setting('t.proof')), '22023');

select record_payment(current_setting('t.inv2')::uuid, 100, 'mpesa', 'sfc123abc');
select pg_temp.expect_error('same M-Pesa receipt recorded twice',
  format('select record_payment(%L, 100, ''mpesa'', ''SFC123ABC'')', current_setting('t.inv2')), '23505');

-- the same slip or cheque twice on one invoice (20261104300000, FIG-1328), on two invoices of their own
reset role;
select set_config('t.dup1', (select id::text from fee_invoices where tenant_id = current_setting('t.a')::uuid
   and paid_cents = 0 and total_cents > 1000 and id::text not in (current_setting('t.inv'), current_setting('t.inv2')) order by id offset 5 limit 1), true);
select set_config('t.dup2', (select id::text from fee_invoices where tenant_id = current_setting('t.a')::uuid
   and paid_cents = 0 and total_cents > 1000 and id::text not in (current_setting('t.inv'), current_setting('t.inv2')) order by id offset 6 limit 1), true);
set local role authenticated;
select record_payment(current_setting('t.dup1')::uuid, 100, 'bank', 'DUP-SLIP 7');
select pg_temp.expect_error('the same bank slip twice on one invoice, written differently',
  format('select record_payment(%L, 100, ''bank'', '' dup-slip7 '')', current_setting('t.dup1')), '23505');
select record_payment(current_setting('t.dup1')::uuid, 100, 'cheque', 'CHQ-881');
select pg_temp.expect_error('the same cheque twice on one invoice',
  format('select record_payment(%L, 100, ''cheque'', ''chq-881'')', current_setting('t.dup1')), '23505');
select record_payment(current_setting('t.dup2')::uuid, 100, 'bank', 'DUP-SLIP 7');
reset role;
select pg_temp.check('one slip can still be split across invoices (brothers)',
  (select count(*) from payments where reference = 'DUP-SLIP 7' and status = 'success') = 2);
select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;

select log_admin_event(current_setting('t.a')::uuid, 'Billed Term 3', 'financial', '{"invoices": 3}');
reset role;
select pg_temp.check('log_admin_event writes with the caller as actor',
  (select actor_label from audit_events where event = 'Billed Term 3') like '% · school admin');

-- ---------------------------------------------------------------- teacher / parent
select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.teacher'), 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.expect_error('teacher records a payment',
  format('select record_payment(%L, 100, ''cash'', null)', current_setting('t.inv2')), '42501');
select pg_temp.expect_error('teacher writes to the audit log',
  format('select log_admin_event(%L, ''x'', ''access'')', current_setting('t.a')), '42501');
reset role;

select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.parent'), 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.expect_error('parent records a payment',
  format('select record_payment(%L, 100, ''cash'', null)', current_setting('t.inv2')), '42501');
reset role;

-- ---------------------------------------------------------------- M-Pesa path still credits (service role: no jwt)
select set_config('request.jwt.claims', '', true);
insert into payments (tenant_id, invoice_id, amount_cents, method, status, checkout_request_id)
  values (current_setting('t.a')::uuid, current_setting('t.inv2')::uuid, 200, 'mpesa', 'pending', 'ws_CO_test');
update payments set status = 'success', mpesa_receipt = 'SFCCALLBACK' where checkout_request_id = 'ws_CO_test';
select pg_temp.check('callback (service role) still credits the invoice',
  (select count(*) from payments where invoice_id = current_setting('t.inv2')::uuid and status = 'success') = 2);

-- ---------------------------------------------------------------- billing run
select set_config('t.s1', (select id::text from students where tenant_id = current_setting('t.a')::uuid order by id limit 1), true);
select set_config('t.s2', (select id::text from students where tenant_id = current_setting('t.a')::uuid order by id offset 1 limit 1), true);
insert into terms (tenant_id, name, year, index, starts_on, ends_on, is_current)
  values (current_setting('t.a')::uuid, 'Term 1, 2027', 2027, 1, '2027-01-05', '2027-04-02', false);
select set_config('t.term', (select id::text from terms where name = 'Term 1, 2027'), true);
select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$ begin
  insert into fee_invoices (tenant_id, student_id, term_id, total_cents, due_on)
    values (current_setting('t.a')::uuid, current_setting('t.s1')::uuid, current_setting('t.term')::uuid, 4500000, '2027-01-05')
    on conflict (student_id, term_id) do nothing;
  insert into fee_invoices (tenant_id, student_id, term_id, total_cents, due_on)
    values (current_setting('t.a')::uuid, current_setting('t.s1')::uuid, current_setting('t.term')::uuid, 999, '2027-01-05')
    on conflict (student_id, term_id) do nothing;
  raise notice '% admin billing insert (and re-run is a no-op): total=%', case when (select total_cents from fee_invoices where student_id = current_setting('t.s1')::uuid and term_id = current_setting('t.term')::uuid) = 4500000 then 'PASS' else 'FAIL' end,
    (select total_cents from fee_invoices where student_id = current_setting('t.s1')::uuid and term_id = current_setting('t.term')::uuid);
end $$;
do $$ begin
  begin
    insert into fee_invoices (tenant_id, student_id, term_id, total_cents, paid_cents, due_on)
      values (current_setting('t.a')::uuid, current_setting('t.s2')::uuid, current_setting('t.term')::uuid, 4500000, 4500000, '2027-01-05');
    raise notice 'FAIL invoice created already paid';
  exception when others then raise notice 'PASS invoice created already paid is refused (%)', sqlerrm; end;
end $$;
select log_admin_event(current_setting('t.a')::uuid, 'Term 1, 2027 billed: 1 invoices', 'financial', '{}');
reset role;

-- ---------------------------------------------------------------- deleting invoices (20261103300000, FIG-1319)
select set_config('t.inv3', (select id::text from fee_invoices
   where tenant_id = current_setting('t.a')::uuid and paid_cents = 0
     and not exists (select 1 from payments p where p.invoice_id = fee_invoices.id)
     and not exists (select 1 from payment_proofs pp where pp.invoice_id = fee_invoices.id)
     and not exists (select 1 from fee_charges c where c.invoice_id = fee_invoices.id)
     and id::text not in (current_setting('t.inv'), current_setting('t.inv2'))
     and term_id <> current_setting('t.term')::uuid  -- not the Term 1, 2027 invoices made and deleted above
   order by id limit 1), true);
insert into payment_proofs (tenant_id, invoice_id, uploaded_by, file_path, file_name)
  values (current_setting('t.a')::uuid, current_setting('t.inv3')::uuid, current_setting('t.parent')::uuid, 'x', 'slip3.jpg');

select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.expect_error('admin deletes an invoice with a recorded payment',
  format('delete from fee_invoices where id = %L', current_setting('t.inv')), '23001');
select pg_temp.expect_error('admin deletes an invoice with only a proof of payment',
  format('delete from fee_invoices where id = %L', current_setting('t.inv3')), '23001');
select pg_temp.expect_error('admin deletes the term of an invoice with a recorded payment',
  format('delete from terms where id = (select term_id from fee_invoices where id = %L)', current_setting('t.inv')), '23001');
delete from fee_invoices where student_id = current_setting('t.s1')::uuid and term_id = current_setting('t.term')::uuid;
reset role;
select pg_temp.check('payments survive the refused deletes',
  (select count(*) from payments where invoice_id = current_setting('t.inv')::uuid) = 1);
select pg_temp.check('an invoice with nothing recorded can still be deleted',
  not exists (select 1 from fee_invoices where student_id = current_setting('t.s1')::uuid and term_id = current_setting('t.term')::uuid));
select pg_temp.check('deleting an invoice writes an audit event with the admin as actor',
  (select count(*) from audit_events where actor_id = current_setting('t.admin')::uuid
     and event like 'Fee invoice deleted for %, Term 1, 2027') = 1);

select set_config('request.jwt.claims', '', true);
select pg_temp.expect_error('service role deletes an invoice with a recorded payment',
  format('delete from fee_invoices where id = %L', current_setting('t.inv')), '23001');

-- ---------------------------------------------------------------- fee records kept and audited (20261103300001)
select pg_temp.check('a billing insert is audited, once per statement',
  (select count(*) from audit_events where event = '1 fee invoice created for Term 1, 2027') = 1);
select pg_temp.check('a proof sent is audited',
  (select count(*) from audit_events where event like 'Proof of payment sent for %'
     and metadata->>'invoice_id' = current_setting('t.inv3')) = 1);

-- a teacher holding the fees area creates and edits invoices, but deletes none
insert into staff_permissions (tenant_id, profile_id, area) values (current_setting('t.a')::uuid, current_setting('t.teacher')::uuid, 'fees');
select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.teacher'), 'role', 'authenticated')::text, true);
set local role authenticated;
insert into fee_invoices (tenant_id, student_id, term_id, total_cents, due_on)
  values (current_setting('t.a')::uuid, current_setting('t.s2')::uuid, current_setting('t.term')::uuid, 100, '2027-01-05');
update fee_invoices set due_on = '2027-01-12' where student_id = current_setting('t.s2')::uuid and term_id = current_setting('t.term')::uuid;
delete from fee_invoices where student_id = current_setting('t.s2')::uuid and term_id = current_setting('t.term')::uuid;
reset role;
select pg_temp.check('a fees-area teacher can''t delete an invoice, even an empty one',
  exists (select 1 from fee_invoices where student_id = current_setting('t.s2')::uuid and term_id = current_setting('t.term')::uuid));
select pg_temp.check('an invoice edited by hand is audited with what changed',
  (select metadata->'changes'->'due_on'->>'to' from audit_events
    where actor_id = current_setting('t.teacher')::uuid and event like 'Fee invoice for % changed: due on') = '2027-01-12');

select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;
delete from payment_proofs where id = current_setting('t.proof')::uuid;  -- no delete policy: 0 rows
reset role;
select pg_temp.check('admin can''t delete a proof of payment',
  exists (select 1 from payment_proofs where id = current_setting('t.proof')::uuid));
set local role authenticated;
select pg_temp.expect_error('admin changes what a proof says',
  format('update payment_proofs set file_name = ''other.jpg'' where invoice_id = %L', current_setting('t.inv3')), '42501');
select pg_temp.expect_error('admin marks a proof confirmed without recording the payment',
  format('update payment_proofs set status = ''confirmed'' where invoice_id = %L', current_setting('t.inv3')), '42501');
update payment_proofs set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), rejection_reason = 'Slip unreadable'
  where invoice_id = current_setting('t.inv3')::uuid;
select pg_temp.expect_error('a reviewed proof is reviewed again',
  format('update payment_proofs set status = ''pending'' where invoice_id = %L', current_setting('t.inv3')), '22023');
reset role;
select pg_temp.check('a rejected proof is audited with the reason',
  (select count(*) from audit_events where actor_id = current_setting('t.admin')::uuid
     and event like 'Proof of payment rejected for %: Slip unreadable') = 1);

select set_config('request.jwt.claims', '', true);
select pg_temp.expect_error('service role deletes a proof of payment',
  format('delete from payment_proofs where id = %L', current_setting('t.proof')), '42501');

-- the proof's file
insert into storage.objects (bucket_id, name) values
  ('private-documents', current_setting('t.a') || '/invoices/' || current_setting('t.inv3') || '/1-slip.jpg'),
  ('private-documents', current_setting('t.a') || '/students/' || current_setting('t.s1') || '/1-report.pdf');
select set_config('storage.allow_delete_query', 'true', true);  -- what the Storage API sets for a delete
select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;
do $$ declare n int; begin
  delete from storage.objects where bucket_id = 'private-documents' and name like '%/invoices/%/1-slip.jpg';
  get diagnostics n = row_count;
  raise notice '% admin can''t delete a proof''s file (% deleted)', case when n = 0 then 'PASS' else 'FAIL' end, n;
  update storage.objects set metadata = '{}' where bucket_id = 'private-documents' and name like '%/invoices/%/1-slip.jpg';
  get diagnostics n = row_count;
  raise notice '% admin can''t overwrite a proof''s file (% updated)', case when n = 0 then 'PASS' else 'FAIL' end, n;
  delete from storage.objects where bucket_id = 'private-documents' and name like '%/students/%/1-report.pdf';
  get diagnostics n = row_count;
  raise notice '% admin still deletes other office files (% deleted)', case when n = 1 then 'PASS' else 'FAIL' end, n;
exception when others then raise notice 'FAIL proof file checks: % %', sqlstate, sqlerrm; end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- ---------------------------------------------------------------- overpayments (20261103400000, FIG-1316)
-- s2's Term 1, 2027 invoice (100, unpaid) from the fees-area checks above
select set_config('t.inv4', (select id::text from fee_invoices
   where student_id = current_setting('t.s2')::uuid and term_id = current_setting('t.term')::uuid), true);
select set_config('request.jwt.claims', '', true);
insert into payments (tenant_id, invoice_id, amount_cents, method, status, checkout_request_id)
  values (current_setting('t.a')::uuid, current_setting('t.inv4')::uuid, 100, 'mpesa', 'pending', 'ws_CO_over1');
-- one pending prompt per invoice (20261103800000, FIG-1321)
do $$ begin
  insert into payments (tenant_id, invoice_id, amount_cents, method, status, checkout_request_id)
    values (current_setting('t.a')::uuid, current_setting('t.inv4')::uuid, 100, 'mpesa', 'pending', 'ws_CO_dupe');
  raise notice 'FAIL a second pending prompt for the same invoice: allowed';
exception when unique_violation then raise notice 'PASS a second pending prompt for the same invoice is refused';
end $$;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;
select record_payment(current_setting('t.inv4')::uuid, 100, 'cash', null);  -- the front desk, while the prompt waits
reset role;
select set_config('request.jwt.claims', '', true);
update payments set status = 'success', mpesa_receipt = 'SFCOVER1' where checkout_request_id = 'ws_CO_over1';
-- a second prompt, once the first is settled (raised before the cash cleared the balance)
insert into payments (tenant_id, invoice_id, amount_cents, method, status, checkout_request_id)
  values (current_setting('t.a')::uuid, current_setting('t.inv4')::uuid, 100, 'mpesa', 'pending', 'ws_CO_over2');
update payments set status = 'success', mpesa_receipt = 'SFCOVER2' where checkout_request_id = 'ws_CO_over2';
select pg_temp.check('every payment received is kept on the invoice',
  (select paid_cents from fee_invoices where id = current_setting('t.inv4')::uuid) = 300);
select pg_temp.check('each payment above what was owed is audited as an overpayment, by M-Pesa',
  (select count(*) from audit_events where metadata->>'invoice_id' = current_setting('t.inv4')
     and event like 'Overpayment for %: 1.00 received above what was owed.%' and actor_label = 'M-Pesa'
     and (metadata->>'excess_cents')::bigint = 100) = 2);
select pg_temp.check('the cash payment that cleared the balance is not an overpayment',
  (select count(*) from audit_events where event like 'Overpayment%' and metadata->>'invoice_id' = current_setting('t.inv4')
     and metadata->>'payment_id' = (select id::text from payments where invoice_id = current_setting('t.inv4')::uuid and method = 'cash')) = 0);
select pg_temp.check('payments within the balance write no overpayment',
  (select count(*) from audit_events where event like 'Overpayment%' and metadata->>'invoice_id' = current_setting('t.inv2')) = 0);
select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.check('the office sees the overpaid invoice and by how much',
  (select overpaid_cents from overpaid_invoices where id = current_setting('t.inv4')::uuid) = 200);
reset role;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.parent'), 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.check('another family doesn''t see it',
  not exists (select 1 from overpaid_invoices where id = current_setting('t.inv4')::uuid)
  or exists (select 1 from guardians where profile_id = current_setting('t.parent')::uuid and student_id = current_setting('t.s2')::uuid));
reset role;

-- ---------------------------------------------------------------- adjusting a total (20261103500000, FIG-1315)
-- t.inv2 has payments against it (record_payment and the callback above); the teacher holds the fees area from above
select set_config('t.paid2', (select paid_cents::text from fee_invoices where id = current_setting('t.inv2')::uuid), true);
select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.teacher'), 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.expect_error('a fees-area teacher edits a total directly',
  format('update fee_invoices set total_cents = %s where id = %L', current_setting('t.paid2'), current_setting('t.inv2')), '42501');
select pg_temp.expect_error('a fees-area teacher adjusts a total',
  format('select adjust_invoice_total(%L, %s, ''Bursary'')', current_setting('t.inv2'), current_setting('t.paid2')), '42501');
reset role;
select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.expect_error('admin edits a total directly',
  format('update fee_invoices set total_cents = %s where id = %L', current_setting('t.paid2'), current_setting('t.inv2')), '42501');
select pg_temp.expect_error('admin adjusts a total without a reason',
  format('select adjust_invoice_total(%L, %s, ''  '')', current_setting('t.inv2'), current_setting('t.paid2')), '22023');
select pg_temp.expect_error('admin adjusts a total below what was paid',
  format('select adjust_invoice_total(%L, %s, ''Bursary'')', current_setting('t.inv2'), current_setting('t.paid2')::bigint - 1), '22023');
select adjust_invoice_total(current_setting('t.inv2')::uuid, current_setting('t.paid2')::bigint, 'Bursary');
reset role;
select pg_temp.check('a total lowered to what was paid leaves the invoice paid',
  (select status::text from fee_invoices where id = current_setting('t.inv2')::uuid) = 'paid');
select pg_temp.check('the adjustment is audited once, with the reason and both amounts',
  (select count(*) from audit_events where actor_id = current_setting('t.admin')::uuid
     and event like 'Invoice total for % changed from % to %: Bursary' and metadata->>'invoice_id' = current_setting('t.inv2')) = 1
  and not exists (select 1 from audit_events where event like 'Fee invoice for % changed%' and metadata->>'invoice_id' = current_setting('t.inv2')));
set local role authenticated;
select adjust_invoice_total(current_setting('t.inv2')::uuid, current_setting('t.paid2')::bigint + 1000, 'Bursary withdrawn');
reset role;
select pg_temp.check('a total raised above what was paid leaves it part paid (or overdue)',
  (select status::text = case when due_on < current_date then 'overdue' else 'part_paid' end from fee_invoices where id = current_setting('t.inv2')::uuid));
select set_config('request.jwt.claims', '', true);

do $$ begin
  delete from tenants where id = current_setting('t.a')::uuid;
  raise notice '% removing a whole school still removes its invoices and payments',
    case when not exists (select 1 from payments where invoice_id = current_setting('t.inv')::uuid) then 'PASS' else 'FAIL' end;
exception when others then raise notice 'FAIL removing a whole school: % %', sqlstate, sqlerrm; end $$;

rollback;
