-- Money reconciliation (QA 07, FIG-1240): do invoices, payments, charges, the cached organization totals and the audit trail agree?
--
-- Independent of the app: a balance is re-derived from the rows, never from balanceCents, planTermBilling or apply_payment's
-- own arithmetic. Runs as the owner (row-level security does not get in the way) against a local database with the migrations
-- applied and `npm run db:seed` plus `npm run db:seed-org` data, in one transaction that is rolled back. Two parts:
--
--   1. "seed data": every invoice as it is now.
--   2. "scripted payments": eight invoices taken through the real entry points (record_payment, charge_learner,
--      void_fee_charge, a payments row going pending -> success the way mpesa-callback does it, a failed, a cancelled and a
--      timed-out prompt), the same ledger checks on just those, then one audit-trail question per kind of financial change.
--
-- Every check prints PASS, FAIL, or KNOWN <bug> (a defect already filed: it stays KNOWN until fixed, then prints PASS and
-- should become a plain check). Read the live function definitions, not the migration files: this database may be ahead of the
-- branch. Also read the NOT CHECKED lines: they say what this script cannot see.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/reconciliation.sql
-- Check the psql exit code too. Do not run it while e2e is running.

\set ON_ERROR_STOP 1
begin;
-- the setup queries print empty result tables; the results are the NOTICE lines at the end
\o /dev/null

create temp table qa_recon (seq serial, phase text, name text, outcome text, bad bigint, sample text);
-- the invoices a ledger check looks at
create temp table qa_scope (invoice_id uuid primary key);
-- audit rows that existed before the step being asked about
create temp table qa_audit_seen (id uuid primary key);
-- the scripted invoices
create temp table qa_inv (k text primary key, student_id uuid, id uuid);
-- the audit rows the scripted steps wrote, kept to show who / when / what
create temp table qa_audit_log (step text, event text, actor_label text, actor_is_admin boolean, metadata jsonb);

-- One check. p_bad_sql returns one text per offending row; none means PASS.
create function pg_temp.chk(p_phase text, p_name text, p_bad_sql text, p_known text default null) returns void language plpgsql as $$
declare n bigint; s text;
begin
  execute format('select count(*), array_to_string((array_agg(b order by b))[1:3], '' ; '') from (%s) q(b)', p_bad_sql) into n, s;
  insert into qa_recon (phase, name, outcome, bad, sample)
  values (p_phase, p_name, case when n = 0 then 'PASS' when p_known is not null then 'KNOWN ' || p_known else 'FAIL' end, n, s);
end $$;

