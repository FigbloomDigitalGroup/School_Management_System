-- Performance over time: the reads behind the "Progress over time" charts on
-- the family Results screens and the staff Performance screen.
--
-- Nothing new is stored. Three read-only functions return marks already in
-- the database, shaped for trends, and only marks that are published
-- (mark_publications, 20261023000000). Families can only see published marks
-- anyway, and staff charts also stop at published marks, so an exam that is
-- still being entered never drags a class mean down or plots half a class.
--
--   learner_results_history(student)   one learner's published marks across
--                                       every exam, each with its class mean.
--                                       One call per learner, where the
--                                       Results screen otherwise calls
--                                       class_means_for_exam() once per exam.
--   class_exam_performance(tenant, class)
--                                       per exam x class x subject: how many
--                                       sat it, the mean, the scores (no
--                                       names) for grade distributions, and
--                                       who teaches it now. Staff only.
--   class_learner_exam_means(class)     each learner's mean per exam, for
--                                       "most improved / dropped". Staff only.
--
-- An exam's place in time is its term (terms.starts_on), then when it went
-- out, then its name: exams have no date of their own. The ordering is done
-- client-side (packages/shared/src/performance.ts), so these return the parts.
--
-- A learner's class is their class today (students.class_id), the same rule
-- mark_read and class_means_for_exam already use.

create or replace function learner_results_history(p_student_id uuid)
returns table(
  exam_id uuid, exam_name text, term_id uuid, term_name text, term_starts_on date, published_at timestamptz,
  subject_id uuid, subject_name text, score int, class_mean numeric
)
language sql stable security definer set search_path = public as $$
  with learner as (
    select s.id, s.class_id, s.tenant_id
      from students s
     where s.id = p_student_id
       and (
         s.id in (select my_students())
         or (s.tenant_id = my_tenant() and is_staff())
         or may_administer(s.tenant_id)
       )
  )
  select e.id, e.name, t.id, t.name, t.starts_on, e.published_at,
         sub.id, sub.name, m.score,
         (select round(avg(cm.score), 1)
            from marks cm join students cs on cs.id = cm.student_id
           where cm.exam_id = m.exam_id and cm.subject_id = m.subject_id
             and cs.class_id = l.class_id and cm.score is not null)
    from learner l
    join marks m on m.student_id = l.id
    join exams e on e.id = m.exam_id
    join terms t on t.id = e.term_id
    join subjects sub on sub.id = m.subject_id
   where m.score is not null
     and marks_published(m.exam_id, l.class_id, m.subject_id)
$$;

create or replace function class_exam_performance(p_tenant_id uuid, p_class_id uuid default null)
returns table(
  exam_id uuid, exam_name text, term_id uuid, term_name text, term_starts_on date, published_at timestamptz,
  class_id uuid, class_name text, subject_id uuid, subject_name text,
  teacher_id uuid, teacher_name text,
  learners int, mean_score numeric, scores int[]
)
language sql stable security definer set search_path = public as $$
  select e.id, e.name, t.id, t.name, t.starts_on, e.published_at,
         c.id, c.name, sub.id, sub.name,
         ta.teacher_id, p.full_name,
         count(*)::int, round(avg(m.score), 1), array_agg(m.score order by m.score)
    from mark_publications mp
    join exams e on e.id = mp.exam_id
    join terms t on t.id = e.term_id
    join classes c on c.id = mp.class_id
    join subjects sub on sub.id = mp.subject_id
    join marks m on m.exam_id = mp.exam_id and m.subject_id = mp.subject_id
    join students s on s.id = m.student_id and s.class_id = mp.class_id
    left join teaching_assignments ta on ta.class_id = mp.class_id and ta.subject_id = mp.subject_id
    left join profiles p on p.id = ta.teacher_id
   where mp.tenant_id = p_tenant_id
     and (p_class_id is null or mp.class_id = p_class_id)
     and m.score is not null
     and (may_administer(p_tenant_id) or (p_tenant_id = my_tenant() and is_staff()))
   group by e.id, e.name, t.id, t.name, t.starts_on, e.published_at, c.id, c.name, sub.id, sub.name, ta.teacher_id, p.full_name
$$;

create or replace function class_learner_exam_means(p_class_id uuid)
returns table(exam_id uuid, student_id uuid, full_name text, mean_score numeric, subjects int)
language sql stable security definer set search_path = public as $$
  select m.exam_id, s.id, s.full_name, round(avg(m.score), 1), count(*)::int
    from students s
    join marks m on m.student_id = s.id
   where s.class_id = p_class_id
     and s.active
     and m.score is not null
     and marks_published(m.exam_id, p_class_id, m.subject_id)
     and (may_administer(s.tenant_id) or (s.tenant_id = my_tenant() and is_staff()))
   group by m.exam_id, s.id, s.full_name
$$;

revoke execute on function learner_results_history(uuid) from public, anon;
revoke execute on function class_exam_performance(uuid, uuid) from public, anon;
revoke execute on function class_learner_exam_means(uuid) from public, anon;
grant execute on function learner_results_history(uuid) to authenticated;
grant execute on function class_exam_performance(uuid, uuid) to authenticated;
grant execute on function class_learner_exam_means(uuid) to authenticated;
