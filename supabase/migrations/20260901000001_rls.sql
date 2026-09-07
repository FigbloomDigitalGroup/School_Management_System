-- Row level security.
--
-- The rule that matters: a school can never read another school's rows, and a
-- parent can only read the children they are a guardian of. Everything is
-- denied by default and opened explicitly.
-- Source of truth: supabase/rls.sql — kept identical here so `supabase db reset` applies it.

alter table tenants                 enable row level security;
alter table profiles                enable row level security;
alter table terms                   enable row level security;
alter table classes                 enable row level security;
alter table subjects                enable row level security;
alter table students                enable row level security;
alter table guardians               enable row level security;
alter table teaching_assignments    enable row level security;
alter table attendance              enable row level security;
alter table exams                   enable row level security;
alter table marks                   enable row level security;
alter table fee_items               enable row level security;
alter table fee_invoices            enable row level security;
alter table payments                enable row level security;
alter table announcements           enable row level security;
alter table announcement_reads      enable row level security;
alter table assignments             enable row level security;
alter table assignment_submissions  enable row level security;
alter table audit_events            enable row level security;
alter table impersonation_sessions  enable row level security;
alter table invites                 enable row level security;

-- ------------------------------------------------------------ helpers
create or replace function my_role() returns app_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid()
$$;

create or replace function my_tenant() returns uuid
language sql stable security definer set search_path = public as $$
  select tenant_id from profiles where id = auth.uid()
$$;

create or replace function is_super() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'super_admin' from profiles where id = auth.uid()), false)
$$;

create or replace function is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('school_admin','teacher') from profiles where id = auth.uid()), false)
$$;

-- the students this user is allowed to see
create or replace function my_students() returns setof uuid
language sql stable security definer set search_path = public as $$
  select s.id from students s
  where s.tenant_id = my_tenant()
    and (
      is_staff()
      or exists (select 1 from guardians g where g.student_id = s.id and g.profile_id = auth.uid())
      or s.profile_id = auth.uid()
    )
$$;

-- ------------------------------------------------------------ tenants
create policy tenant_read_own on tenants for select
  using (is_super() or id = my_tenant());
create policy tenant_write_super on tenants for all
  using (is_super()) with check (is_super());

-- ------------------------------------------------------------ profiles
create policy profile_read_self on profiles for select
  using (id = auth.uid() or is_super() or (tenant_id = my_tenant() and is_staff()));
create policy profile_update_self on profiles for update
  using (id = auth.uid()) with check (id = auth.uid());
create policy profile_admin_manage on profiles for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));

-- ------------------------------------------------------------ shared school reference data
-- terms, classes, subjects: readable by anyone in the school, writable by admins
do $$
declare t text;
begin
  foreach t in array array['terms','classes','subjects'] loop
    execute format($f$
      create policy %1$s_read on %1$s for select
        using (is_super() or tenant_id = my_tenant());
      create policy %1$s_write on %1$s for all
        using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'))
        with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));
    $f$, t);
  end loop;
end $$;

-- ------------------------------------------------------------ students
create policy student_read on students for select
  using (is_super() or id in (select my_students()));
create policy student_write on students for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));

create policy guardian_read on guardians for select
  using (is_super() or profile_id = auth.uid() or (tenant_id = my_tenant() and is_staff()));
create policy guardian_write on guardians for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));

create policy teaching_read on teaching_assignments for select
  using (is_super() or tenant_id = my_tenant());
create policy teaching_write on teaching_assignments for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));

-- ------------------------------------------------------------ attendance
create policy attendance_read on attendance for select
  using (is_super() or student_id in (select my_students()));
-- a teacher may only write for a class they are assigned to
create policy attendance_write on attendance for all
  using (
    is_super()
    or (tenant_id = my_tenant() and my_role() = 'school_admin')
    or (tenant_id = my_tenant() and my_role() = 'teacher' and exists (
          select 1 from teaching_assignments ta
          where ta.teacher_id = auth.uid() and ta.class_id = attendance.class_id))
    or (tenant_id = my_tenant() and exists (
          select 1 from classes c where c.id = attendance.class_id and c.class_teacher_id = auth.uid()))
  )
  with check (tenant_id = my_tenant() or is_super());

-- ------------------------------------------------------------ marks
-- unpublished exams are staff-only; students and parents see marks once published
create policy exam_read on exams for select
  using (is_super() or (tenant_id = my_tenant() and (is_staff() or published_at is not null)));
create policy exam_write on exams for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));

create policy mark_read on marks for select
  using (
    is_super()
    or (tenant_id = my_tenant() and is_staff())
    or (student_id in (select my_students())
        and exists (select 1 from exams e where e.id = marks.exam_id and e.published_at is not null))
  );
create policy mark_write on marks for all
  using (
    is_super()
    or (tenant_id = my_tenant() and my_role() = 'school_admin')
    or (tenant_id = my_tenant() and my_role() = 'teacher' and exists (
          select 1 from teaching_assignments ta
          where ta.teacher_id = auth.uid() and ta.subject_id = marks.subject_id))
  )
  with check (tenant_id = my_tenant() or is_super());

-- ------------------------------------------------------------ fees
create policy fee_item_read on fee_items for select
  using (is_super() or tenant_id = my_tenant());
create policy fee_item_write on fee_items for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));

-- students do NOT see fees; that stays between school and guardian
create policy invoice_read on fee_invoices for select
  using (
    is_super()
    or (tenant_id = my_tenant() and is_staff())
    or exists (select 1 from guardians g where g.student_id = fee_invoices.student_id and g.profile_id = auth.uid())
  );
create policy invoice_write on fee_invoices for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));

create policy payment_read on payments for select
  using (
    is_super()
    or (tenant_id = my_tenant() and is_staff())
    or exists (
      select 1 from fee_invoices i join guardians g on g.student_id = i.student_id
      where i.id = payments.invoice_id and g.profile_id = auth.uid())
  );
-- a guardian may start a payment; only the callback (service role) may complete it
create policy payment_insert on payments for insert
  with check (
    tenant_id = my_tenant() and status = 'pending' and exists (
      select 1 from fee_invoices i join guardians g on g.student_id = i.student_id
      where i.id = invoice_id and g.profile_id = auth.uid())
  );

-- ------------------------------------------------------------ comms
create policy announcement_read on announcements for select
  using (is_super() or (tenant_id = my_tenant() and (is_staff() or published_at is not null)));
create policy announcement_write on announcements for all
  using (is_super() or (tenant_id = my_tenant() and my_role() in ('school_admin','teacher')))
  with check (is_super() or (tenant_id = my_tenant() and my_role() in ('school_admin','teacher')));

create policy read_receipt_own on announcement_reads for all
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());

create policy assignment_read on assignments for select
  using (is_super() or tenant_id = my_tenant());
create policy assignment_write on assignments for all
  using (is_super() or (tenant_id = my_tenant() and is_staff()))
  with check (is_super() or (tenant_id = my_tenant() and is_staff()));

create policy submission_own on assignment_submissions for all
  using (student_id in (select my_students())) with check (student_id in (select my_students()));

-- ------------------------------------------------------------ oversight
-- schools may read their own audit trail; nobody may edit it
create policy audit_read on audit_events for select
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));
create policy audit_insert on audit_events for insert with check (true);

-- a school can see who from Figbloom entered their workspace
create policy impersonation_read on impersonation_sessions for select
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));
create policy impersonation_write on impersonation_sessions for all
  using (is_super()) with check (is_super());

create policy invite_read on invites for select
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));
create policy invite_write on invites for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));