-- The ledger checks, on whatever invoices are in qa_scope. p_known: a bug tag per check, only used when it finds something.
create function pg_temp.reconcile(p_phase text, p_known jsonb default '{}') returns void language plpgsql as $$
begin
  perform pg_temp.chk(p_phase, 'every invoice: paid_cents = the sum of its successful payments', $q$
    select i.id::text || ' paid ' || i.paid_cents || ', payments add up to ' || coalesce(sum(p.amount_cents) filter (where p.status = 'success'), 0)
      from fee_invoices i join qa_scope s on s.invoice_id = i.id left join payments p on p.invoice_id = i.id
     group by i.id, i.paid_cents
    having i.paid_cents <> coalesce(sum(p.amount_cents) filter (where p.status = 'success'), 0) $q$, p_known ->> 'paid');

  perform pg_temp.chk(p_phase, 'every invoice: charges_cents = the sum of its charges that are not cancelled', $q$
    select i.id::text || ' charges_cents ' || i.charges_cents || ', charge rows add up to ' || coalesce(sum(c.amount_cents) filter (where c.voided_at is null), 0)
      from fee_invoices i join qa_scope s on s.invoice_id = i.id left join fee_charges c on c.invoice_id = i.id
     group by i.id, i.charges_cents
    having i.charges_cents <> coalesce(sum(c.amount_cents) filter (where c.voided_at is null), 0) $q$, p_known ->> 'charges');

  perform pg_temp.chk(p_phase, 'every invoice: status agrees with paid and total (paid / unpaid / part_paid / overdue)', $q$
    select i.id::text || ' is ' || i.status || ' with ' || i.paid_cents || ' paid of ' || i.total_cents
      from fee_invoices i join qa_scope s on s.invoice_id = i.id
     where i.total_cents > 0 and (
           (i.paid_cents >= i.total_cents and i.status <> 'paid')
        or (i.paid_cents < i.total_cents and i.status = 'paid')
        or (i.status = 'unpaid' and i.paid_cents > 0)
        or (i.status = 'part_paid' and (i.paid_cents = 0 or i.paid_cents >= i.total_cents))
        or (i.status = 'overdue' and (i.paid_cents >= i.total_cents or i.due_on >= current_date))) $q$, p_known ->> 'status');

  perform pg_temp.chk(p_phase, 'every invoice past its due date with a balance is marked overdue', $q$
    select i.id::text || ' is ' || i.status || ', due ' || i.due_on
      from fee_invoices i join qa_scope s on s.invoice_id = i.id
     where i.paid_cents < i.total_cents and i.due_on < current_date and i.status <> 'overdue' $q$, p_known ->> 'overdue');

  perform pg_temp.chk(p_phase, 'no invoice is paid beyond its total', $q$
    select i.id::text || ' paid ' || i.paid_cents || ' of ' || i.total_cents
      from fee_invoices i join qa_scope s on s.invoice_id = i.id where i.paid_cents > i.total_cents $q$, p_known ->> 'overpaid');

  perform pg_temp.chk(p_phase, 'no payment without an invoice', $q$
    select p.id::text from payments p left join fee_invoices i on i.id = p.invoice_id where i.id is null $q$);

  perform pg_temp.chk(p_phase, 'no charge or payment proof without an invoice', $q$
    select 'charge ' || c.id from fee_charges c left join fee_invoices i on i.id = c.invoice_id where i.id is null
    union all select 'proof ' || x.id from payment_proofs x left join fee_invoices i on i.id = x.invoice_id where i.id is null $q$);

  perform pg_temp.chk(p_phase, 'every payment is in the same school as its invoice', $q$
    select p.id::text || ' school differs from invoice ' || i.id
      from payments p join qa_scope s on s.invoice_id = p.invoice_id join fee_invoices i on i.id = p.invoice_id where p.tenant_id <> i.tenant_id $q$);

  perform pg_temp.chk(p_phase, 'every invoice is in the same school as its learner and its term', $q$
    select i.id::text || ' learner school ' || coalesce(st.tenant_id::text, 'none') || ', term school ' || coalesce(tm.tenant_id::text, 'none')
      from fee_invoices i join qa_scope s on s.invoice_id = i.id
      left join students st on st.id = i.student_id left join terms tm on tm.id = i.term_id
     where i.tenant_id is distinct from st.tenant_id or i.tenant_id is distinct from tm.tenant_id $q$);

  perform pg_temp.chk(p_phase, 'every charge and payment proof is in the same school (and for the same learner) as its invoice', $q$
    select 'charge ' || c.id from fee_charges c join qa_scope s on s.invoice_id = c.invoice_id join fee_invoices i on i.id = c.invoice_id
     where c.tenant_id <> i.tenant_id or c.student_id <> i.student_id
    union all select 'proof ' || x.id from payment_proofs x join qa_scope s on s.invoice_id = x.invoice_id join fee_invoices i on i.id = x.invoice_id
     where x.tenant_id <> i.tenant_id $q$);

  perform pg_temp.chk(p_phase, 'M-Pesa receipts and checkout ids are unique', $q$
    select 'receipt ' || mpesa_receipt from payments where mpesa_receipt is not null group by mpesa_receipt having count(*) > 1
    union all select 'checkout ' || checkout_request_id from payments where checkout_request_id is not null group by checkout_request_id having count(*) > 1 $q$);

  perform pg_temp.chk(p_phase, 'a bank or cheque reference is not recorded twice on the same invoice', $q$
    select p.invoice_id::text || ' ' || p.method || ' ' || p.reference || ' x' || count(*)
      from payments p join qa_scope s on s.invoice_id = p.invoice_id
     where p.method in ('bank', 'cheque') and p.reference is not null and p.status = 'success'
     group by p.invoice_id, p.method, p.reference having count(*) > 1 $q$, p_known ->> 'duprefs');

  perform pg_temp.chk(p_phase, 'every settled payment has a completion time; every successful one says who or what confirmed it', $q$
    select p.id::text || ' ' || p.method || ' ' || p.status
      from payments p join qa_scope s on s.invoice_id = p.invoice_id
     where (p.status <> 'pending' and p.completed_at is null)
        or (p.status = 'success' and p.method = 'mpesa' and p.mpesa_receipt is null)
        or (p.status = 'success' and p.method <> 'mpesa' and p.recorded_by is null) $q$, p_known ->> 'complete');

  perform pg_temp.chk(p_phase, 'no payment has been left pending for more than a day', $q$
    select p.id::text || ' pending since ' || p.created_at
      from payments p where p.status = 'pending' and p.created_at < now() - interval '1 day' $q$, 'PRODUCTION_TODO (nothing reconciles pending payments)');

  perform pg_temp.chk(p_phase, 'organization summary: fees billed / collected equal the live sums of the school''s invoices', $q$
    select s.tenant_id::text || ' billed ' || s.fees_billed_cents || ' vs ' || x.b || ', collected ' || s.fees_collected_cents || ' vs ' || x.c
      from organization_tenant_summary s
      cross join lateral (select coalesce(sum(total_cents), 0) b, coalesce(sum(paid_cents), 0) c from fee_invoices where tenant_id = s.tenant_id) x
     where s.fees_billed_cents <> x.b or s.fees_collected_cents <> x.c $q$, p_known ->> 'orgsummary');

  -- Only meaningful until a fee item is edited after billing (invoices deliberately keep the totals they were created with), so
  -- it runs on seed data, where nothing has been edited. The rules are written out here, not taken from itemsForStudent():
  -- an item applies to everyone, to boarders, to day learners, or to one year group (and class level, when both name one).
  if p_phase = 'seed data' then
    perform pg_temp.chk(p_phase, 'every invoice: total_cents minus charges = the fee items that apply to the learner (rules written out here)', $q$
      select i.id::text || ' total ' || (i.total_cents - i.charges_cents) || ' but the fee items add up to ' || x.expected
        from fee_invoices i
        join students s on s.id = i.student_id
        left join classes c on c.id = s.class_id
        cross join lateral (
          select coalesce(sum(f.amount_cents), 0) as expected from fee_items f
           where f.term_id = i.term_id and f.tenant_id = i.tenant_id
             and (f.applies_to = 'all'
               or (f.applies_to = 'boarders' and s.boarding)
               or (f.applies_to = 'day' and not s.boarding)
               or (f.applies_to = 'form_level' and f.form_level = c.form_level and (f.level is null or c.level is null or f.level = c.level)))) x
       where i.total_cents - i.charges_cents <> x.expected $q$, p_known ->> 'billing');
  end if;
