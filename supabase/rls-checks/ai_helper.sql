-- Study helper opt-in checks for 20261101100000_ai_helper_optin: who may
-- change a learner's opt-in, who reads it, what ai_helper_allowed answers,
-- that billing can't be turned on, and (with billing switched on by hand
-- inside this transaction) that the billing path charges, stays idempotent,
-- cancels before the cut-off and keeps the charge after it.
--
-- Runs against a local database that has the migrations applied, inside one
-- transaction that is rolled back. It makes its own two schools and people
-- (no seed data needed). Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/ai_helper.sql

\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------- helpers
create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when coalesce(ok, false) then 'PASS' else 'FAIL' end, label; end $$;
create function pg_temp.expect_eq(label text, actual text, expected text) returns void language plpgsql as $$
begin
  if actual is not distinct from expected then raise notice 'PASS %', label;
  else raise notice 'FAIL %: got %, expected %', label, actual, expected; end if;
end $$;
create function pg_temp.expect_error(label text, stmt text, errcode text) returns void language plpgsql as $$
begin
  begin execute stmt; raise notice 'FAIL %: allowed', label;
  exception when others then
    if sqlstate = errcode then raise notice 'PASS % (%)', label, sqlerrm;
    else raise notice 'FAIL %: % %', label, sqlstate, sqlerrm; end if;
  end;
