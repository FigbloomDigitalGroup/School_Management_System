-- FIG-1514 after FIG-1440: Reports' per-class attendance figures read both registers again, in the school's mode.
--
-- 20261106000200_afternoon_attendance.sql made term_class_figures() count attendance through attendance_counted(): both registers,
-- the school's percentage mode (by session or by day), and a live early sign-out leaving that afternoon's absence out (decisions D,
-- I, J, K). 20261106050000_learners_marked_in_term_figures.sql (FIG-1440) then dropped and re-made the function to add learners_marked,
-- "exactly as it was" before FIG-1514: its attendance part reads the morning table only. It sorts after FIG-1514's migration, so on any
-- database that has both, Reports lost the afternoon register, the by-day mode and the sign-out rule.
--
-- This is FIG-1440's definition unchanged (same columns including learners_marked, same area checks, same grants) with only the
-- attendance part ("a") taken from FIG-1514. No table, row or permission changes. The output columns are identical to FIG-1440's, so
-- the function is replaced in place.

create or replace function term_class_figures(p_tenant_id uuid, p_term_id uuid, p_exam_id uuid default null)
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
  -- FIG-1514: both registers, counted in the school's mode, a live early sign-out's afternoon absence left out (attendance_counted).
  a as (
    select x.class_id, count(*) filter (where x.here) as here, count(*) as total
      from attendance_counted(p_tenant_id, p_term_id) x join p on p.att
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