end $$;

-- ---------------------------------------------------------------- 1. seed data
insert into qa_scope select id from fee_invoices;
-- "complete" and "billing": main's seeds (the load-test school, and bank payments with no recorder) do not follow the rules the product enforces; they are test data
select pg_temp.reconcile('seed data', '{"paid": "FIG-1332", "status": "FIG-1332", "overdue": "FIG-1333", "complete": "seed data, not a product defect", "billing": "seed data, not a product defect"}');

-- The numbers a screen should show for each school's current term, worked out from the rows (taken now, before part 2 changes any).
-- Same definitions the screens use for their headline figures: billed = sum of totals, collected = sum of paid, owing = paid < total.
create temp table qa_totals as
select t.slug, tm.name as term, count(*) as invoices, sum(i.total_cents) as billed, sum(i.paid_cents) as collected,
       count(*) filter (where i.paid_cents < i.total_cents) as owing,
       count(*) filter (where i.paid_cents = 0) as nothing_paid,
       count(*) filter (where i.paid_cents > 0 and i.paid_cents < i.total_cents) as part_paid,
       count(*) filter (where i.paid_cents >= i.total_cents and i.total_cents > 0) as fully_paid,
       coalesce(sum(i.total_cents - i.paid_cents) filter (where i.paid_cents < i.total_cents), 0) as outstanding,
       count(*) filter (where not st.active) as archived_learners
  from fee_invoices i
  join tenants t on t.id = i.tenant_id
  join terms tm on tm.id = i.term_id and tm.is_current
  join students st on st.id = i.student_id
 group by t.slug, tm.name;

