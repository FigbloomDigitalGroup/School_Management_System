-- Row-level security that works out the caller's rights once per statement, not once per row.
--
-- The read policies on the busy tables called has_perm(tenant_id, ...), has_office_perm(tenant_id)
-- and is_super() on every row. Each is a security-definer function (never inlined), and has_perm
-- reads profiles, tenants, organization_admins, staff_permissions and school roles, so a bursar
-- counting a school's 983 learners spent ~6 s in permission checks, and the Fees page (invoices
-- with their learner and class embedded) passed the 8 s statement timeout. Permissive FOR ALL
-- policies are ORed into reads, so their per-row checks ran on every read too.
--
-- The fix keeps who-can-see-what exactly as it was and changes only how it is evaluated:
--
--   has_perm(t, area)    becomes  (select is_super()) or t in (select my_perm_tenant_ids(area))
--   has_office_perm(t)   becomes  (select is_super()) or t in (select my_office_tenant_ids())
--   may_administer(t)    becomes  (select is_super()) or t in (select my_administered_tenant_ids())
--   is_guardian_of(s)    becomes  s in (select my_guardian_student_ids())
--   may_assess(t, c, s)  becomes  the has_perm form above or (t = (select my_tenant()) and
--                                 (select my_role()) = 'teacher' and (c, s) in (select my_teaching_pairs()))
--   is_super(), my_tenant(), my_role(), is_staff(), auth.uid()  become  (select ...)
--
-- An uncorrelated (select f()) is planned as an InitPlan and "x in (select srf())" as a hashed
-- SubPlan, both run once per statement. A correlated EXISTS (... where inner.col = outer.col and
-- inner.owner = auth.uid()) becomes outer.col in (select inner.col ... where inner.owner = ...),
-- which still reads the inner table under the caller's own policies, as the EXISTS did.
-- (EXISTS and IN differ only when outer.col is null, where EXISTS gives false and IN gives null;
-- inside these ORs a null result hides the row, or fails a WITH CHECK, exactly as false does.)
--
-- The new set-returning functions mirror the definitions in 20261031000000_admin_areas and
-- 20261103200000_null_safe_permission_checks (may_administer, my_areas, has_perm,
-- has_office_perm). supabase/rls-checks/rls_once_per_query.sql asserts they agree with
-- has_perm / has_office_perm / may_administer / is_guardian_of / may_assess for every kind of
-- caller. If those functions change, change these with them.
--
-- Tables: students, fee_invoices, payments, payment_proofs, fee_items, classes, guardians,
-- profiles, attendance, marks, cbe_results, cbe_assessments, exams, teaching_assignments,
-- mark_publications, inventory_items, inventory_issues, inventory_movements, sick_bay_visits,
-- visit_medications: every SELECT and FOR ALL policy (FOR ALL is ORed into reads), plus
-- fee_invoices' insert/update (term billing writes a row per learner). Left as they were, being
-- already fast or only ever checked on a single row: fee_charges_read (an EXISTS on fee_invoices,
-- now cheap), announcements (a few dozen rows a school), and the single-row INSERT/UPDATE/DELETE
-- policies of the other tables.
--
-- Policies are changed with ALTER POLICY: names, commands and roles stay as they were.
--
-- Attendance: the four attendance migrations of 2026-11-10 (20261110160000 to 20261110190000)
-- define functions and triggers only, not policies, and nothing here touches what they define,
-- so this applies the same with or without them.

-- ================================================================ caller's rights, as sets

-- Schools the caller administers in full (may_administer, minus its is_super() branch).
create or replace function my_administered_tenant_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select my_tenant() where my_role() = 'school_admin' and my_tenant() is not null
  union
  select t from my_organization_tenant_ids() t where is_org_admin()
$$;

-- Schools where has_perm(school, p_area) is true for the caller, other than through is_super().
-- has_perm(t, a) = is_super() or (t is not null and t in my_perm_tenant_ids(a)).
create or replace function my_perm_tenant_ids(p_area text) returns setof uuid
language sql stable security definer set search_path = public as $$
  select my_administered_tenant_ids()
  union
  select my_tenant() where exists (select 1 from my_areas(my_tenant()) a where a = p_area)
$$;

