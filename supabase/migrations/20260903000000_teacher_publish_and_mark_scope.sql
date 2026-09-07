-- Two real RLS gaps found on review:
--
-- 1. exam_write only granted school_admin/super_admin. The Gradebook screen's
--    "Publish marks" button (a teacher-only surface) calls
--    exams.update({published_at}) directly from the client — RLS silently
--    filtered that update to zero rows (no error, since an update matching
--    nothing isn't a Postgres error), so the button showed a success toast
--    for a publish that never happened.
--
-- 2. mark_write checked teaching_assignments by subject_id only, not
--    class_id, even though the table is keyed per (class_id, subject_id).
--    A teacher assigned Chemistry for Form 2 West could upsert Chemistry
--    marks for a student in ANY class, not just their own.

create policy exam_publish_teacher on exams for update
  using (tenant_id = my_tenant() and my_role() = 'teacher')
  with check (tenant_id = my_tenant() and my_role() = 'teacher');

drop policy mark_write on marks;
create policy mark_write on marks for all
  using (
    is_super()
    or (tenant_id = my_tenant() and my_role() = 'school_admin')
    or (tenant_id = my_tenant() and my_role() = 'teacher' and exists (
          select 1 from teaching_assignments ta
          join students s on s.id = marks.student_id
          where ta.teacher_id = auth.uid() and ta.subject_id = marks.subject_id and ta.class_id = s.class_id))
  )
  with check (tenant_id = my_tenant() or is_super());