-- ---------------------------------------------------------------- 2. scripted payments
-- Acts as a signed-in user for one statement. Returns 'ok', or the SQLSTATE and message when it was refused.
create function pg_temp.act(p_actor uuid, p_sql text) returns text language plpgsql as $$
declare r text := 'ok';
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
    set local role authenticated;
    execute p_sql;
    reset role;
  exception when others then
    r := sqlstate || ' ' || sqlerrm;
  end;
  return r;
end $$;

-- A step the scenario needs to have worked: stop the whole script if it did not.
create function pg_temp.must(p_what text, p_result text) returns void language plpgsql as $$
begin if p_result <> 'ok' then raise exception 'scenario step "%" failed: %', p_what, p_result; end if; end $$;

select set_config('t.a', (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.admin', (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.a')::uuid order by id limit 1), true);
select set_config('t.parent', (select id::text from profiles where role = 'parent' and tenant_id = current_setting('t.a')::uuid order by id limit 1), true);
select set_config('t.term', (select id::text from terms where tenant_id = current_setting('t.a')::uuid and is_current), true);

-- Eight Alliance learners (the 21st to 28th active ones), each given a fresh invoice of 1,000,000 cents
insert into qa_inv (k, student_id)
select v.k, s.id
  from (values ('cash+bank', 21), ('mpesa', 22), ('charge, paid', 23), ('charge, cancelled', 24),
               ('proof', 25), ('past due', 26), ('untouched', 27), ('same slip twice', 28)) v(k, rn)
  join (select id, row_number() over (order by id) rn from students where tenant_id = current_setting('t.a')::uuid and active) s on s.rn = v.rn;
-- the delete guard (20261103300000, FIG-1319) refuses an invoice with money behind it; this setup only resets seeded invoices, in a
-- transaction that is rolled back, so it steps aside for these deletes
alter table fee_invoices disable trigger fee_invoices_guard_delete;
delete from fee_invoices where term_id = current_setting('t.term')::uuid and student_id in (select student_id from qa_inv);
alter table fee_invoices enable trigger fee_invoices_guard_delete;
with ins as (
  insert into fee_invoices (tenant_id, student_id, term_id, total_cents, paid_cents, due_on, status)
  select current_setting('t.a')::uuid, q2.student_id, current_setting('t.term')::uuid, 1000000, 0,
         case when q2.k = 'past due' then current_date - 5 else current_date + 30 end, 'unpaid'
    from qa_inv q2
  returning id, student_id)
update qa_inv q set id = ins.id from ins where ins.student_id = q.student_id;
create function pg_temp.inv(p_k text) returns uuid language sql as $$ select id from qa_inv where k = p_k $$;
create function pg_temp.stu(p_k text) returns uuid language sql as $$ select student_id from qa_inv where k = p_k $$;

-- Everything that already exists in the audit trail is not the scenario's
insert into qa_audit_seen select id from audit_events;

