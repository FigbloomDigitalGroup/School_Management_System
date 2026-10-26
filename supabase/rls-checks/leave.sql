-- Leave review checks for 20261026050000_leave_review_only_by_office.
--
-- Runs against a local database that has the migrations applied and
-- `npm run db:seed` data, inside one transaction that is rolled back.
-- Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/leave.sql

\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------- fixtures (as postgres)
select set_config('t.a',       (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.admin',   (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.a')::uuid limit 1), true);
select set_config('t.teacher', (select id::text from profiles where role = 'teacher' and tenant_id = current_setting('t.a')::uuid limit 1), true);

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when ok then 'PASS' else 'FAIL' end, label; end $$;
-- A statement that must be refused with this SQLSTATE.
create function pg_temp.expect_error(label text, stmt text, errcode text) returns void language plpgsql as $$
begin
  begin execute stmt; raise notice 'FAIL %: allowed', label;
  exception when others then
    if sqlstate = errcode then raise notice 'PASS % (%)', label, sqlerrm;
    else raise notice 'FAIL %: % %', label, sqlstate, sqlerrm; end if;
  end;
end $$;
create function pg_temp.expect_rows(label text, stmt text, expected bigint) returns void language plpgsql as $$
declare n bigint;
begin
  execute stmt;
  get diagnostics n = row_count;
  if n = expected then raise notice 'PASS %', label;
  else raise notice 'FAIL %: % rows, expected %', label, n, expected; end if;
end $$;
create function pg_temp.act_as(uid text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true)
$$;
grant execute on all functions in schema pg_temp to authenticated;

select pg_temp.check('the fixture has a teacher and a school admin',
  current_setting('t.teacher', true) <> '' and current_setting('t.admin', true) <> '');

-- ---------------------------------------------------------------- the teacher's own requests
select pg_temp.act_as(current_setting('t.teacher'));
set local role authenticated;

select pg_temp.expect_error('a teacher cannot file a request that is already approved',
  format($q$insert into leave_requests (tenant_id, teacher_id, starts_on, ends_on, status)
            values (%L, %L, current_date + 30, current_date + 31, 'approved')$q$,
         current_setting('t.a'), current_setting('t.teacher')), '42501');
select pg_temp.expect_error('a teacher cannot file a request with a reviewer already on it',
  format($q$insert into leave_requests (tenant_id, teacher_id, starts_on, ends_on, reviewed_by)
            values (%L, %L, current_date + 30, current_date + 31, %L)$q$,
         current_setting('t.a'), current_setting('t.teacher'), current_setting('t.teacher')), '42501');

select pg_temp.expect_rows('a teacher can file a normal pending request',
  format($q$insert into leave_requests (tenant_id, teacher_id, starts_on, ends_on, reason)
            values (%L, %L, current_date + 40, current_date + 41, 'check')$q$,
         current_setting('t.a'), current_setting('t.teacher')), 1);

reset role;
select set_config('t.req', (select id::text from leave_requests where reason = 'check'), true);
set local role authenticated;

select pg_temp.expect_error('a teacher cannot approve their own request',
  format($q$update leave_requests set status = 'approved' where id = %L$q$, current_setting('t.req')), '42501');
select pg_temp.expect_error('a teacher cannot reject a request either',
  format($q$update leave_requests set status = 'rejected' where id = %L$q$, current_setting('t.req')), '42501');
select pg_temp.expect_error('a teacher cannot sign a review onto their own request',
  format($q$update leave_requests set reviewed_by = %L, reviewed_at = now(), review_note = 'ok' where id = %L$q$,
         current_setting('t.teacher'), current_setting('t.req')), '42501');
select pg_temp.expect_rows('a teacher can change the reason of a pending request',
  format($q$update leave_requests set reason = 'check, moved' where id = %L$q$, current_setting('t.req')), 1);
select pg_temp.expect_rows('a teacher can withdraw a pending request',
  format($q$update leave_requests set status = 'cancelled' where id = %L$q$, current_setting('t.req')), 1);
select pg_temp.expect_rows('a withdrawn request cannot be revived as approved (no row visible to update)',
  format($q$update leave_requests set status = 'approved' where id = %L$q$, current_setting('t.req')), 0);

reset role;

-- ---------------------------------------------------------------- the office still reviews
insert into leave_requests (tenant_id, teacher_id, starts_on, ends_on, reason)
  values (current_setting('t.a')::uuid, current_setting('t.teacher')::uuid, current_date + 50, current_date + 51, 'check office');
select set_config('t.req3', (select id::text from leave_requests where reason = 'check office'), true);

select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
select pg_temp.expect_rows('the school admin approves a request, with their name on it',
  format($q$update leave_requests set status = 'approved', reviewed_by = %L, reviewed_at = now(), review_note = 'fine' where id = %L$q$,
         current_setting('t.admin'), current_setting('t.req3')), 1);
reset role;

select pg_temp.check('the approval is recorded', (select status = 'approved' and reviewed_by = current_setting('t.admin')::uuid
  from leave_requests where id = current_setting('t.req3')::uuid));

-- the teacher can no longer touch a request once it has been reviewed
select pg_temp.act_as(current_setting('t.teacher'));
set local role authenticated;
select pg_temp.expect_rows('a teacher cannot withdraw a request that was already reviewed (no row visible to update)',
  format($q$update leave_requests set status = 'cancelled' where id = %L$q$, current_setting('t.req3')), 0);
reset role;

rollback;