-- Schools where has_office_perm(school) is true for the caller, other than through is_super().
create or replace function my_office_tenant_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select my_administered_tenant_ids()
  union
  select my_tenant() where exists (select 1 from my_areas(my_tenant()) a where a <> 'visitors')
$$;

-- Learners the caller is a guardian of (is_guardian_of(s) = s in this set).
create or replace function my_guardian_student_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select g.student_id from guardians g where g.profile_id = auth.uid()
$$;

-- The (class, subject) pairs the caller is assigned to teach: may_assess's teaching-assignment
-- test, read the same way (security definer, so not through teaching_assignments' policies).
create or replace function my_teaching_pairs() returns table (class_id uuid, subject_id uuid)
language sql stable security definer set search_path = public as $$
  select ta.class_id, ta.subject_id from teaching_assignments ta where ta.teacher_id = auth.uid()
$$;

-- ================================================================ students

alter policy student_read on students using (
  (select is_super())
  or id in (select my_students())
  or tenant_id in (select my_office_tenant_ids())
);

alter policy student_write on students
  using ((select is_super()) or tenant_id in (select my_perm_tenant_ids('people')))
  with check ((select is_super()) or tenant_id in (select my_perm_tenant_ids('people')));

-- ================================================================ fees

alter policy invoice_read on fee_invoices using (
  (select is_super())
  or tenant_id in (select my_perm_tenant_ids('fees'))
  or student_id in (select g.student_id from guardians g where g.profile_id = (select auth.uid()))
  or student_id in (select s.id from students s where s.profile_id = (select auth.uid()))
);

alter policy invoice_insert on fee_invoices
  with check ((select is_super()) or tenant_id in (select my_perm_tenant_ids('fees')));

alter policy invoice_update on fee_invoices
  using ((select is_super()) or tenant_id in (select my_perm_tenant_ids('fees')))
  with check ((select is_super()) or tenant_id in (select my_perm_tenant_ids('fees')));

alter policy payment_read on payments using (
  (select is_super())
  or tenant_id in (select my_perm_tenant_ids('fees'))
  or invoice_id in (select i.id from fee_invoices i join guardians g on g.student_id = i.student_id
                     where g.profile_id = (select auth.uid()))
  or invoice_id in (select i.id from fee_invoices i join students s on s.id = i.student_id
                     where s.profile_id = (select auth.uid()))
);

alter policy payment_proofs_read on payment_proofs using (
  (select is_super())
  or tenant_id in (select my_perm_tenant_ids('fees'))
  or invoice_id in (select i.id from fee_invoices i join guardians g on g.student_id = i.student_id
                     where g.profile_id = (select auth.uid()))
  or invoice_id in (select i.id from fee_invoices i join students s on s.id = i.student_id
                     where s.profile_id = (select auth.uid()))
);

alter policy fee_item_read on fee_items using (
  (select is_super())
  or tenant_id = (select my_tenant())
  or tenant_id in (select my_perm_tenant_ids('fees'))
);

alter policy fee_item_write on fee_items
  using ((select is_super()) or tenant_id in (select my_perm_tenant_ids('fees')))
  with check ((select is_super()) or tenant_id in (select my_perm_tenant_ids('fees')));

-- ================================================================ people

alter policy classes_read on classes using (
  (select is_super())
  or tenant_id = (select my_tenant())
  or tenant_id in (select my_perm_tenant_ids('academics'))
);

alter policy classes_write on classes
  using ((select is_super()) or tenant_id in (select my_perm_tenant_ids('academics')))
  with check ((select is_super()) or tenant_id in (select my_perm_tenant_ids('academics')));

alter policy guardian_read on guardians using (
  (select is_super())
  or profile_id = (select auth.uid())
  or (tenant_id = (select my_tenant()) and (select is_staff()))
  or tenant_id in (select my_office_tenant_ids())
);

alter policy guardian_write on guardians
  using ((select is_super()) or tenant_id in (select my_perm_tenant_ids('people')))
  with check ((select is_super()) or tenant_id in (select my_perm_tenant_ids('people')));

alter policy profile_read_self on profiles using (
  id = (select auth.uid())
  or (select is_super())
  or (tenant_id = (select my_tenant()) and (select is_staff()))
  or (role = 'org_admin'::app_role
      and id in (select organization_admins.profile_id from organization_admins
                  where organization_admins.organization_id in (select my_organization_ids())))
  or tenant_id in (select my_office_tenant_ids())
);

alter policy profile_admin_manage on profiles
  using (
    (select is_super())
    or tenant_id in (select my_administered_tenant_ids())
    or (tenant_id in (select my_perm_tenant_ids('people'))
        and id <> (select auth.uid())
        and role = any (array['teacher', 'staff', 'driver', 'parent', 'student']::app_role[]))
  )
  with check (
    (select is_super())
    or tenant_id in (select my_administered_tenant_ids())
    or (tenant_id in (select my_perm_tenant_ids('people'))
        and id <> (select auth.uid())
        and role = any (array['teacher', 'staff', 'driver', 'parent', 'student']::app_role[]))
  );

-- ================================================================ attendance

alter policy attendance_read on attendance using (
  (select is_super())
  or student_id in (select my_students())
  or tenant_id in (select my_perm_tenant_ids('attendance'))
);

alter policy attendance_write on attendance
  using (
    (select is_super())
    or tenant_id in (select my_perm_tenant_ids('attendance'))
    or (tenant_id = (select my_tenant()) and (select my_role()) = 'teacher'::app_role
        and class_id in (select ta.class_id from teaching_assignments ta where ta.teacher_id = (select auth.uid())))
    or (tenant_id = (select my_tenant())
        and class_id in (select c.id from classes c where c.class_teacher_id = (select auth.uid())))
  )
  with check (
    (select is_super())
    or tenant_id in (select my_perm_tenant_ids('attendance'))
    or (tenant_id = (select my_tenant()) and (select my_role()) = 'teacher'::app_role
        and class_id in (select ta.class_id from teaching_assignments ta where ta.teacher_id = (select auth.uid())))
    or (tenant_id = (select my_tenant())
        and class_id in (select c.id from classes c where c.class_teacher_id = (select auth.uid())))
  );

-- ================================================================ marks and CBE results

alter policy mark_read on marks using (
  (select is_super())
  or tenant_id in (select my_perm_tenant_ids('academics'))
  or (tenant_id = (select my_tenant()) and (select my_role()) = 'teacher'::app_role
      and ((student_id, subject_id) in (select s.id, ta.subject_id
                                          from teaching_assignments ta join students s on s.class_id = ta.class_id
                                         where ta.teacher_id = (select auth.uid()))
           or student_id in (select s.id from students s join classes c on c.id = s.class_id
                              where c.class_teacher_id = (select auth.uid()))))
  or (student_id in (select my_family_students())
      and exists (select 1 from students s
                   where s.id = marks.student_id and marks_published(marks.exam_id, s.class_id, marks.subject_id)))
);

alter policy mark_write on marks
  using (
    (select is_super())
    or tenant_id in (select my_perm_tenant_ids('academics'))
    or (tenant_id = (select my_tenant()) and (select my_role()) = 'teacher'::app_role
        and (student_id, subject_id) in (select s.id, ta.subject_id
                                           from teaching_assignments ta join students s on s.class_id = ta.class_id
                                          where ta.teacher_id = (select auth.uid())))
  )
  with check (
    (select is_super())
    or tenant_id in (select my_perm_tenant_ids('academics'))
    or (tenant_id = (select my_tenant()) and (select my_role()) = 'teacher'::app_role
        and (student_id, subject_id) in (select s.id, ta.subject_id
                                           from teaching_assignments ta join students s on s.class_id = ta.class_id
                                          where ta.teacher_id = (select auth.uid())))
  );

alter policy cbe_result_read on cbe_results using (
  (select is_super())
  or tenant_id in (select my_perm_tenant_ids('academics'))
  or (tenant_id = (select my_tenant()) and (select is_staff()))
  or (student_id in (select my_students())
      and exists (select 1 from cbe_assessments a
                   where a.id = cbe_results.assessment_id and a.published_at is not null))
);

alter policy cbe_assessment_read on cbe_assessments using (
  (select is_super())
  or tenant_id in (select my_perm_tenant_ids('academics'))
  or (tenant_id = (select my_tenant()) and ((select is_staff()) or published_at is not null))
);

-- may_assess(t, c, s) = has_perm(t, 'academics') or (t = my_tenant() and my_role() = 'teacher' and
-- a teaching assignment for c and s), spelled out with the sets above so nothing runs per row.
alter policy cbe_assessment_write on cbe_assessments
  using (
    (select is_super())
    or tenant_id in (select my_perm_tenant_ids('academics'))
    or (tenant_id = (select my_tenant()) and (select my_role()) = 'teacher'::app_role
        and (class_id, subject_id) in (select p.class_id, p.subject_id from my_teaching_pairs() p)))
  with check (
    (select is_super())
    or tenant_id in (select my_perm_tenant_ids('academics'))
    or (tenant_id = (select my_tenant()) and (select my_role()) = 'teacher'::app_role
        and (class_id, subject_id) in (select p.class_id, p.subject_id from my_teaching_pairs() p)));

-- (the same split, inside the subquery over assessments)
alter policy cbe_result_write on cbe_results
  using (assessment_id in (
    select a.id from cbe_assessments a
     where (select is_super())
        or a.tenant_id in (select my_perm_tenant_ids('academics'))
        or (a.tenant_id = (select my_tenant()) and (select my_role()) = 'teacher'::app_role
            and (a.class_id, a.subject_id) in (select p.class_id, p.subject_id from my_teaching_pairs() p))))
  with check (assessment_id in (
    select a.id from cbe_assessments a
     where (select is_super())
        or a.tenant_id in (select my_perm_tenant_ids('academics'))
        or (a.tenant_id = (select my_tenant()) and (select my_role()) = 'teacher'::app_role
            and (a.class_id, a.subject_id) in (select p.class_id, p.subject_id from my_teaching_pairs() p))));

alter policy exam_read on exams using (
  (select is_super())
  or (tenant_id = (select my_tenant()) and ((select is_staff()) or published_at is not null))
  or tenant_id in (select my_perm_tenant_ids('academics'))
);

alter policy exam_write on exams
  using ((select is_super()) or tenant_id in (select my_perm_tenant_ids('academics')))
  with check ((select is_super()) or tenant_id in (select my_perm_tenant_ids('academics')));

-- read inside the marks and attendance policies above
alter policy teaching_read on teaching_assignments using (
  (select is_super())
  or tenant_id = (select my_tenant())
  or tenant_id in (select my_perm_tenant_ids('academics'))
);

alter policy teaching_write on teaching_assignments
  using ((select is_super()) or tenant_id in (select my_perm_tenant_ids('academics')))
  with check ((select is_super()) or tenant_id in (select my_perm_tenant_ids('academics')));

alter policy mark_publications_read on mark_publications using (
  (select is_super())
  or tenant_id in (select my_perm_tenant_ids('academics'))
  or (tenant_id = (select my_tenant()) and (select is_staff()))
);

-- ================================================================ inventory

alter policy inventory_items_read on inventory_items using (
  (select is_super())
  or tenant_id in (select my_perm_tenant_ids('inventory'))
  or (tenant_id = (select my_tenant()) and (select is_staff()))
  or exists (select 1 from inventory_issues i
              where i.item_id = inventory_items.id
                and (i.profile_id = (select auth.uid()) or i.student_id in (select my_students())))
);

alter policy inventory_items_write on inventory_items
  using ((select is_super()) or tenant_id in (select my_perm_tenant_ids('inventory')))
  with check ((select is_super()) or tenant_id in (select my_perm_tenant_ids('inventory')));

alter policy inventory_issues_read on inventory_issues using (
  (select is_super())
  or tenant_id in (select my_perm_tenant_ids('inventory'))
  or (tenant_id = (select my_tenant()) and (select is_staff()))
  or profile_id = (select auth.uid())
  or student_id in (select my_students())
);

alter policy inventory_movements_read on inventory_movements using (
  (select is_super())
  or tenant_id in (select my_perm_tenant_ids('inventory'))
  or (tenant_id = (select my_tenant()) and (select is_staff()))
);

-- ================================================================ sick bay

alter policy sick_bay_visits_read on sick_bay_visits using (
  (select is_super())
  or tenant_id in (select my_perm_tenant_ids('medical'))
  or student_id in (select my_guardian_student_ids())
);

alter policy visit_medications_read on visit_medications using (
  (select is_super())
  or tenant_id in (select my_perm_tenant_ids('medical'))
  or visit_id in (select v.id from sick_bay_visits v where v.student_id in (select my_guardian_student_ids()))
);