-- One question about the audit trail: how many NEW audit rows did the last step leave, and are they complete?
-- p_expected = 1 means "a financial change must leave exactly one row".
create function pg_temp.audit_after(p_label text, p_expected int, p_known text default null) returns void language plpgsql as $$
declare n int; ev text; incomplete int;
begin
  select count(*), string_agg(event, ' | '),
         count(*) filter (where actor_id is distinct from current_setting('t.admin')::uuid or coalesce(actor_label, '') = ''
                             or category <> 'financial' or created_at is null or tenant_id is distinct from current_setting('t.a')::uuid)
    into n, ev, incomplete
    from audit_events where id not in (select id from qa_audit_seen);
  insert into qa_recon (phase, name, outcome, bad, sample)
  values ('audit trail', p_label,
          case when n = p_expected and incomplete = 0 then 'PASS'
               when p_known is not null then 'KNOWN ' || p_known else 'FAIL' end,
          abs(n - p_expected) + incomplete,
          case when n = 0 then 'no audit event written' else n || ' event(s): ' || ev end);
  insert into qa_audit_log select p_label, event, actor_label, actor_id = current_setting('t.admin')::uuid, metadata from audit_events where id not in (select id from qa_audit_seen);
  insert into qa_audit_seen select id from audit_events on conflict do nothing;
end $$;

-- --- the scripted payments, all through the real entry points
-- 1. cash then bank: paid in full by two payments
select pg_temp.must('cash', pg_temp.act(current_setting('t.admin')::uuid, format('select record_payment(%L, 400000, ''cash'', null)', pg_temp.inv('cash+bank'))));
select pg_temp.audit_after('record_payment: cash', 1);
select pg_temp.must('bank', pg_temp.act(current_setting('t.admin')::uuid, format('select record_payment(%L, 600000, ''bank'', ''QA7-SLIP-1'')', pg_temp.inv('cash+bank'))));
select pg_temp.audit_after('record_payment: bank slip', 1);

-- 2. M-Pesa: one recorded by the office (typed in lower case), one prompt that succeeds, and three that do not
select pg_temp.must('mpesa office', pg_temp.act(current_setting('t.admin')::uuid, format('select record_payment(%L, 250000, ''mpesa'', ''qa7mp1'')', pg_temp.inv('mpesa'))));
select pg_temp.audit_after('record_payment: M-Pesa receipt typed by the office', 1);
insert into payments (tenant_id, invoice_id, amount_cents, method, msisdn, checkout_request_id, status)
  values (current_setting('t.a')::uuid, pg_temp.inv('mpesa'), 300000, 'mpesa', '254700000000', 'ws_QA7_OK', 'pending');
update payments set status = 'success', mpesa_receipt = 'QA7CB1', completed_at = now() where checkout_request_id = 'ws_QA7_OK';
insert into payments (tenant_id, invoice_id, amount_cents, method, msisdn, checkout_request_id, status, failure_reason, completed_at) values
  (current_setting('t.a')::uuid, pg_temp.inv('mpesa'), 100000, 'mpesa', '254700000000', 'ws_QA7_FAILED', 'failed', 'wrong_pin', now()),
  (current_setting('t.a')::uuid, pg_temp.inv('mpesa'), 200000, 'mpesa', '254700000000', 'ws_QA7_CANCELLED', 'cancelled', 'cancelled', now()),
  (current_setting('t.a')::uuid, pg_temp.inv('mpesa'), 50000, 'mpesa', '254700000000', 'ws_QA7_TIMEOUT', 'timeout', 'timeout', now());

-- 3. a charge added, then the whole invoice (with the charge) paid
select pg_temp.must('charge', pg_temp.act(current_setting('t.admin')::uuid, format('select charge_learner(%L, 150000, ''Lost library book'', null)', pg_temp.stu('charge, paid'))));
select pg_temp.audit_after('charge_learner', 1);
select pg_temp.must('pay charged invoice', pg_temp.act(current_setting('t.admin')::uuid, format('select record_payment(%L, 1150000, ''cash'', null)', pg_temp.inv('charge, paid'))));
select pg_temp.audit_after('record_payment: cash, invoice with a charge', 1);

