-- Learners are archived, not deleted.
--
-- Deleting a learner cascaded to everything that points at them: attendance,
-- marks, CBE results, course records, homework hand-ins, documents and the fee
-- invoices (and through them every payment). An admin clicking "Delete
-- learner" on a learner who had left in Term 2 erased that family's receipts.
--
-- A learner who has left is archived instead: students.active goes false (which
-- every roster, billing run, dashboard and report already honours) and nothing
-- is removed. A learner with no records at all (added by mistake, or a bad
-- import) can still be deleted outright. The database enforces that, so an
-- API call can't do what the screen no longer offers.

alter table students
  add column archived_at timestamptz,
  add column archived_by uuid references profiles on delete set null;

-- ---------------------------------------------------------------- the delete guard
-- A learner with any history can't be deleted. pg_trigger_depth() = 1 is a
-- direct DELETE; a whole school being removed cascades from tenants at a deeper
-- level and must still work. Runs as the definer so row-level security on the
-- history tables can never make a learner with records look empty.
create or replace function guard_student_delete() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  found_on text[] := '{}';
begin
  if pg_trigger_depth() > 1 then return old; end if;

  if exists (select 1 from attendance where student_id = old.id) then found_on := array_append(found_on, 'attendance'); end if;
  if exists (select 1 from marks where student_id = old.id) then found_on := array_append(found_on, 'exam marks'); end if;
  if exists (select 1 from fee_invoices where student_id = old.id) then found_on := array_append(found_on, 'fee records'); end if;
  if exists (select 1 from cbe_results where student_id = old.id)
     or exists (select 1 from cbe_assessment_comments where student_id = old.id) then found_on := array_append(found_on, 'CBE results'); end if;
  if exists (select 1 from course_marks where student_id = old.id)
     or exists (select 1 from course_grades where student_id = old.id)
     or exists (select 1 from enrollments where student_id = old.id) then found_on := array_append(found_on, 'course records'); end if;
  if exists (select 1 from assignment_submissions where student_id = old.id) then found_on := array_append(found_on, 'homework hand-ins'); end if;
  if exists (select 1 from student_documents where student_id = old.id) then found_on := array_append(found_on, 'documents'); end if;

  if cardinality(found_on) > 0 then
    raise exception '% has % on file, so they can''t be deleted. Archive them instead: they leave class lists and billing, and everything is kept.',
      old.full_name, array_to_string(found_on, ', ')
      using errcode = '23001';
  end if;
  return old;
end $$;
create trigger students_guard_delete before delete on students
  for each row execute function guard_student_delete();

-- ---------------------------------------------------------------- archive / restore
-- Both go through a function (not a bare UPDATE) so each is recorded: who
-- archived whom, and when. An id the caller can't administer is refused outright
-- rather than quietly skipped.
create or replace function archive_learners(p_ids uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if p_ids is null or cardinality(p_ids) = 0 then return 0; end if;
  if exists (select 1 from students where id = any (p_ids) and not may_administer(tenant_id)) then
    raise exception 'You can only archive learners at a school you administer.' using errcode = '42501';
  end if;

  with changed as (
    update students
       set active = false, archived_at = now(), archived_by = auth.uid()
     where id = any (p_ids) and active and may_administer(tenant_id)
    returning id, tenant_id, full_name
  ), logged as (
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    select tenant_id, auth.uid(), my_actor_label(),
           format('%s learner%s archived', count(*), case when count(*) = 1 then '' else 's' end), 'provisioning',
           jsonb_build_object('student_ids', jsonb_agg(id), 'names', jsonb_agg(full_name))
      from changed group by tenant_id
    returning 1
  )
  select count(*) into n from changed;
  return n;
end $$;

create or replace function restore_learners(p_ids uuid[]) returns int
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if p_ids is null or cardinality(p_ids) = 0 then return 0; end if;
  if exists (select 1 from students where id = any (p_ids) and not may_administer(tenant_id)) then
    raise exception 'You can only restore learners at a school you administer.' using errcode = '42501';
  end if;

  with changed as (
    update students
       set active = true, archived_at = null, archived_by = null
     where id = any (p_ids) and not active and may_administer(tenant_id)
    returning id, tenant_id, full_name
  ), logged as (
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    select tenant_id, auth.uid(), my_actor_label(),
           format('%s learner%s restored', count(*), case when count(*) = 1 then '' else 's' end), 'provisioning',
           jsonb_build_object('student_ids', jsonb_agg(id), 'names', jsonb_agg(full_name))
      from changed group by tenant_id
    returning 1
  )
  select count(*) into n from changed;
  return n;
end $$;

revoke execute on function archive_learners(uuid[]), restore_learners(uuid[]) from public, anon;
grant execute on function archive_learners(uuid[]), restore_learners(uuid[]) to authenticated;
