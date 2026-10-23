-- Learner archive checks for 20261023100000_learner_archive.
--
-- Runs against a local database that has the migrations applied and
-- `npm run db:seed` data, inside one transaction that is rolled back.
-- Every check prints PASS or FAIL.
--
--   docker exec -i supabase_db_figbloom psql -U postgres -d postgres -q < supabase/rls-checks/learners.sql

\set ON_ERROR_STOP 1
begin;

-- ---------------------------------------------------------------- fixtures (as postgres)
select set_config('t.a',       (select id::text from tenants where slug = 'alliance'), true);
select set_config('t.admin',   (select id::text from profiles where role = 'school_admin' and tenant_id = current_setting('t.a')::uuid limit 1), true);
select set_config('t.teacher', (select id::text from profiles where role = 'teacher' and tenant_id = current_setting('t.a')::uuid limit 1), true);
select set_config('t.parent',  (select id::text from profiles where role = 'parent' and tenant_id = current_setting('t.a')::uuid limit 1), true);
-- a seeded learner with real history: attendance, marks and an invoice
select set_config('t.child',   (
  select s.id::text from students s
   where s.tenant_id = current_setting('t.a')::uuid and s.active
     and exists (select 1 from attendance a where a.student_id = s.id)
     and exists (select 1 from marks m where m.student_id = s.id)
     and exists (select 1 from fee_invoices f where f.student_id = s.id)
   order by s.admission_no limit 1), true);
select set_config('t.cls',     (select class_id::text from students where id = current_setting('t.child')::uuid), true);

create function pg_temp.check(label text, ok boolean) returns void language plpgsql as $$
begin raise notice '% %', case when ok then 'PASS' else 'FAIL' end, label; end $$;
create function pg_temp.expect_eq(label text, actual bigint, expected bigint) returns void language plpgsql as $$
begin
  if actual = expected then raise notice 'PASS %', label;
  else raise notice 'FAIL %: got %, expected %', label, actual, expected; end if;
end $$;
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

select pg_temp.check('the fixture learner has history to protect', current_setting('t.child', true) <> '');
select set_config('t.marks',    (select count(*)::text from marks where student_id = current_setting('t.child')::uuid), true);
select set_config('t.invoices', (select count(*)::text from fee_invoices where student_id = current_setting('t.child')::uuid), true);
select set_config('t.attend',   (select count(*)::text from attendance where student_id = current_setting('t.child')::uuid), true);

-- ---------------------------------------------------------------- only a school admin archives
select pg_temp.act_as(current_setting('t.teacher'));
set local role authenticated;
select pg_temp.expect_error('a teacher cannot archive a learner',
  format('select archive_learners(array[%L]::uuid[])', current_setting('t.child')), '42501');
reset role;

select pg_temp.act_as(current_setting('t.parent'));
set local role authenticated;
select pg_temp.expect_error('a parent cannot archive a learner',
  format('select archive_learners(array[%L]::uuid[])', current_setting('t.child')), '42501');
reset role;
select pg_temp.check('the learner is still active after those refusals',
  (select active from students where id = current_setting('t.child')::uuid));

-- ---------------------------------------------------------------- a learner with history cannot be deleted
select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
select pg_temp.expect_error('the school admin cannot delete a learner who has records',
  format('delete from students where id = %L', current_setting('t.child')), '23001');
reset role;
select pg_temp.expect_error('not even the database owner can (it is a guard, not a permission)',
  format('delete from students where id = %L', current_setting('t.child')), '23001');
select pg_temp.expect_eq('nothing was removed: marks', (select count(*) from marks where student_id = current_setting('t.child')::uuid), current_setting('t.marks')::bigint);
select pg_temp.expect_eq('nothing was removed: invoices', (select count(*) from fee_invoices where student_id = current_setting('t.child')::uuid), current_setting('t.invoices')::bigint);

-- ---------------------------------------------------------------- archive keeps everything
select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
select pg_temp.expect_eq('the admin archives the learner',
  archive_learners(array[current_setting('t.child')::uuid]), 1);
