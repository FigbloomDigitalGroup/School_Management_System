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

do $$ begin
  delete from tenants where id = current_setting('t.a')::uuid;
  raise notice '% removing a whole school still removes its invoices and payments',
    case when not exists (select 1 from payments where invoice_id = current_setting('t.inv')::uuid) then 'PASS' else 'FAIL' end;
exception when others then raise notice 'FAIL removing a whole school: % %', sqlstate, sqlerrm; end $$;

rollback;