end $$;
create function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true)
$$;
-- set_ai_helper_optin as someone, answering what it returned (or the error's SQLSTATE).
create function pg_temp.optin(p_who text, p_student text, p_on boolean) returns text language plpgsql as $$
declare v text;
begin
  perform pg_temp.act_as(current_setting('t.' || p_who));
  begin
    execute 'set local role authenticated';
    v := set_ai_helper_optin(current_setting('t.' || p_student)::uuid, p_on);
    execute 'reset role';
  exception when others then
    execute 'reset role';
    return 'error ' || sqlstate;
  end;
  return v;
end $$;
create function pg_temp.allowed(p_profile text) returns text language sql as $$
  select coalesce(ai_helper_allowed(current_setting('t.' || p_profile)::uuid)->>'code', 'allowed')
$$;
create function pg_temp.invoice_total() returns bigint language sql as $$
  select total_cents from fee_invoices where id = current_setting('t.invoice')::uuid
$$;
create function pg_temp.standing_charges() returns bigint language sql as $$
  select count(*) from fee_charges where student_id = current_setting('t.student')::uuid and voided_at is null
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------- fixtures (as postgres)
create function pg_temp.person(p_key text, p_tenant uuid, p_role app_role, p_name text) returns uuid language plpgsql as $$
declare v uuid := gen_random_uuid();
begin
  insert into auth.users (id, email) values (v, 'helper-check-' || p_key || '-' || v || '@example.invalid');
  insert into profiles (id, tenant_id, role, full_name) values (v, p_tenant, p_role, p_name);
  perform set_config('t.' || p_key, v::text, true);
  return v;
end $$;

with x as (
  insert into tenants (name, slug, county, ai_tutor_enabled) values ('Helper Check School', 'helper-check-a-' || substr(md5(random()::text), 1, 8), 'Nairobi', true) returning id
) select set_config('t.a', x.id::text, true) from x;
with x as (
  insert into tenants (name, slug, county, ai_tutor_enabled) values ('Helper Check Other School', 'helper-check-b-' || substr(md5(random()::text), 1, 8), 'Nairobi', true) returning id
) select set_config('t.b', x.id::text, true) from x;

select pg_temp.person('admin',   current_setting('t.a')::uuid, 'school_admin', 'Check Principal');
select pg_temp.person('bursar',  current_setting('t.a')::uuid, 'staff',        'Check Bursar');
select pg_temp.person('teacher', current_setting('t.a')::uuid, 'teacher',      'Check Teacher');
select pg_temp.person('mum',     current_setting('t.a')::uuid, 'parent',       'Check Mum');
select pg_temp.person('dad',     current_setting('t.a')::uuid, 'parent',       'Check Dad');
select pg_temp.person('stranger', current_setting('t.a')::uuid, 'parent',      'Check Other Parent');
select pg_temp.person('learner', current_setting('t.a')::uuid, 'student',      'Check Learner');
select pg_temp.person('away',    current_setting('t.b')::uuid, 'parent',       'Check Other-School Parent');
insert into staff_permissions (tenant_id, profile_id, area) values (current_setting('t.a')::uuid, current_setting('t.bursar')::uuid, 'fees');

with x as (
  insert into terms (tenant_id, name, year, index, starts_on, ends_on, is_current)
  values (current_setting('t.a')::uuid, 'Check Term 3', 2026, 3, '2026-09-01', '2026-11-30', true) returning id
) select set_config('t.term', x.id::text, true) from x;
with x as (
  insert into classes (tenant_id, name, form_level) values (current_setting('t.a')::uuid, 'Check 2 West', 2) returning id
) select set_config('t.class', x.id::text, true) from x;
with x as (
  insert into students (tenant_id, admission_no, full_name, class_id, profile_id)
  values (current_setting('t.a')::uuid, 'HCHK-1', 'Check Learner', current_setting('t.class')::uuid, current_setting('t.learner')::uuid) returning id
) select set_config('t.student', x.id::text, true) from x;
-- the stranger's own child: no invoice this term
with x as (
  insert into students (tenant_id, admission_no, full_name, class_id)
  values (current_setting('t.a')::uuid, 'HCHK-2', 'Check Unbilled Learner', current_setting('t.class')::uuid) returning id
) select set_config('t.student2', x.id::text, true) from x;
insert into guardians (tenant_id, profile_id, student_id, relationship) values
  (current_setting('t.a')::uuid, current_setting('t.mum')::uuid, current_setting('t.student')::uuid, 'mother'),
  (current_setting('t.a')::uuid, current_setting('t.dad')::uuid, current_setting('t.student')::uuid, 'father'),
  (current_setting('t.a')::uuid, current_setting('t.stranger')::uuid, current_setting('t.student2')::uuid, 'guardian');
with x as (
  insert into fee_invoices (tenant_id, student_id, term_id, total_cents, due_on)
  values (current_setting('t.a')::uuid, current_setting('t.student')::uuid, current_setting('t.term')::uuid, 1000000, '2099-10-31') returning id
) select set_config('t.invoice', x.id::text, true) from x;
-- this month: three questions and a staff chat; last month: one more question
insert into ai_usage (tenant_id, profile_id, task, model, input_tokens, output_tokens, created_at) values
  (current_setting('t.a')::uuid, current_setting('t.learner')::uuid, 'tutor', 'm', 100, 50, now()),
  (current_setting('t.a')::uuid, current_setting('t.learner')::uuid, 'tutor', 'm', 100, 50, now()),
  (current_setting('t.a')::uuid, current_setting('t.learner')::uuid, 'tutor', 'm', 100, 50, now()),
  (current_setting('t.a')::uuid, current_setting('t.learner')::uuid, 'tutor', 'm', 100, 50, date_trunc('month', now()) - interval '1 day'),
  (current_setting('t.a')::uuid, current_setting('t.teacher')::uuid, 'chat', 'm', 100, 50, now());

-- ---------------------------------------------------------------- defaults: every learner, as before
select pg_temp.expect_eq('a school starts with every learner and no billing',
  (select ai_tutor_access || '/' || ai_helper_billing_enabled from tenants where id = current_setting('t.a')::uuid), 'all/false');
select pg_temp.expect_eq('every learner: the learner may use it, without any opt-in', pg_temp.allowed('learner'), 'allowed');
update tenants set ai_tutor_enabled = false where id = current_setting('t.a')::uuid;
select pg_temp.expect_eq('the study helper switch still turns it off', pg_temp.allowed('learner'), 'school_off');
update tenants set ai_tutor_enabled = true, ai_enabled = false where id = current_setting('t.a')::uuid;
select pg_temp.expect_eq('and so does Bloom being off', pg_temp.allowed('learner'), 'school_off');
update tenants set ai_enabled = true where id = current_setting('t.a')::uuid;
select pg_temp.expect_eq('a parent can''t opt in while it is on for every learner', pg_temp.optin('mum', 'student', true), 'error 22023');

-- ---------------------------------------------------------------- billing can't be turned on
select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
select pg_temp.expect_error('the RPC refuses billing',
  format($q$select set_ai_helper_settings(%L, 'opt_in', 50000, true, 7)$q$, current_setting('t.a')), '0A000');
reset role;
select pg_temp.expect_error('and so does the table, even for postgres',
  format($q$update tenants set ai_helper_billing_enabled = true where id = %L$q$, current_setting('t.a')), '23514');
select pg_temp.check('ai_helper_billing_available() says no', not ai_helper_billing_available());

-- ---------------------------------------------------------------- the settings are full admins only
select pg_temp.act_as(current_setting('t.bursar'));
set local role authenticated;
select pg_temp.expect_error('the fees area can''t change AI settings',
  format($q$select set_ai_helper_settings(%L, 'opt_in', 0, false, 7)$q$, current_setting('t.a')), '42501');
reset role;
select pg_temp.act_as(current_setting('t.teacher'));
set local role authenticated;
select pg_temp.expect_error('nor can a teacher',
  format($q$select set_ai_helper_settings(%L, 'opt_in', 0, false, 7)$q$, current_setting('t.a')), '42501');
reset role;
select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
select pg_temp.expect_error('a bad access mode is refused',
  format($q$select set_ai_helper_settings(%L, 'some', 0, false, 7)$q$, current_setting('t.a')), '22023');
select pg_temp.expect_error('so is a price with too many zeros',
  format($q$select set_ai_helper_settings(%L, 'opt_in', 100000000, false, 7)$q$, current_setting('t.a')), '22023');
select set_ai_helper_settings(current_setting('t.a')::uuid, 'opt_in', 50000, false, 7);
reset role;
select pg_temp.expect_eq('the principal turns on opt-in with a price for later',
  (select ai_tutor_access || '/' || ai_helper_price_cents || '/' || ai_helper_billing_enabled from tenants where id = current_setting('t.a')::uuid),
  'opt_in/50000/false');
select pg_temp.check('the change is in the audit trail',
  exists (select 1 from audit_events where tenant_id = current_setting('t.a')::uuid and event like 'Study helper for learners whose parent%'));

-- ---------------------------------------------------------------- opt-in: who may change it
select pg_temp.expect_eq('opt-in: the learner needs a parent to turn it on', pg_temp.allowed('learner'), 'needs_optin');
select pg_temp.expect_eq('another parent at the school can''t turn it on', pg_temp.optin('stranger', 'student', true), 'error 42501');
select pg_temp.expect_eq('a parent at another school can''t', pg_temp.optin('away', 'student', true), 'error 42501');
select pg_temp.expect_eq('the learner can''t turn it on for themselves', pg_temp.optin('learner', 'student', true), 'error 42501');
select pg_temp.expect_eq('a teacher can''t', pg_temp.optin('teacher', 'student', true), 'error 42501');
select pg_temp.expect_eq('nor the principal: it is the family''s choice', pg_temp.optin('admin', 'student', true), 'error 42501');

select pg_temp.expect_eq('mum turns it on', pg_temp.optin('mum', 'student', true), 'on');
select pg_temp.expect_eq('now the learner may use it', pg_temp.allowed('learner'), 'allowed');
select pg_temp.check('the row says mum turned it on, in this term',
  (select turned_on_by::text = current_setting('t.mum') and changed_by::text = current_setting('t.mum') and term_id::text = current_setting('t.term')
     from ai_helper_optins where student_id = current_setting('t.student')::uuid));
select pg_temp.check('with billing off nobody is charged',
  pg_temp.invoice_total() = 1000000 and pg_temp.standing_charges() = 0);
select pg_temp.expect_eq('turning it on again records nothing new', pg_temp.optin('mum', 'student', true), 'on');
select pg_temp.expect_eq('dad turns it off', pg_temp.optin('dad', 'student', false), 'off');
select pg_temp.check('dad changed it; mum still shows as who turned it on',
  (select changed_by::text = current_setting('t.dad') and turned_on_by::text = current_setting('t.mum')
     from ai_helper_optins where student_id = current_setting('t.student')::uuid));
select pg_temp.expect_eq('and the learner is back to asking a parent', pg_temp.allowed('learner'), 'needs_optin');
select pg_temp.expect_eq('either guardian may turn it back on', pg_temp.optin('dad', 'student', true), 'on');
select pg_temp.expect_eq('every change is logged with who made it',
  (select string_agg(status || ':' || (select full_name from profiles where id = changed_by), ',' order by changed_at, id)
     from ai_helper_optin_log where student_id = current_setting('t.student')::uuid),
  'on:Check Mum,off:Check Dad,on:Check Dad');
with x as (
  insert into subjects (tenant_id, name, code) values (current_setting('t.a')::uuid, 'Check Maths', 'HCHKM') returning id
), p as (
  insert into exam_papers (tenant_id, title, class_id, subject_id, mode, opens_at, closes_at, duration_minutes, published_at)
  select current_setting('t.a')::uuid, 'Check open exam', current_setting('t.class')::uuid, x.id, 'online',
         now() - interval '10 minutes', now() + interval '1 hour', 60, now() - interval '1 hour' from x
  returning id
) select set_config('t.paper', p.id::text, true) from p;
select pg_temp.expect_eq('an open exam still turns it off for an opted-in learner', pg_temp.allowed('learner'), 'exam');
delete from exam_papers where id = current_setting('t.paper')::uuid;
update tenants set ai_tutor_enabled = false where id = current_setting('t.a')::uuid;
select pg_temp.expect_eq('the school switching it off wins over an opt-in', pg_temp.allowed('learner'), 'school_off');
select pg_temp.expect_eq('turning it off still works while the school has it off', pg_temp.optin('stranger', 'student2', false), 'off');
select pg_temp.expect_eq('turning it on doesn''t', pg_temp.optin('stranger', 'student2', true), 'error 22023');
update tenants set ai_tutor_enabled = true where id = current_setting('t.a')::uuid;

-- ---------------------------------------------------------------- who reads it
select pg_temp.act_as(current_setting('t.mum'));
set local role authenticated;
select pg_temp.expect_eq('mum reads her child''s status, who last turned it on and this month''s questions',
  (select status || '/' || active || '/' || questions_this_month || '/' || turned_on_by_name from ai_helper_status(current_setting('t.student')::uuid)),
  'on/true/3/Check Dad');
select pg_temp.expect_eq('and the opt-in row and its log', (select count(*)::text from ai_helper_optins) || '/' || (select count(*)::text from ai_helper_optin_log), '1/3');
select pg_temp.expect_error('she can''t write the table directly',
  format($q$insert into ai_helper_optins (tenant_id, student_id, status) values (%L, %L, 'on')$q$, current_setting('t.a'), current_setting('t.student2')), '42501');
select pg_temp.expect_eq('nor see the office roster', (select count(*)::text from ai_helper_roster(current_setting('t.a')::uuid)), '0');
reset role;
select pg_temp.act_as(current_setting('t.stranger'));
set local role authenticated;
select pg_temp.expect_eq('another parent sees nothing of that child',
  (select count(*)::text from ai_helper_status(current_setting('t.student')::uuid)) || '/' ||
  (select count(*)::text from ai_helper_optins where student_id = current_setting('t.student')::uuid), '0/0');
reset role;
select pg_temp.act_as(current_setting('t.learner'));
set local role authenticated;
select pg_temp.expect_eq('the learner reads their own (no id needed)',
  (select status || '/' || active from ai_helper_status(null)), 'on/true');
reset role;
select pg_temp.act_as(current_setting('t.teacher'));
set local role authenticated;
select pg_temp.expect_eq('a teacher without the fees area sees neither',
  (select count(*)::text from ai_helper_status(current_setting('t.student')::uuid)) || '/' ||
  (select count(*)::text from ai_helper_roster(current_setting('t.a')::uuid)), '0/0');
reset role;
select pg_temp.act_as(current_setting('t.bursar'));
set local role authenticated;
select pg_temp.expect_eq('the bursar (fees area) sees the roster: who, by whom, and use',
  (select string_agg(full_name || '/' || coalesce(status, '-') || '/' || coalesce(turned_on_by_name, '-') || '/' || questions_this_month || '/' || tokens_this_month, ',' order by full_name)
     from ai_helper_roster(current_setting('t.a')::uuid)),
  'Check Learner/on/Check Dad/3/450,Check Unbilled Learner/off/-/0/0');
reset role;
select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
select pg_temp.expect_eq('and so does the principal', (select count(*)::text from ai_helper_roster(current_setting('t.a')::uuid)), '2');
select pg_temp.expect_eq('but not another school''s', (select count(*)::text from ai_helper_roster(current_setting('t.b')::uuid)), '0');
reset role;

-- ---------------------------------------------------------------- billing, switched on by hand for this transaction only
-- What the migration that turns billing on does: the function says yes and the constraint goes.
alter table tenants drop constraint tenants_ai_helper_billing_off;
create or replace function ai_helper_billing_available() returns boolean language sql immutable set search_path = public as $$ select true $$;
select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
select set_ai_helper_settings(current_setting('t.a')::uuid, 'opt_in', 50000, true, 7);
reset role;
select pg_temp.check('the school bills KES 500 a term for it', (select ai_helper_billing_enabled from tenants where id = current_setting('t.a')::uuid));

select pg_temp.expect_eq('an opt-in from before billing still counts this term', pg_temp.allowed('learner'), 'allowed');
select pg_temp.expect_eq('turned off with nothing charged: nothing to cancel', pg_temp.optin('mum', 'student', false), 'nothing_to_cancel');
select pg_temp.expect_eq('turned on: charged', pg_temp.optin('mum', 'student', true), 'charged');
select pg_temp.check('the invoice total and charges went up by the price',
  (select total_cents = 1050000 and charges_cents = 50000 from fee_invoices where id = current_setting('t.invoice')::uuid));
select pg_temp.expect_eq('labelled for the family''s statement',
  (select reason from fee_charges where student_id = current_setting('t.student')::uuid and voided_at is null), 'Bloom study helper, Term 3');
select pg_temp.expect_eq('the bill run again for the same term charges nothing more',
  ai_helper_bill_optin((select id from ai_helper_optins where student_id = current_setting('t.student')::uuid)), 'already_charged');
select pg_temp.check('one standing charge', pg_temp.standing_charges() = 1 and pg_temp.invoice_total() = 1050000);
select pg_temp.act_as(current_setting('t.mum'));
set local role authenticated;
select pg_temp.expect_eq('mum sees the charge on the status and on the invoice',
  (select charge_cents::text from ai_helper_status(current_setting('t.student')::uuid)) || '/' ||
  (select count(*)::text from fee_charges where invoice_id = current_setting('t.invoice')::uuid), '50000/1');
reset role;

select pg_temp.expect_eq('dad turns it off before the cut-off: cancelled', pg_temp.optin('dad', 'student', false), 'cancelled');
select pg_temp.check('the invoice is back to the fees alone', pg_temp.invoice_total() = 1000000 and pg_temp.standing_charges() = 0);
select pg_temp.expect_eq('on again: charged afresh', pg_temp.optin('dad', 'student', true), 'charged');
select pg_temp.check('still one standing charge, and the link points at it',
  pg_temp.standing_charges() = 1
  and (select c.voided_at is null from ai_helper_charges hc join fee_charges c on c.id = hc.charge_id
        where hc.student_id = current_setting('t.student')::uuid and hc.term_id = current_setting('t.term')::uuid));

update fee_charges set created_at = now() - interval '8 days'
 where student_id = current_setting('t.student')::uuid and voided_at is null;
select pg_temp.expect_eq('turned off after the cut-off: the helper goes off, the charge stays', pg_temp.optin('mum', 'student', false), 'kept');
select pg_temp.check('charge still standing', pg_temp.standing_charges() = 1 and pg_temp.invoice_total() = 1050000);
select pg_temp.expect_eq('and the learner can''t use it', pg_temp.allowed('learner'), 'needs_optin');
select pg_temp.expect_eq('on again in the same term: already paid for this term', pg_temp.optin('mum', 'student', true), 'already_charged');

update fee_charges set created_at = now()
 where student_id = current_setting('t.student')::uuid and voided_at is null;
select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
select record_payment(current_setting('t.invoice')::uuid, 1050000, 'bank', 'HELPER-CHECK-1');
reset role;
select pg_temp.expect_eq('a charge already paid for isn''t cancelled, even before the cut-off', pg_temp.optin('mum', 'student', false), 'kept');
select pg_temp.check('the paid invoice is untouched', (select status::text = 'paid' and total_cents = 1050000 from fee_invoices where id = current_setting('t.invoice')::uuid));

select pg_temp.expect_eq('a learner not billed this term can''t be turned on', pg_temp.optin('stranger', 'student2', true), 'error 22023');
select pg_temp.expect_eq('and the opt-in rolls back with it',
  (select status from ai_helper_optins where student_id = current_setting('t.student2')::uuid), 'off');

-- a new term: last term's opt-in no longer counts while billing is on
select pg_temp.expect_eq('on for this term', pg_temp.optin('mum', 'student', true), 'already_charged');
update terms set is_current = false where id = current_setting('t.term')::uuid;
insert into terms (tenant_id, name, year, index, starts_on, ends_on, is_current)
values (current_setting('t.a')::uuid, 'Check Term 1', 2027, 1, '2027-01-05', '2027-04-02', true);
select pg_temp.expect_eq('next term the family chooses (and is charged) again', pg_temp.allowed('learner'), 'needs_optin');

rollback;
