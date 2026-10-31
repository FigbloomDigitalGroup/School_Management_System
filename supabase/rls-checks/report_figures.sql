-- The data behind the report screens (QA 13, FIG-1246): the group dashboard's cached summary, and who may read the tables the
-- platform console and group dashboard are built from.
--
-- What each screen shows against the database is in e2e/reports.spec.ts (every figure re-derived there from raw rows). This file
-- covers what only SQL can prove: that organization_tenant_summary equals the live data, how its "today" and "fees" are defined, and
-- who can read it. Runs against a local database with `npm run db:seed` and `db:seed-org` data, in one transaction that is rolled
-- back. Every check prints PASS, FAIL, KNOWN <bug> (a defect already filed: KNOWN until it is fixed, then PASS) or INFO.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/report_figures.sql
-- Check the psql exit code too. Do not run it while e2e or the integration tests are running.

\set ON_ERROR_STOP 1
begin;

create function pg_temp.check(label text, ok boolean, known text default null) returns void language plpgsql as $$
begin raise notice '% %', case when ok then 'PASS' when known is not null then 'KNOWN ' || known else 'FAIL' end, label; end $$;
create function pg_temp.info(label text) returns void language plpgsql as $$ begin raise notice 'INFO %', label; end $$;
create function pg_temp.count_as(p_user uuid, p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute p_sql into n;
  reset role;
  return n;
exception when others then
  reset role;
  raise;
end $$;

select set_config('t.a', (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.k', (select id::text from tenants where slug = 'kijani-ridge'), true);
select set_config('t.admin', (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.a')::uuid order by id limit 1), true);
select set_config('t.teacher', (select id::text from profiles where login_id = 'TC-0002' and tenant_id = current_setting('t.a')::uuid), true);
select set_config('t.parent', (select id::text from profiles where login_id = 'PT-0002' and tenant_id = current_setting('t.a')::uuid), true);
select set_config('t.student', (select id::text from profiles where login_id = 'ST-0002' and tenant_id = current_setting('t.a')::uuid), true);
select set_config('t.org', (select id::text from profiles where role = 'org_admin' order by id limit 1), true);
select set_config('t.super', (select id::text from profiles where role = 'super_admin' order by id limit 1), true);
select set_config('t.kkid', (select id::text from students where tenant_id = current_setting('t.k')::uuid and active order by id limit 1), true);
select set_config('t.kclass', (select class_id::text from students where id = current_setting('t.kkid')::uuid), true);
select set_config('t.kterm', (select id::text from terms where tenant_id = current_setting('t.k')::uuid and is_current), true);
select set_config('t.kteacher', (select id::text from profiles where login_id = 'TC-0001' and tenant_id = current_setting('t.k')::uuid), true);
select pg_temp.check('the seed has what these checks need (Alliance admin, teacher, parent, student, an org admin, a platform admin, a Kijani Ridge learner, class, term and teacher)',
  current_setting('t.admin') <> '' and current_setting('t.teacher') <> '' and current_setting('t.parent') <> '' and current_setting('t.student') <> ''
  and current_setting('t.org') <> '' and current_setting('t.super') <> '' and current_setting('t.kkid') <> '' and current_setting('t.kclass') <> ''
  and current_setting('t.kterm') <> '' and current_setting('t.kteacher') <> '');

-- ---------------------------------------------------------------- the cached summary equals the live data
create function pg_temp.drift() returns bigint language sql as $$
  select count(*) from tenants t join organization_tenant_summary s on s.tenant_id = t.id
   where s.active_students <> (select count(*) from students x where x.tenant_id = t.id and x.active)
      or s.present_today <> (select count(*) from attendance a where a.tenant_id = t.id and a.taken_on = current_date and a.mark = 'present')
      or s.fees_billed_cents <> (select coalesce(sum(total_cents), 0) from fee_invoices where tenant_id = t.id)
      or s.fees_collected_cents <> (select coalesce(sum(paid_cents), 0) from fee_invoices where tenant_id = t.id)
      or s.status <> t.status;
$$;
select pg_temp.check('every school has a summary row, and none differs from the live data (learners, present today, fees, status)',
  (select count(*) from tenants) = (select count(*) from organization_tenant_summary) and pg_temp.drift() = 0);
update students set active = false, archived_at = now() where id = current_setting('t.kkid')::uuid;
select pg_temp.check('archiving a learner takes them out of the summary at once (active_students 80 to 79 for Kijani Ridge)',
  (select active_students from organization_tenant_summary where tenant_id = current_setting('t.k')::uuid) = 79 and pg_temp.drift() = 0);
update students set active = true, archived_at = null where id = current_setting('t.kkid')::uuid;
select pg_temp.check('and restoring them puts them back (80)',
  (select active_students from organization_tenant_summary where tenant_id = current_setting('t.k')::uuid) = 80);

-- ---------------------------------------------------------------- "present today"
-- One learner marked present and one late today, in Kijani Ridge, so the group dashboard has something to count.
insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark)
  select current_setting('t.k')::uuid, s.id, s.class_id, current_setting('t.kterm')::uuid, current_setting('t.kteacher')::uuid, current_date,
         case when s.id = current_setting('t.kkid')::uuid then 'present' else 'late' end::attendance_mark
    from students s where s.class_id = current_setting('t.kclass')::uuid and s.active order by (s.id = current_setting('t.kkid')::uuid) desc, s.id limit 2;
select pg_temp.check('"present today" counts the learners who are here: the one present and the one late (2)',
  (select present_today from organization_tenant_summary where tenant_id = current_setting('t.k')::uuid) = 2, 'FIG-1408');
select pg_temp.info('the summary says ' || (select present_today from organization_tenant_summary where tenant_id = current_setting('t.k')::uuid)
  || ' present today for Kijani Ridge; the school''s own screens count present and late together: ' || (select count(*) from attendance where tenant_id = current_setting('t.k')::uuid and taken_on = current_date and mark in ('present', 'late')));

-- The summary is only refreshed by a write. Simulate the date changing with no write in between: the same session, two time zones
-- 26 hours apart, so current_date is one day later the second time.
set local timezone = 'Etc/GMT+12';
select set_config('t.day_a', current_date::text, true);
select refresh_organization_tenant_summary(current_setting('t.k')::uuid);
select set_config('t.cached', (select present_today::text from organization_tenant_summary where tenant_id = current_setting('t.k')::uuid), true);
set local timezone = 'Etc/GMT-14';
select pg_temp.check('after midnight the group dashboard counts today''s register, not yesterday''s: the summary still says '
  || current_setting('t.cached') || ' present (the day before, ' || current_setting('t.day_a') || ') when the new day ' || current_date::text || ' has none',
  (select present_today from organization_tenant_summary where tenant_id = current_setting('t.k')::uuid)
    = (select count(*) from attendance where tenant_id = current_setting('t.k')::uuid and taken_on = current_date and mark = 'present'), 'QA13-STALE-TODAY FIG-1444');
reset timezone;

-- ---------------------------------------------------------------- fees: this term, or every term?
insert into terms (tenant_id, name, year, index, starts_on, ends_on, is_current) values (current_setting('t.k')::uuid, 'QA13 earlier term', 2046, 1, '2046-01-05', '2046-04-01', false);
insert into fee_invoices (tenant_id, student_id, term_id, total_cents, paid_cents, due_on)
  values (current_setting('t.k')::uuid, current_setting('t.kkid')::uuid, (select id from terms where tenant_id = current_setting('t.k')::uuid and year = 2046), 100000000, 0, '2046-02-01');
select pg_temp.check('the group dashboard''s "billed" is this term''s invoices, as on the school''s own Dashboard: 1,000,000.00 billed for another term is left out',
  (select fees_billed_cents from organization_tenant_summary where tenant_id = current_setting('t.k')::uuid)
    = (select coalesce(sum(total_cents), 0) from fee_invoices where tenant_id = current_setting('t.k')::uuid and term_id = current_setting('t.kterm')::uuid), 'QA13-ORG-TERMS FIG-1443');

-- ---------------------------------------------------------------- who may read the tables the console screens are built from
select pg_temp.check('a teacher, a parent and a student read no row of the group summary',
  pg_temp.count_as(current_setting('t.teacher')::uuid, 'select count(*) from organization_tenant_summary') = 0
  and pg_temp.count_as(current_setting('t.parent')::uuid, 'select count(*) from organization_tenant_summary') = 0
  and pg_temp.count_as(current_setting('t.student')::uuid, 'select count(*) from organization_tenant_summary') = 0);
select pg_temp.check('a school admin reads only their own school''s summary row (1 of 11)',
  pg_temp.count_as(current_setting('t.admin')::uuid, 'select count(*) from organization_tenant_summary') <= 1
  and pg_temp.count_as(current_setting('t.admin')::uuid, format('select count(*) from organization_tenant_summary where tenant_id = %L', current_setting('t.k'))) = 0);
select pg_temp.check('the group admin reads the group''s schools (1) and not the others (the summary has 11 rows)',
  pg_temp.count_as(current_setting('t.org')::uuid, 'select count(*) from organization_tenant_summary') = 1);
select pg_temp.check('the platform admin reads every school''s summary row (11)',
  pg_temp.count_as(current_setting('t.super')::uuid, 'select count(*) from organization_tenant_summary') = 11);
select pg_temp.info('who reads the price list that MRR is worked out from (plan_pricing, 3 rows): school admin ' || pg_temp.count_as(current_setting('t.admin')::uuid, 'select count(*) from plan_pricing')
  || ', teacher ' || pg_temp.count_as(current_setting('t.teacher')::uuid, 'select count(*) from plan_pricing') || ', parent ' || pg_temp.count_as(current_setting('t.parent')::uuid, 'select count(*) from plan_pricing')
  || ', platform ' || pg_temp.count_as(current_setting('t.super')::uuid, 'select count(*) from plan_pricing'));
-- Both tables are empty on the seed, so a count of 0 would prove nothing: put one row in each first.
select set_config('t.kadmin', (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.k')::uuid order by id limit 1), true);
insert into platform_invoices (tenant_id, amount_cents, due_date) values (current_setting('t.a')::uuid, 123456, current_date);
insert into impersonation_sessions (tenant_id, staff_id, reason) values (current_setting('t.a')::uuid, current_setting('t.super')::uuid, 'QA13');
select pg_temp.check('the platform''s invoices to schools are read by the platform admin (1) and by no school admin, teacher or parent',
  pg_temp.count_as(current_setting('t.super')::uuid, 'select count(*) from platform_invoices') = 1
  and pg_temp.count_as(current_setting('t.admin')::uuid, 'select count(*) from platform_invoices') = 0
  and pg_temp.count_as(current_setting('t.teacher')::uuid, 'select count(*) from platform_invoices') = 0
  and pg_temp.count_as(current_setting('t.parent')::uuid, 'select count(*) from platform_invoices') = 0);
select pg_temp.check('the impersonation log: the school''s own admin reads the entry about their school (1), a teacher, a parent and another school''s admin read none, the platform admin reads it',
  pg_temp.count_as(current_setting('t.admin')::uuid, 'select count(*) from impersonation_sessions') = 1
  and pg_temp.count_as(current_setting('t.teacher')::uuid, 'select count(*) from impersonation_sessions') = 0
  and pg_temp.count_as(current_setting('t.parent')::uuid, 'select count(*) from impersonation_sessions') = 0
  and pg_temp.count_as(current_setting('t.kadmin')::uuid, 'select count(*) from impersonation_sessions') = 0
  and pg_temp.count_as(current_setting('t.super')::uuid, 'select count(*) from impersonation_sessions') = 1);

-- ---------------------------------------------------------------- the two logs that call themselves immutable
-- The audit trail has only a read policy (nobody can change a row through the API); the impersonation log has `for all using is_super()`.
with s as (insert into impersonation_sessions (tenant_id, staff_id, reason) values (current_setting('t.a')::uuid, current_setting('t.super')::uuid, 'QA13') returning id)
  select set_config('t.isess', (select id::text from s), true);
select set_config('t.aevent', (select id::text from audit_events order by created_at desc limit 1), true);
select pg_temp.check('nobody can change or delete an audit event through the API: school admin, org admin and platform admin each change 0 rows',
  pg_temp.count_as(current_setting('t.admin')::uuid, format('with u as (update audit_events set event = %L where id = %L returning 1) select count(*) from u', 'tampered', current_setting('t.aevent'))) = 0
  and pg_temp.count_as(current_setting('t.org')::uuid, format('with u as (update audit_events set event = %L where id = %L returning 1) select count(*) from u', 'tampered', current_setting('t.aevent'))) = 0
  and pg_temp.count_as(current_setting('t.super')::uuid, format('with u as (update audit_events set event = %L where id = %L returning 1) select count(*) from u', 'tampered', current_setting('t.aevent'))) = 0
  and pg_temp.count_as(current_setting('t.super')::uuid, format('with d as (delete from audit_events where id = %L returning 1) select count(*) from d', current_setting('t.aevent'))) = 0);
select pg_temp.check('a school admin cannot change or delete an impersonation session, even one about their own school',
  pg_temp.count_as(current_setting('t.admin')::uuid, format('with u as (update impersonation_sessions set reason = %L where id = %L returning 1) select count(*) from u', 'tampered', current_setting('t.isess'))) = 0
  and pg_temp.count_as(current_setting('t.admin')::uuid, format('with d as (delete from impersonation_sessions where id = %L returning 1) select count(*) from d', current_setting('t.isess'))) = 0);
select pg_temp.check('the platform admin cannot rewrite an impersonation session either: the page calls the log an "immutable record", and the people it records are the platform admins',
  pg_temp.count_as(current_setting('t.super')::uuid, format('with u as (update impersonation_sessions set reason = %L, ended_at = now(), writes_count = 0 where id = %L returning 1) select count(*) from u', 'tampered', current_setting('t.isess'))) = 0,
  'QA13-IMPERSONATION-IMMUTABLE FIG-1453');
select pg_temp.check('nor delete one',
  pg_temp.count_as(current_setting('t.super')::uuid, format('with d as (delete from impersonation_sessions where id = %L returning 1) select count(*) from d', current_setting('t.isess'))) = 0,
  'QA13-IMPERSONATION-IMMUTABLE FIG-1453');

rollback;
