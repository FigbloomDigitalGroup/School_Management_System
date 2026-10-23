-- Results are published per class and subject, by the teacher who teaches it.
--
-- Until now one exams.published_at released an exam for the whole school.
-- The first teacher to press "Publish marks" therefore showed families every
-- other teacher's marks for that exam, finished or not, in every class. And
-- exam_publish_teacher (20260903000000) let ANY teacher update ANY column of
-- ANY exam: rename it, change its total, or unpublish it.
--
-- mark_publications records "these marks are out": one row per
-- (exam, class, subject). A learner's family sees a mark only when its exam,
-- the learner's class and that subject have a row here. Rows are written
-- only by publish_marks()/unpublish_marks(), which check that the caller
-- teaches that subject in that class (or administers the school) and leave an
-- audit event. exams.published_at stays as "something from this exam is out",
-- kept in step by a trigger, so everything that lists published exams
-- (the parent and student result screens, admin reports) is unchanged.
--
-- Existing published exams keep what families see today: a row is created for
-- every class and subject that already has marks.

create table mark_publications (
  exam_id      uuid not null references exams on delete cascade,
  class_id     uuid not null references classes on delete cascade,
  subject_id   uuid not null references subjects on delete cascade,
  tenant_id    uuid not null references tenants on delete cascade,
  published_by uuid references profiles on delete set null,
  published_at timestamptz not null default now(),
  primary key (exam_id, class_id, subject_id)
);
create index on mark_publications (tenant_id, exam_id);

alter table mark_publications enable row level security;
-- Staff can see what is out (the Gradebook shows it). Nobody writes here
-- directly: publish_marks() and unpublish_marks() are SECURITY DEFINER.
create policy mark_publications_read on mark_publications for select
  using (is_super() or may_administer(tenant_id) or (tenant_id = my_tenant() and is_staff()));
revoke insert, update, delete on mark_publications from anon, authenticated;

-- ---------------------------------------------------------------- helper for policies
-- A policy on marks can't read mark_publications itself (families have no
-- access to it), so it asks this instead.
create or replace function marks_published(p_exam_id uuid, p_class_id uuid, p_subject_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from mark_publications
     where exam_id = p_exam_id and class_id = p_class_id and subject_id = p_subject_id
  )
