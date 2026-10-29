-- Fee collection checks for 20261022000001 (record_payment, the paid_cents
-- guard, log_admin_event) and the billing run's insert.
--
-- Runs against a local database that has the migrations applied and
-- `npm run db:seed` data, inside one transaction that is rolled back.
-- Every check prints PASS or FAIL. A KNOWN line is a defect already filed (its tag names the bug): it stays KNOWN until
-- the behaviour is fixed, then prints PASS and should be turned into a plain check.
-- Read the live function definitions, not the migration files: main's admin-areas work changed record_payment to has_perm(..., 'fees').
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/fees.sql

\set ON_ERROR_STOP 1
begin;

select set_config('t.a',       (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.admin',   (select id::text from profiles where role = 'school_admin' and tenant_id = (select id from tenants where slug = 'alliance') limit 1), true);
select set_config('t.parent',  (select id::text from profiles where role = 'parent' and tenant_id = (select id from tenants where slug = 'alliance') limit 1), true);
select set_config('t.teacher', (select id::text from profiles where role = 'teacher' and tenant_id = (select id from tenants where slug = 'alliance') limit 1), true);
-- Alliance's invoices only: other seeded schools (npm run db:seed-org adds one) have invoices too,
-- and the Alliance admin acting below cannot see theirs.
select set_config('t.inv', (select id::text from fee_invoices where tenant_id = current_setting('t.a')::uuid and paid_cents < total_cents and paid_cents = 0 order by id limit 1), true);
select set_config('t.inv2', (select id::text from fee_invoices where tenant_id = current_setting('t.a')::uuid and paid_cents < total_cents and id::text <> current_setting('t.inv') order by id limit 1), true);
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

-- ---------------------------------------------------------------- QA 05 (FIG-1238): the money maths, worked by hand
-- Invoices of 1,000,000 cents (KSh 10,000) due in 2031, so "overdue" never gets in the way. They are created as the owner
-- (no jwt): the guard lets the service role through, and an invoice must start with nothing paid.
create function pg_temp.known(label text, tag text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when ok then 'PASS (the gap is closed: turn this into a plain check)' else 'KNOWN ' || tag || ' (open)' end, label; end $$;
grant execute on all functions in schema pg_temp to authenticated;

select set_config('request.jwt.claims', '', true);
insert into fee_invoices (tenant_id, student_id, term_id, total_cents, due_on)
  select current_setting('t.a')::uuid, s.id, current_setting('t.term')::uuid, 1000000, '2031-12-31'
    from (select id from students where tenant_id = current_setting('t.a')::uuid order by id offset 2 limit 6) s;
select set_config('t.u', (select id::text from fee_invoices where term_id = current_setting('t.term')::uuid and total_cents = 1000000 order by id offset 5 limit 1), true);
select set_config('t.x', (select id::text from fee_invoices where term_id = current_setting('t.term')::uuid and total_cents = 1000000 order by id offset 0 limit 1), true);
select set_config('t.y', (select id::text from fee_invoices where term_id = current_setting('t.term')::uuid and total_cents = 1000000 order by id offset 1 limit 1), true);
select set_config('t.z', (select id::text from fee_invoices where term_id = current_setting('t.term')::uuid and total_cents = 1000000 order by id offset 2 limit 1), true);
select set_config('t.w', (select id::text from fee_invoices where term_id = current_setting('t.term')::uuid and total_cents = 1000000 order by id offset 3 limit 1), true);
select set_config('t.v', (select id::text from fee_invoices where term_id = current_setting('t.term')::uuid and total_cents = 1000000 order by id offset 4 limit 1), true);

select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.admin'), 'role', 'authenticated')::text, true);
set local role authenticated;

-- partial, then exact: unpaid -> part_paid -> paid, against numbers worked out by hand
select record_payment(current_setting('t.x')::uuid, 400000, 'cash', null);
select pg_temp.check('400,000 of 1,000,000 paid: paid_cents 400,000 and status part_paid',
  (select paid_cents = 400000 and status::text = 'part_paid' from fee_invoices where id = current_setting('t.x')::uuid));
select record_payment(current_setting('t.x')::uuid, 600000, 'bank', 'SLIP-Q2');
select pg_temp.check('the other 600,000 clears it: paid_cents 1,000,000 and status paid',
  (select paid_cents = 1000000 and status::text = 'paid' from fee_invoices where id = current_setting('t.x')::uuid));
select pg_temp.expect_error('one more cent on a paid invoice',
  format('select record_payment(%L, 1, ''cash'', null)', current_setting('t.x')), '22023');

-- zero, negative, missing, one cent over, the largest bigint: all refused, and nothing moves
select pg_temp.expect_error('zero', format('select record_payment(%L, 0, ''cash'', null)', current_setting('t.y')), '22023');
select pg_temp.expect_error('negative', format('select record_payment(%L, -500, ''cash'', null)', current_setting('t.y')), '22023');
select pg_temp.expect_error('no amount', format('select record_payment(%L, null, ''cash'', null)', current_setting('t.y')), '22023');
select pg_temp.expect_error('one cent over the balance', format('select record_payment(%L, 1000001, ''cash'', null)', current_setting('t.y')), '22023');
select pg_temp.expect_error('the largest bigint', format('select record_payment(%L, 9223372036854775807, ''cash'', null)', current_setting('t.y')), '22023');
select pg_temp.expect_error('cheque without a number', format('select record_payment(%L, 1000, ''cheque'', null)', current_setting('t.y')), '22023');
select pg_temp.expect_error('M-Pesa without a code', format('select record_payment(%L, 1000, ''mpesa'', '' '')', current_setting('t.y')), '22023');
select pg_temp.check('none of those refusals moved the invoice',
  (select paid_cents = 0 and status::text = 'unpaid' from fee_invoices where id = current_setting('t.y')::uuid));

-- every method on one invoice: cash 100,000 + M-Pesa 200,000 + bank 300,000 + cheque 400,000 = 1,000,000
select record_payment(current_setting('t.y')::uuid, 100000, 'cash', '   ');
select record_payment(current_setting('t.y')::uuid, 200000, 'mpesa', 'qa5mp1');
select record_payment(current_setting('t.y')::uuid, 300000, 'bank', 'BNK-1');
select record_payment(current_setting('t.y')::uuid, 400000, 'cheque', 'CHQ-1');
select pg_temp.check('four methods add up to the whole invoice and it is paid',
  (select paid_cents = 1000000 and status::text = 'paid' from fee_invoices where id = current_setting('t.y')::uuid));
select pg_temp.check('each method is stored as recorded: amount, method, reference',
  (select string_agg(method::text || ':' || amount_cents || ':' || coalesce(reference, '-'), ' ' order by amount_cents) from payments where invoice_id = current_setting('t.y')::uuid)
    = 'cash:100000:- mpesa:200000:QA5MP1 bank:300000:BNK-1 cheque:400000:CHQ-1');
select pg_temp.check('only the M-Pesa payment fills mpesa_receipt, in capitals',
  (select string_agg(coalesce(mpesa_receipt, '-'), ' ' order by amount_cents) from payments where invoice_id = current_setting('t.y')::uuid) = '- QA5MP1 - -');
select pg_temp.check('every recorded payment is a success entered by the admin',
  (select bool_and(status::text = 'success' and recorded_by = current_setting('t.admin')::uuid) from payments where invoice_id = current_setting('t.y')::uuid));
select pg_temp.check('payments add up to paid_cents on both invoices (the ledger reconciles)',
  (select count(*) = 2 and bool_and(i.paid_cents = (select coalesce(sum(p.amount_cents), 0) from payments p where p.invoice_id = i.id and p.status::text = 'success'))
     from fee_invoices i where i.id in (current_setting('t.x')::uuid, current_setting('t.y')::uuid)));
select pg_temp.expect_error('the same M-Pesa code on another invoice, in lower case',
  format('select record_payment(%L, 1000, ''mpesa'', ''qa5mp1'')', current_setting('t.z')), '23505');

-- a client cannot write payments directly: RLS has no write policy (20261021000002_payments_server_only)
select pg_temp.expect_error('admin inserts a payment row',
  format('insert into payments (tenant_id, invoice_id, amount_cents, method, status) values (%L, %L, 1000, ''cash'', ''success'')', current_setting('t.a'), current_setting('t.z')), '42501');
do $$ declare n int; begin
  update payments set amount_cents = 1 where invoice_id = current_setting('t.y')::uuid; get diagnostics n = row_count;
  raise notice '% admin edits a payment: % row(s) changed', case when n = 0 then 'PASS' else 'FAIL' end, n;
  delete from payments where invoice_id = current_setting('t.y')::uuid; get diagnostics n = row_count;
  raise notice '% admin deletes a payment: % row(s) removed', case when n = 0 then 'PASS' else 'FAIL' end, n;
end $$;
select pg_temp.check('the payments are all still there, unchanged',
  (select count(*) = 4 and sum(amount_cents) = 1000000 from payments where invoice_id = current_setting('t.y')::uuid));

-- ---- KNOWN gaps found by QA 05. They are neither PASS nor FAIL: they print KNOWN while the behaviour is wrong and PASS once fixed.
-- FIG-1315: the office can hand-edit total_cents. Nothing recomputes the status and nothing is written to the audit log.
select record_payment(current_setting('t.z')::uuid, 400000, 'cash', null);
select set_config('t.audit0', (select count(*)::text from audit_events where tenant_id = current_setting('t.a')::uuid), true);
update fee_invoices set total_cents = 400000 where id = current_setting('t.z')::uuid;
select pg_temp.known('total_cents lowered to what is paid: the status follows the balance (paid)', 'FIG-1315',
  (select status::text = 'paid' from fee_invoices where id = current_setting('t.z')::uuid));
select pg_temp.known('a hand edit of total_cents leaves an audit event', 'FIG-1315',
  (select count(*) from audit_events where tenant_id = current_setting('t.a')::uuid) > current_setting('t.audit0')::int);
-- FIG-1319: an invoice with payments can be deleted, and its payments go with it (ON DELETE CASCADE).
select record_payment(current_setting('t.w')::uuid, 250000, 'cash', null);
select set_config('t.audit1', (select count(*)::text from audit_events where tenant_id = current_setting('t.a')::uuid), true);
do $$ declare refused boolean := false; begin
  begin delete from fee_invoices where id = current_setting('t.w')::uuid; exception when others then refused := true; end;
  perform pg_temp.known('deleting an invoice that has payments is refused, or at least leaves an audit event', 'FIG-1319',
    refused or (select count(*) from audit_events where tenant_id = current_setting('t.a')::uuid) > current_setting('t.audit1')::int);
end $$;
reset role;
select pg_temp.known('the payment of a deleted invoice is not silently erased', 'FIG-1319',
  exists (select 1 from fee_invoices where id = current_setting('t.w')::uuid) or exists (select 1 from payments where invoice_id = current_setting('t.w')::uuid));

-- ---- who may record: the "fees" area, not the role (record_payment checks has_perm(tenant, 'fees'), main's 20261031000001)
select set_config('t.staff', coalesce((select id::text from profiles where role = 'staff' and tenant_id = current_setting('t.a')::uuid order by id limit 1), ''), true);
select pg_temp.check('control: the seed has a staff member to test with', current_setting('t.staff') <> '');
select set_config('request.jwt.claims', json_build_object('sub', current_setting('t.staff'), 'role', 'authenticated')::text, true);
set local role authenticated;
select pg_temp.expect_error('a staff member without the fees area records a payment',
  format('select record_payment(%L, 1000, ''cash'', null)', current_setting('t.u')), '42501');
reset role;
insert into staff_permissions (tenant_id, profile_id, area, granted_by)
  values (current_setting('t.a')::uuid, current_setting('t.staff')::uuid, 'fees', current_setting('t.admin')::uuid);
set local role authenticated;
select record_payment(current_setting('t.u')::uuid, 1000, 'cash', null);
select pg_temp.check('the same staff member, once given the fees area, records a payment',
  (select paid_cents = 1000 and status::text = 'part_paid' from fee_invoices where id = current_setting('t.u')::uuid));
reset role;
delete from staff_permissions where profile_id = current_setting('t.staff')::uuid and area = 'fees';
set local role authenticated;
select pg_temp.expect_error('and when the area is taken away again, at once',
  format('select record_payment(%L, 1000, ''cash'', null)', current_setting('t.u')), '42501');
reset role;

-- ---- the M-Pesa callback path (service role: no jwt) credits through the same trigger
select set_config('request.jwt.claims', '', true);
insert into payments (tenant_id, invoice_id, amount_cents, method, status, checkout_request_id) values
  (current_setting('t.a')::uuid, current_setting('t.v')::uuid, 1000000, 'mpesa', 'pending', 'qa5_a'),
  (current_setting('t.a')::uuid, current_setting('t.v')::uuid, 1000000, 'mpesa', 'pending', 'qa5_b');
update payments set status = 'success', mpesa_receipt = 'QA5AAAA' where checkout_request_id = 'qa5_a';
select pg_temp.check('a successful callback for the full balance pays the invoice',
  (select paid_cents = 1000000 and status::text = 'paid' from fee_invoices where id = current_setting('t.v')::uuid));
update payments set status = 'success' where checkout_request_id = 'qa5_a';
select pg_temp.check('the same callback delivered again does not credit twice',
  (select paid_cents = 1000000 from fee_invoices where id = current_setting('t.v')::uuid));
-- FIG-1316: a second prompt for the same balance also succeeds. Nothing caps or records the excess.
update payments set status = 'success', mpesa_receipt = 'QA5BBBB' where checkout_request_id = 'qa5_b';
select pg_temp.known('a second full-balance prompt cannot push paid_cents above total_cents', 'FIG-1316',
  (select paid_cents <= total_cents from fee_invoices where id = current_setting('t.v')::uuid));
do $$ declare p bigint; t bigint; begin
  select paid_cents, total_cents into p, t from fee_invoices where id = current_setting('t.v')::uuid;
  raise notice 'INFO callback path: paid_cents % on a total of % (excess %), status %, and no record of the excess', p, t, p - t,
    (select status from fee_invoices where id = current_setting('t.v')::uuid);
end $$;

rollback;
