-- FIG-391: full read+write parity for an org_admin acting within any school
-- that belongs to one of their own organizations -- confirmed scope (not
-- staged): the same operational surface that school's own school_admin
-- already has (students, staff, fees, classes, attendance, marks,
-- announcements, etc.), not just the read-only aggregate view built in
-- FIG-332. Mirrors is_super()'s existing "OR'd into every policy" pattern
-- in 20260901000001_rls.sql, scoped to "tenants in my own organization"
-- instead of "every tenant everywhere".
--
-- Every change below is purely additive: an existing clause is never
-- removed or narrowed, only OR'd with a new org_admin branch — nothing a
-- school_admin, teacher, parent, or student could already do changes.
--
-- may_administer(tenant_id) is the one shared building block most of the
-- widened WRITE policies below reuse, instead of repeating the org_admin
-- branch inline across ~15 policies (which would also risk drifting out of
-- sync). It intentionally folds in is_super()/school_admin too, so it can
-- fully replace the old "is_super() or (tenant_id = my_tenant() and
-- my_role() = 'school_admin')" shape wherever that exact shape appears.
create or replace function may_administer(target_tenant_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select
    is_super()
    or (target_tenant_id = my_tenant() and my_role() = 'school_admin')
    or (is_org_admin() and target_tenant_id in (select my_organization_tenant_ids()))
$$;

-- tenants: the org_admin needs to be able to read the tenant row itself
-- (name, branding, settings) for a school they're about to act inside —
-- without this, session resolution for "enter school console" (FIG-392)
-- has nothing to resolve.
drop policy tenant_read_own on tenants;
create policy tenant_read_own on tenants for select
  using (is_super() or id = my_tenant() or (is_org_admin() and id in (select my_organization_tenant_ids())));

-- profiles: the school's own staff/parent/student accounts
drop policy profile_admin_manage on profiles;
create policy profile_admin_manage on profiles for all
  using (may_administer(tenant_id)) with check (may_administer(tenant_id));

-- my_students(): the shared "which students can this caller see" helper —
-- widening it here automatically extends student_read, attendance_read,
-- the guardian/student branch of mark_read, and assignment_submissions
-- (submission_own uses it for both read and write, the same way school_admin
-- already gets full read+write there via is_staff()).
create or replace function my_students() returns setof uuid
language sql stable security definer set search_path = public as $$
  select s.id from students s
  where (
    s.tenant_id = my_tenant()
    and (
      is_staff()
      or exists (select 1 from guardians g where g.student_id = s.id and g.profile_id = auth.uid())
      or s.profile_id = auth.uid()
    )
  )
  or (is_org_admin() and s.tenant_id in (select my_organization_tenant_ids()))
$$;

-- terms, classes, subjects: readable by anyone in the school, writable by admins
do $$
declare t text;
begin
  foreach t in array array['terms','classes','subjects'] loop
    execute format($f$
      drop policy %1$s_read on %1$s;
      create policy %1$s_read on %1$s for select
        using (is_super() or tenant_id = my_tenant() or may_administer(tenant_id));
      drop policy %1$s_write on %1$s;
      create policy %1$s_write on %1$s for all
        using (may_administer(tenant_id)) with check (may_administer(tenant_id));
    $f$, t);
  end loop;
end $$;

-- students
drop policy student_write on students;
create policy student_write on students for all
  using (may_administer(tenant_id)) with check (may_administer(tenant_id));

-- guardians
drop policy guardian_read on guardians;
create policy guardian_read on guardians for select
  using (is_super() or profile_id = auth.uid() or (tenant_id = my_tenant() and is_staff()) or may_administer(tenant_id));
drop policy guardian_write on guardians;
create policy guardian_write on guardians for all
  using (may_administer(tenant_id)) with check (may_administer(tenant_id));

-- teaching_assignments
drop policy teaching_read on teaching_assignments;
create policy teaching_read on teaching_assignments for select
  using (is_super() or tenant_id = my_tenant() or may_administer(tenant_id));
drop policy teaching_write on teaching_assignments;
create policy teaching_write on teaching_assignments for all
  using (may_administer(tenant_id)) with check (may_administer(tenant_id));

-- attendance: keep the teacher-specific branches untouched, widen the
-- school_admin branch to may_administer(), and widen the with check the
-- same way -- it was narrower than using() before (`tenant_id = my_tenant()
-- or is_super()`), which would have silently blocked an org_admin from ever
-- writing, since their own my_tenant() is always null.
drop policy attendance_write on attendance;
create policy attendance_write on attendance for all
  using (
    may_administer(tenant_id)
    or (tenant_id = my_tenant() and my_role() = 'teacher' and exists (
          select 1 from teaching_assignments ta
          where ta.teacher_id = auth.uid() and ta.class_id = attendance.class_id))
    or (tenant_id = my_tenant() and exists (
          select 1 from classes c where c.id = attendance.class_id and c.class_teacher_id = auth.uid()))
  )
  with check (may_administer(tenant_id) or tenant_id = my_tenant());

-- exams
drop policy exam_read on exams;
create policy exam_read on exams for select
  using (is_super() or (tenant_id = my_tenant() and (is_staff() or published_at is not null)) or may_administer(tenant_id));
drop policy exam_write on exams;
create policy exam_write on exams for all
  using (may_administer(tenant_id)) with check (may_administer(tenant_id));

-- marks
drop policy mark_read on marks;
create policy mark_read on marks for select
  using (
    is_super()
    or (tenant_id = my_tenant() and is_staff())
    or may_administer(tenant_id)
    or (student_id in (select my_students())
        and exists (select 1 from exams e where e.id = marks.exam_id and e.published_at is not null))
  );
drop policy mark_write on marks;
create policy mark_write on marks for all
  using (
    may_administer(tenant_id)
    or (tenant_id = my_tenant() and my_role() = 'teacher' and exists (
          select 1 from teaching_assignments ta
          where ta.teacher_id = auth.uid() and ta.subject_id = marks.subject_id))
  )
  with check (may_administer(tenant_id) or tenant_id = my_tenant());

-- fees
drop policy fee_item_read on fee_items;
create policy fee_item_read on fee_items for select
  using (is_super() or tenant_id = my_tenant() or may_administer(tenant_id));
drop policy fee_item_write on fee_items;
create policy fee_item_write on fee_items for all
  using (may_administer(tenant_id)) with check (may_administer(tenant_id));

drop policy invoice_read on fee_invoices;
create policy invoice_read on fee_invoices for select
  using (
    is_super()
    or (tenant_id = my_tenant() and is_staff())
    or may_administer(tenant_id)
    or exists (select 1 from guardians g where g.student_id = fee_invoices.student_id and g.profile_id = auth.uid())
  );
drop policy invoice_write on fee_invoices;
create policy invoice_write on fee_invoices for all
  using (may_administer(tenant_id)) with check (may_administer(tenant_id));

drop policy payment_read on payments;
create policy payment_read on payments for select
  using (
    is_super()
    or (tenant_id = my_tenant() and is_staff())
    or may_administer(tenant_id)
    or exists (
      select 1 from fee_invoices i join guardians g on g.student_id = i.student_id
      where i.id = payments.invoice_id and g.profile_id = auth.uid())
  );
-- no payment_write policy exists for school_admin either (payments are
-- guardian-initiated or service-role-completed) -- "full parity with
-- school_admin" means org_admin gets exactly that same non-access here too.

-- comms: announcement_write/assignment_write currently allow school_admin
-- AND teacher via is_staff() -- keep the teacher half untouched, widen the
-- admin half to may_administer().
drop policy announcement_read on announcements;
create policy announcement_read on announcements for select
  using (is_super() or (tenant_id = my_tenant() and (is_staff() or published_at is not null)) or may_administer(tenant_id));
drop policy announcement_write on announcements;
create policy announcement_write on announcements for all
  using (may_administer(tenant_id) or (tenant_id = my_tenant() and my_role() = 'teacher'))
  with check (may_administer(tenant_id) or (tenant_id = my_tenant() and my_role() = 'teacher'));

drop policy assignment_read on assignments;
create policy assignment_read on assignments for select
  using (is_super() or tenant_id = my_tenant() or may_administer(tenant_id));
drop policy assignment_write on assignments;
create policy assignment_write on assignments for all
  using (may_administer(tenant_id) or (tenant_id = my_tenant() and my_role() = 'teacher'))
  with check (may_administer(tenant_id) or (tenant_id = my_tenant() and my_role() = 'teacher'));

-- oversight: read-only for the org owner, same as school_admin already has
drop policy audit_read on audit_events;
create policy audit_read on audit_events for select
  using (may_administer(tenant_id));

drop policy impersonation_read on impersonation_sessions;
create policy impersonation_read on impersonation_sessions for select
  using (may_administer(tenant_id));

drop policy invite_read on invites;
create policy invite_read on invites for select
  using (may_administer(tenant_id));
drop policy invite_write on invites;
create policy invite_write on invites for all
  using (may_administer(tenant_id)) with check (may_administer(tenant_id));
