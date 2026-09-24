-- Two live write gaps on marks and attendance, both from
-- 20260916110000_org_admin_full_school_access.sql (FIG-391) recreating the
-- policies to add may_administer():
--
-- 1. mark_write lost its class scoping. 20260903000000 had fixed it to require
--    the teacher's teaching_assignment for THAT student's class
--    (ta.class_id = s.class_id); FIG-391 rewrote it with subject_id only, so a
--    teacher assigned Chemistry for Form 2 West could again write Chemistry
--    marks for a learner in any class.
--
-- 2. Worse, both policies' WITH CHECK was just
--    `may_administer(tenant_id) or tenant_id = my_tenant()`. An INSERT is
--    checked against WITH CHECK only -- USING never runs for it -- so any
--    signed-in member of the school (a student or parent account included)
--    could insert marks or attendance rows directly through the API, whatever
--    USING said. Upserting over an existing row goes through USING for the
--    update half, which is why the app itself never tripped over this.
--
-- Fix: WITH CHECK repeats USING exactly, so the rule for creating a row is the
-- rule for changing one. Everything else is kept as FIG-391 left it,
-- including may_administer() for org_admins acting inside a school and the
-- class teacher's attendance branch.

drop policy mark_write on marks;
create policy mark_write on marks for all
  using (
    may_administer(tenant_id)
    or (tenant_id = my_tenant() and my_role() = 'teacher' and exists (
          select 1 from teaching_assignments ta
          join students s on s.id = marks.student_id
          where ta.teacher_id = auth.uid()
            and ta.subject_id = marks.subject_id
            and ta.class_id = s.class_id))
  )
  with check (
    may_administer(tenant_id)
    or (tenant_id = my_tenant() and my_role() = 'teacher' and exists (
          select 1 from teaching_assignments ta
          join students s on s.id = marks.student_id
          where ta.teacher_id = auth.uid()
            and ta.subject_id = marks.subject_id
            and ta.class_id = s.class_id))
  );

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
  with check (
    may_administer(tenant_id)
    or (tenant_id = my_tenant() and my_role() = 'teacher' and exists (
          select 1 from teaching_assignments ta
          where ta.teacher_id = auth.uid() and ta.class_id = attendance.class_id))
    or (tenant_id = my_tenant() and exists (
          select 1 from classes c where c.id = attendance.class_id and c.class_teacher_id = auth.uid()))
  );