-- 4. a charge added and then cancelled
select pg_temp.must('charge 2', pg_temp.act(current_setting('t.admin')::uuid, format('select charge_learner(%L, 80000, ''Damaged desk'', null)', pg_temp.stu('charge, cancelled'))));
select pg_temp.audit_after('charge_learner (to be cancelled)', 1);
select pg_temp.must('void', pg_temp.act(current_setting('t.admin')::uuid,
  format('select void_fee_charge((select id from fee_charges where invoice_id = %L), ''Charged in error'')', pg_temp.inv('charge, cancelled'))));
select pg_temp.audit_after('void_fee_charge', 1);

-- 5. a payment proof confirmed together with its payment
insert into payment_proofs (tenant_id, invoice_id, uploaded_by, file_path, file_name)
  values (current_setting('t.a')::uuid, pg_temp.inv('proof'), current_setting('t.parent')::uuid, 'x', 'qa7-slip.jpg');
-- the database now logs the upload itself ("Proof of payment sent"); it is not part of what record_payment writes
insert into qa_audit_seen select id from audit_events on conflict do nothing;
select pg_temp.must('proof', pg_temp.act(current_setting('t.admin')::uuid,
  format('select record_payment(%L, 300000, ''bank'', ''QA7-SLIP-2'', (select id from payment_proofs where file_name = ''qa7-slip.jpg''))', pg_temp.inv('proof'))));
select pg_temp.audit_after('record_payment: confirming a payment proof (one event, not two)', 1);

-- 6. an invoice past its due date, part paid
select pg_temp.must('past due', pg_temp.act(current_setting('t.admin')::uuid, format('select record_payment(%L, 200000, ''cash'', null)', pg_temp.inv('past due'))));
select pg_temp.audit_after('record_payment: invoice already past its due date', 1);

-- 8. the same bank slip number typed twice on one invoice (two staff, or one double click)
select pg_temp.must('slip 1', pg_temp.act(current_setting('t.admin')::uuid, format('select record_payment(%L, 100000, ''bank'', ''QA7-DUP-1'')', pg_temp.inv('same slip twice'))));
select pg_temp.audit_after('record_payment: bank slip, first time', 1);
select pg_temp.act(current_setting('t.admin')::uuid, format('select record_payment(%L, 100000, ''bank'', ''QA7-DUP-1'')', pg_temp.inv('same slip twice'))) as second_slip \gset
select pg_temp.audit_after('record_payment: the same bank slip typed a second time', case when :'second_slip' = 'ok' then 1 else 0 end);
\echo the same bank slip typed a second time on one invoice: :second_slip

-- ---- the ledger checks on just these eight
delete from qa_scope;
insert into qa_scope select id from qa_inv;
select pg_temp.reconcile('scripted payments', '{"duprefs": "FIG-1328"}');

-- what the scripts above should have produced, written out by hand
select pg_temp.chk('scripted payments', 'each scripted invoice ends at the paid / total / status written out by hand', $q$
  select e.k || ': expected paid ' || e.paid || ' of ' || e.total || ' ' || e.status || ', found ' || i.paid_cents || ' of ' || i.total_cents || ' ' || i.status
    from (values ('cash+bank', 1000000, 1000000, 'paid'), ('mpesa', 550000, 1000000, 'part_paid'),
                 ('charge, paid', 1150000, 1150000, 'paid'), ('charge, cancelled', 0, 1000000, 'unpaid'),
                 ('proof', 300000, 1000000, 'part_paid'), ('past due', 200000, 1000000, 'overdue'),
                 ('untouched', 0, 1000000, 'unpaid')) e(k, paid, total, status)
    join qa_inv q on q.k = e.k join fee_invoices i on i.id = q.id
   where i.paid_cents <> e.paid or i.total_cents <> e.total or i.status::text <> e.status $q$);

select pg_temp.chk('scripted payments', 'a failed, a cancelled and a timed-out prompt add nothing (only the one that succeeded and the office-typed receipt count)', $q$
  select 'mpesa invoice paid ' || paid_cents from fee_invoices where id = pg_temp.inv('mpesa') and paid_cents <> 250000 + 300000 $q$);

