-- mark_read only lets a parent/student SELECT their own child's/own marks
-- rows (by design -- nobody should be able to read another student's
-- individual score). parentData.ts and studentData.ts were computing "class
-- mean" by averaging whatever marks rows the client got back for that
-- class+exam -- but RLS silently strips every row except the caller's own
-- child, so that "average" always degenerated to the child's own score
-- (visible as "exactly the class mean" for a parent with one child in the
-- class). This computes the real class-wide mean server side and hands back
-- only the aggregate number, never another student's individual score.

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
    and exists (select 1 from exams e where e.id = p_exam_id and e.published_at is not null)
  group by m.subject_id
$$;

revoke all on function class_means_for_exam(uuid, uuid) from public;
grant execute on function class_means_for_exam(uuid, uuid) to authenticated;