reset role;
select pg_temp.check('the learner is inactive, stamped and attributed',
  (select not active and archived_at is not null and archived_by = current_setting('t.admin')::uuid
     from students where id = current_setting('t.child')::uuid));
select pg_temp.expect_eq('attendance kept', (select count(*) from attendance where student_id = current_setting('t.child')::uuid), current_setting('t.attend')::bigint);
select pg_temp.expect_eq('marks kept', (select count(*) from marks where student_id = current_setting('t.child')::uuid), current_setting('t.marks')::bigint);
select pg_temp.expect_eq('invoices kept', (select count(*) from fee_invoices where student_id = current_setting('t.child')::uuid), current_setting('t.invoices')::bigint);
select pg_temp.check('the archive is in the audit log',
  exists (select 1 from audit_events where tenant_id = current_setting('t.a')::uuid and event = '1 learner archived'
            and metadata -> 'student_ids' ? current_setting('t.child')));

select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
select pg_temp.expect_eq('archiving someone already archived changes nothing',
  archive_learners(array[current_setting('t.child')::uuid]), 0);
select pg_temp.expect_eq('an empty list is a no-op', archive_learners(array[]::uuid[]), 0);
reset role;

-- ---------------------------------------------------------------- restore
select pg_temp.act_as(current_setting('t.teacher'));
set local role authenticated;
select pg_temp.expect_error('a teacher cannot restore a learner',
  format('select restore_learners(array[%L]::uuid[])', current_setting('t.child')), '42501');
reset role;

select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
select pg_temp.expect_eq('the admin restores the learner',
  restore_learners(array[current_setting('t.child')::uuid]), 1);
reset role;
select pg_temp.check('the learner is active again with the archive stamp cleared',
  (select active and archived_at is null and archived_by is null from students where id = current_setting('t.child')::uuid));
select pg_temp.check('the restore is in the audit log',
  exists (select 1 from audit_events where tenant_id = current_setting('t.a')::uuid and event = '1 learner restored'));

-- ---------------------------------------------------------------- a learner with no records can still be deleted
insert into students (tenant_id, admission_no, full_name, class_id, boarding, active)
  values (current_setting('t.a')::uuid, 'RLS-1', 'RLS Added By Mistake', current_setting('t.cls')::uuid, false, true);
select pg_temp.act_as(current_setting('t.admin'));
set local role authenticated;
select pg_temp.expect_rows('the admin deletes a learner who has no records',
  'delete from students where admission_no = ''RLS-1''', 1);
reset role;

-- ---------------------------------------------------------------- removing a whole school still works
insert into tenants (name, slug, county) values ('RLS Throwaway', 'rls-throwaway', 'Nairobi');
insert into classes (tenant_id, name, form_level, level)
  select id, 'T1', 1, 'secondary' from tenants where slug = 'rls-throwaway';
insert into students (tenant_id, admission_no, full_name, class_id, boarding, active)
  select t.id, '9001', 'RLS Cascade', c.id, false, true from tenants t join classes c on c.tenant_id = t.id where t.slug = 'rls-throwaway';
insert into terms (tenant_id, name, year, index, starts_on, ends_on, is_current)
  select id, 'Term 1', 2099, 1, '2099-01-01', '2099-04-01', true from tenants where slug = 'rls-throwaway';
insert into fee_invoices (tenant_id, student_id, term_id, total_cents, paid_cents, due_on)
  select s.tenant_id, s.id, tm.id, 100000, 0, '2099-02-01'
    from students s join terms tm on tm.tenant_id = s.tenant_id where s.admission_no = '9001' and s.full_name = 'RLS Cascade';
select pg_temp.expect_rows('removing a whole school cascades through a learner who has an invoice',
  'delete from tenants where slug = ''rls-throwaway''', 1);
select pg_temp.expect_eq('and the learner went with it', (select count(*) from students where full_name = 'RLS Cascade'), 0);

rollback;