-- ---- direct changes to money, the way an API client (not the app's screens) can make them
-- (the app's own screens only write through the functions above, the billing run and the fee-items editor)
-- FIG-1315 (fixed by 20261103500000): a total can no longer be edited with a plain update; it changes through adjust_invoice_total(),
-- which needs a reason and writes one audit event itself
select pg_temp.act(current_setting('t.admin')::uuid, format('update fee_invoices set total_cents = total_cents + 100000 where id = %L', pg_temp.inv('untouched'))) as direct_total_edit \gset
insert into qa_recon (phase, name, outcome, bad, sample)
values ('audit trail', 'an invoice total cannot be edited directly, only through adjust_invoice_total (FIG-1315, fixed)',
        case when :'direct_total_edit' like '42501%' then 'PASS' else 'FAIL' end,
        case when :'direct_total_edit' like '42501%' then 0 else 1 end, :'direct_total_edit');
select pg_temp.must('adjust total', pg_temp.act(current_setting('t.admin')::uuid, format('select adjust_invoice_total(%L, 1100000, %L)', pg_temp.inv('untouched'), 'QA 7 reconciliation')));
select pg_temp.audit_after('an invoice total adjusted through adjust_invoice_total, with a reason', 1);
select pg_temp.must('edit fee item', pg_temp.act(current_setting('t.admin')::uuid,
  format('update fee_items set amount_cents = amount_cents + 100 where id = (select id from fee_items where tenant_id = %L order by id limit 1)', current_setting('t.a'))));
select pg_temp.audit_after('a fee item''s amount edited (changes what the next billing run charges)', 1, 'FIG-1329');
select pg_temp.must('add fee item', pg_temp.act(current_setting('t.admin')::uuid,
  format('insert into fee_items (tenant_id, term_id, name, amount_cents, applies_to) values (%L, %L, ''QA7 levy'', 50000, ''all'')', current_setting('t.a'), current_setting('t.term'))));
select pg_temp.audit_after('a fee item added', 1, 'FIG-1329');
select pg_temp.must('delete fee item', pg_temp.act(current_setting('t.admin')::uuid, format('delete from fee_items where tenant_id = %L and name = ''QA7 levy''', current_setting('t.a'))));
select pg_temp.audit_after('a fee item deleted', 1, 'FIG-1329');
select pg_temp.must('payment methods', pg_temp.act(current_setting('t.admin')::uuid,
  format('select set_school_payment_methods(%L, ''999999'', ''888888'', ''Bank X, account 123'', ''QA7'')', current_setting('t.a'))));
select pg_temp.audit_after('the paybill / till / bank details parents are told to pay into, changed', 1, 'FIG-1330');

-- the billing run's own write: it upserts invoices as the signed-in admin, then the BROWSER asks for an audit event
select set_config('t.billed_student', (select id::text from (select id, row_number() over (order by id) rn from students
  where tenant_id = current_setting('t.a')::uuid and active) s where rn = 29), true);
alter table fee_invoices disable trigger fee_invoices_guard_delete;
delete from fee_invoices where term_id = current_setting('t.term')::uuid and student_id = current_setting('t.billed_student')::uuid;
alter table fee_invoices enable trigger fee_invoices_guard_delete;
select pg_temp.must('billing insert', pg_temp.act(current_setting('t.admin')::uuid,
  format('insert into fee_invoices (tenant_id, student_id, term_id, total_cents, due_on) values (%L, %L, %L, 500000, current_date + 30)',
         current_setting('t.a'), current_setting('t.billed_student'), current_setting('t.term'))));
select pg_temp.audit_after('invoices created by the billing run''s own insert (the audit event comes from the browser afterwards)', 1, 'FIG-1331');

-- FIG-1319 (fixed by 20261103300000): an invoice with money behind it can no longer be deleted, so the payments and proofs that hang
-- off it are not erased with it. This used to be a scenario step that deleted the invoice and checked the audit trail.
select pg_temp.act(current_setting('t.admin')::uuid, format('delete from fee_invoices where id = %L', pg_temp.inv('same slip twice'))) as inv_delete \gset
insert into qa_recon (phase, name, outcome, bad, sample)
values ('audit trail', 'an invoice that has payments cannot be deleted (FIG-1319, fixed)',
        case when :'inv_delete' like '23001%'
                  and exists (select 1 from fee_invoices where id = pg_temp.inv('same slip twice'))
                  and exists (select 1 from payments where invoice_id = pg_temp.inv('same slip twice')) then 'PASS' else 'FAIL' end,
        case when :'inv_delete' like '23001%' then 0 else 1 end, :'inv_delete');

-- the audit trail itself: an admin can read it but not edit or remove it
select count(*) as audit_rows_before from audit_events where tenant_id = current_setting('t.a')::uuid \gset
select pg_temp.act(current_setting('t.admin')::uuid, format('update audit_events set event = ''edited'' where tenant_id = %L', current_setting('t.a'))) as audit_update \gset
select pg_temp.act(current_setting('t.admin')::uuid, format('delete from audit_events where tenant_id = %L and event like ''Cash payment recorded%%''', current_setting('t.a'))) as audit_delete \gset
select pg_temp.chk('audit trail', 'a school admin cannot edit or delete audit events', format($q$
  select 'rows ' || (select count(*) from audit_events where tenant_id = %L) || ' (was %s), edited ' || (select count(*) from audit_events where event = 'edited')
   where (select count(*) from audit_events where tenant_id = %L) <> %s or exists (select 1 from audit_events where event = 'edited') $q$,
  current_setting('t.a'), :'audit_rows_before', current_setting('t.a'), :'audit_rows_before'));

-- what this script cannot see
insert into qa_recon (phase, name, outcome, bad, sample) values
  ('not checked', 'the audit event mpesa-callback writes when a prompt succeeds: it is written by the edge function, not the database (tested in supabase/functions/mpesa-callback)', 'NOT CHECKED', 0, null),
  ('not checked', 'what the screens show for the same data (admin Fees, Dashboard, Reports, People, parent and student Fees): see e2e/reconciliation.spec.ts', 'NOT CHECKED', 0, null),
  ('not checked', 'Figbloom''s own platform_invoices and plan prices (the platform console), which are a different ledger', 'NOT CHECKED', 0, null);

\o
do $$
declare r record;
begin
  for r in select phase, name, outcome, bad, sample from qa_recon order by seq loop
    raise notice '% [%] % %', case when length(r.outcome) < 8 then rpad(r.outcome, 8) else r.outcome end, r.phase, r.name,
      case when r.bad > 0 or r.outcome = 'NOT CHECKED' then coalesce('(' || nullif(r.bad::text, '0') || ' rows, e.g. ' || r.sample || ')', '') else '' end;
  end loop;
  for r in select * from qa_audit_log order by step loop
    raise notice 'AUDIT ROW [%] "%" by % (admin: %), metadata %', r.step, r.event, r.actor_label, r.actor_is_admin, r.metadata;
  end loop;
  for r in select * from qa_totals order by slug loop
    raise notice 'TOTALS % %: % invoices, billed %, collected %, owing % (outstanding %), nothing paid %, part paid %, fully paid %, archived learners'' invoices %',
      r.slug, r.term, r.invoices, r.billed, r.collected, r.owing, r.outstanding, r.nothing_paid, r.part_paid, r.fully_paid, r.archived_learners;
  end loop;
  raise notice 'SUMMARY: % PASS, % FAIL, % KNOWN, % NOT CHECKED',
    (select count(*) from qa_recon where outcome = 'PASS'), (select count(*) from qa_recon where outcome = 'FAIL'),
    (select count(*) from qa_recon where outcome like 'KNOWN%'), (select count(*) from qa_recon where outcome = 'NOT CHECKED');
end $$;

rollback;
