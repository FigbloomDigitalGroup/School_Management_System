-- FIG-1440: Reports > Academic performance read "387 of 43" for a class's marks entered.
--
-- term_class_figures() gave the screen mark_count (every mark with a score: one per learner per subject, so 43 learners x 9 subjects = 387)
-- and roster (the learners, 43). The screen printed one "of" the other, two different units. It now also gets learners_marked: the learners
-- who have at least one score in the exam, each counted once however many subjects they have, so the screen can say "43 of 43 learners".
-- A learner with no mark, or only an absence (no score), is not counted. mark_sum and mark_count (the class mean) are unchanged.
--
-- A function cannot gain an output column in place, so it is dropped and made again exactly as it was, plus the one column, with the same
-- permissions: security definer, each part decided by the same area check as before, executable by signed-in users and not by anon.

drop function term_class_figures(uuid, uuid, uuid);

create function term_class_figures(p_tenant_id uuid, p_term_id uuid, p_exam_id uuid default null)
returns table(class_id uuid, roster bigint, att_here bigint, att_total bigint, billed bigint, paid bigint, mark_sum bigint, mark_count bigint, learners_marked bigint)
language sql stable security definer set search_path = public as $$
  with p as (
    select has_perm(p_tenant_id, 'attendance') as att, has_perm(p_tenant_id, 'fees') as fees,
           has_perm(p_tenant_id, 'academics') as acad, has_office_perm(p_tenant_id) as people
  ),
  r as (
    select s.class_id, count(*) as n
      from students s join p on p.people
     where s.tenant_id = p_tenant_id and s.active
     group by s.class_id
  ),
  a as (
    select x.class_id, count(*) filter (where x.mark in ('present', 'late')) as here, count(*) as total
      from attendance x join p on p.att
     where x.tenant_id = p_tenant_id and x.term_id = p_term_id
     group by x.class_id
  ),
  f as (
    select s.class_id, sum(i.total_cents)::bigint as billed, sum(i.paid_cents)::bigint as paid
      from fee_invoices i join students s on s.id = i.student_id and s.active join p on p.fees
     where i.tenant_id = p_tenant_id and i.term_id = p_term_id
     group by s.class_id
  ),
  m as (
    select s.class_id, sum(k.score)::bigint as total, count(k.score) as n, count(distinct k.student_id) filter (where k.score is not null) as learners
      from marks k join students s on s.id = k.student_id and s.active join p on p.acad
     where p_exam_id is not null and k.tenant_id = p_tenant_id and k.exam_id = p_exam_id
     group by s.class_id
  )
  select c.id, coalesce(r.n, 0), coalesce(a.here, 0), coalesce(a.total, 0), coalesce(f.billed, 0), coalesce(f.paid, 0),
         coalesce(m.total, 0), coalesce(m.n, 0), coalesce(m.learners, 0)
    from classes c cross join p
    left join r on r.class_id = c.id
    left join a on a.class_id = c.id
    left join f on f.class_id = c.id
    left join m on m.class_id = c.id
   where c.tenant_id = p_tenant_id and (p.att or p.fees or p.acad or p.people)
$$;

revoke execute on function term_class_figures(uuid, uuid, uuid) from public, anon;
grant execute on function term_class_figures(uuid, uuid, uuid) to authenticated;