$$;
revoke execute on function marks_published(uuid, uuid, uuid) from public, anon;
grant execute on function marks_published(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- exams.published_at follows the publications
create or replace function sync_exam_published_at() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  eid uuid := coalesce(new.exam_id, old.exam_id);
begin
  update exams
     set published_at = case
           when exists (select 1 from mark_publications where exam_id = eid) then coalesce(published_at, now())
           else null
         end
   where id = eid;
  return null;
end $$;

create trigger mark_publications_sync_exam after insert or delete on mark_publications
  for each row execute function sync_exam_published_at();

-- ---------------------------------------------------------------- keep what families see today
insert into mark_publications (exam_id, class_id, subject_id, tenant_id, published_by, published_at)
select distinct e.id, s.class_id, m.subject_id, e.tenant_id, null::uuid, e.published_at
  from exams e
  join marks m on m.exam_id = e.id
  join students s on s.id = m.student_id
 where e.published_at is not null and s.class_id is not null
on conflict do nothing;

-- ---------------------------------------------------------------- who can see a mark
drop policy mark_read on marks;
create policy mark_read on marks for select
  using (
    is_super()
    or (tenant_id = my_tenant() and is_staff())
    or may_administer(tenant_id)
    or (
      student_id in (select my_students())
      and exists (
        select 1 from students s
         where s.id = marks.student_id
           and marks_published(marks.exam_id, s.class_id, marks.subject_id)
      )
    )
  );

-- The class mean shown beside a family's own mark: only for subjects that are out.
create or replace function class_means_for_exam(p_exam_id uuid, p_class_id uuid)
returns table(subject_id uuid, mean_score numeric)
language sql stable security definer set search_path = public as $$
  select m.subject_id, round(avg(m.score)) as mean_score
    from marks m
    join students s on s.id = m.student_id
   where m.exam_id = p_exam_id
     and s.class_id = p_class_id
     and s.tenant_id = my_tenant()
     and m.score is not null
     and marks_published(m.exam_id, p_class_id, m.subject_id)
   group by m.subject_id
$$;

-- ---------------------------------------------------------------- teachers no longer edit exams
drop policy exam_publish_teacher on exams;

-- An exam with marks entered can't be deleted by hand: the cascade would take
-- every mark with it. (pg_trigger_depth() = 1 is a direct DELETE; a school
-- being removed cascades from tenants at a deeper level and must still work.)
create or replace function guard_exam_delete() returns trigger
language plpgsql set search_path = public as $$
begin
  if pg_trigger_depth() = 1 and exists (select 1 from marks where exam_id = old.id) then
    raise exception 'Marks have been entered for "%", so it can''t be deleted.', old.name
      using errcode = '23001';
  end if;
  return old;
end $$;
create trigger exams_guard_delete before delete on exams
  for each row execute function guard_exam_delete();

-- ---------------------------------------------------------------- publish / retract
create or replace function may_teach_class_subject(p_tenant_id uuid, p_class_id uuid, p_subject_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select may_administer(p_tenant_id)
      or (
        p_tenant_id = my_tenant() and my_role() = 'teacher'
        and exists (
          select 1 from teaching_assignments ta
           where ta.teacher_id = auth.uid() and ta.class_id = p_class_id and ta.subject_id = p_subject_id
        )
      )
$$;

create or replace function publish_marks(p_exam_id uuid, p_class_id uuid, p_subject_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  ex exams; cls classes; subj subjects; n bigint;
begin
  select * into ex from exams where id = p_exam_id;
  select * into cls from classes where id = p_class_id;
  select * into subj from subjects where id = p_subject_id;
  if ex.id is null or cls.id is null or subj.id is null
     or cls.tenant_id <> ex.tenant_id or subj.tenant_id <> ex.tenant_id then
    raise exception 'That exam, class or subject could not be found.' using errcode = '42501';
  end if;
  if not may_teach_class_subject(ex.tenant_id, p_class_id, p_subject_id) then
    raise exception 'You don''t teach % to %.', subj.name, cls.name using errcode = '42501';
  end if;

  select count(*) into n
    from marks m join students s on s.id = m.student_id
   where m.exam_id = p_exam_id and m.subject_id = p_subject_id and s.class_id = p_class_id;
  if n = 0 then
    raise exception 'There are no marks to publish yet.' using errcode = '22023';
  end if;

  insert into mark_publications (exam_id, class_id, subject_id, tenant_id, published_by)
  values (p_exam_id, p_class_id, p_subject_id, ex.tenant_id, auth.uid())
  on conflict (exam_id, class_id, subject_id) do nothing;

  if found then
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    values (ex.tenant_id, auth.uid(), my_actor_label(),
            format('%s %s results published for %s', subj.name, ex.name, cls.name), 'academic',
            jsonb_build_object('exam_id', ex.id, 'class_id', cls.id, 'subject_id', subj.id, 'marks', n));
  end if;
end $$;

create or replace function unpublish_marks(p_exam_id uuid, p_class_id uuid, p_subject_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  ex exams; cls classes; subj subjects;
begin
  select * into ex from exams where id = p_exam_id;
  select * into cls from classes where id = p_class_id;
  select * into subj from subjects where id = p_subject_id;
  if ex.id is null or cls.id is null or subj.id is null then
    raise exception 'That exam, class or subject could not be found.' using errcode = '42501';
  end if;
  if not may_teach_class_subject(ex.tenant_id, p_class_id, p_subject_id) then
    raise exception 'You don''t teach % to %.', subj.name, cls.name using errcode = '42501';
  end if;

  delete from mark_publications
   where exam_id = p_exam_id and class_id = p_class_id and subject_id = p_subject_id;

  if found then
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    values (ex.tenant_id, auth.uid(), my_actor_label(),
            format('%s %s results withdrawn for %s', subj.name, ex.name, cls.name), 'academic',
            jsonb_build_object('exam_id', ex.id, 'class_id', cls.id, 'subject_id', subj.id));
  end if;
end $$;

revoke execute on function may_teach_class_subject(uuid, uuid, uuid) from public, anon;
revoke execute on function publish_marks(uuid, uuid, uuid) from public, anon;
revoke execute on function unpublish_marks(uuid, uuid, uuid) from public, anon;
grant execute on function may_teach_class_subject(uuid, uuid, uuid) to authenticated;
grant execute on function publish_marks(uuid, uuid, uuid) to authenticated;
grant execute on function unpublish_marks(uuid, uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- homework
-- assignment_write let any teacher write homework for any class and subject
-- in the school, and any teacher edit anyone's. assignment_read let every
-- member of a school read every class's homework. Now: a teacher sets homework
-- for a class and subject they teach, and only changes or removes their own;
-- a family sees only their own children's class.
drop policy assignment_read on assignments;
create policy assignment_read on assignments for select
  using (
    is_super() or may_administer(tenant_id)
    or (
      tenant_id = my_tenant()
      and (
        is_staff()
        or class_id in (select s.class_id from students s where s.id in (select my_students()))
      )
    )
  );

drop policy assignment_write on assignments;

create policy assignment_insert on assignments for insert
  with check (
    may_administer(tenant_id)
    or (
      tenant_id = my_tenant() and my_role() = 'teacher' and set_by = auth.uid()
      and may_teach_class_subject(tenant_id, class_id, subject_id)
    )
  );

create policy assignment_update on assignments for update
  using (
    may_administer(tenant_id)
    or (tenant_id = my_tenant() and my_role() = 'teacher' and set_by = auth.uid())
  )
  with check (
    may_administer(tenant_id)
    or (
      tenant_id = my_tenant() and my_role() = 'teacher' and set_by = auth.uid()
      and may_teach_class_subject(tenant_id, class_id, subject_id)
    )
  );

create policy assignment_delete on assignments for delete
  using (
    may_administer(tenant_id)
    or (tenant_id = my_tenant() and my_role() = 'teacher' and set_by = auth.uid())
  );
