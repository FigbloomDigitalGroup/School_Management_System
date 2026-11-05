-- FIG-1438, FIG-1402, FIG-1439: the totals on Reports and the Dashboard are worked out in the database.
--
-- The screens read every invoice, register entry and mark of the term through the API and added them up in the browser. The API
-- answers at most 1,000 rows and says nothing when it stops, so past 1,000 rows the totals were sums of the first 1,000 in whatever
-- order the database happened to return them (KSh 5,408,050 of 10,328,000 collected on one run, 1,633,700 of 3,153,500 on the next;
-- Kijani Ridge's "1,000 register entries" when it has 3,360; class means from 1,000 of 1,275 marks).
--
-- Two read-only functions return the figures already added up, one row per class (no names, no rows of anyone's record):
--
--   term_class_figures(tenant, term, exam)  per class: active learners, register entries (here = present or late, and all), billed and
--                                           paid for the term's invoices of active learners, and the sum and count of the exam's
--                                           marks of active learners. The exam is optional.
--   term_fee_totals(tenant, term)           billed and paid over every invoice of the term, whoever the learner is, with how many
--                                           invoices there are and how many are unpaid, part paid, paid in full and owing (what the
--                                           Dashboard shows).
--
-- They are SECURITY DEFINER so the permission check runs once, not once per row, which is what made reading a term of attendance take
-- 21 s at a school of 1,512 learners (FIG-1500). Each part gives a caller exactly what the table's own read rule gives them, decided
-- the same way: attendance by has_perm(tenant, 'attendance'), invoices by 'fees', marks by 'academics', learners by has_office_perm.
-- A part the caller may not read counts as zero in term_class_figures; a caller who may read none of them gets no rows, and a caller with no
-- right to the fees gets no row from term_fee_totals. has_perm is tied to the tenant given
-- (it is true only for that school's admins, the group's admins, platform staff, or someone with that area in that school).
--
-- The arithmetic is what the screens did: a register entry counts as here when it is present or late; invoices and marks are those of
-- learners who are active now, grouped by the learner's class today; attendance is grouped by the class the register was taken for;
-- marks count only the ones with a score. Whether archived learners' invoices belong in the report (FIG-1501) and whether unpublished
-- marks belong in a class mean (FIG-1441) are separate bugs and are left as they were.

create or replace function term_class_figures(p_tenant_id uuid, p_term_id uuid, p_exam_id uuid default null)
returns table(class_id uuid, roster bigint, att_here bigint, att_total bigint, billed bigint, paid bigint, mark_sum bigint, mark_count bigint)
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
    select s.class_id, sum(k.score)::bigint as total, count(k.score) as n
      from marks k join students s on s.id = k.student_id and s.active join p on p.acad
     where p_exam_id is not null and k.tenant_id = p_tenant_id and k.exam_id = p_exam_id
     group by s.class_id
  )
  select c.id, coalesce(r.n, 0), coalesce(a.here, 0), coalesce(a.total, 0), coalesce(f.billed, 0), coalesce(f.paid, 0),
         coalesce(m.total, 0), coalesce(m.n, 0)
    from classes c cross join p
    left join r on r.class_id = c.id
    left join a on a.class_id = c.id
    left join f on f.class_id = c.id
    left join m on m.class_id = c.id
   where c.tenant_id = p_tenant_id and (p.att or p.fees or p.acad or p.people)
$$;

create or replace function term_fee_totals(p_tenant_id uuid, p_term_id uuid)
returns table(billed bigint, paid bigint, invoices bigint, nothing_paid bigint, part_paid bigint, full_paid bigint, owing bigint)
language sql stable security definer set search_path = public as $$
  -- An aggregate with no GROUP BY always makes one row, so the outer filter is what gives a caller with no right to the fees no row at
  -- all (not a row of zeros that looks like a school with no invoices); the inner one keeps the invoices from being read for them.
  select x.* from (
    select coalesce(sum(i.total_cents), 0)::bigint as billed, coalesce(sum(i.paid_cents), 0)::bigint as paid, count(*) as invoices,
           count(*) filter (where i.paid_cents = 0) as nothing_paid,
           count(*) filter (where i.paid_cents > 0 and i.paid_cents < i.total_cents) as part_paid,
           count(*) filter (where i.paid_cents >= i.total_cents and i.total_cents > 0) as full_paid,
           count(*) filter (where i.paid_cents < i.total_cents) as owing
      from fee_invoices i
     where i.tenant_id = p_tenant_id and i.term_id = p_term_id and has_perm(p_tenant_id, 'fees')
  ) x
   where has_perm(p_tenant_id, 'fees')
$$;

revoke execute on function term_class_figures(uuid, uuid, uuid) from public, anon;
revoke execute on function term_fee_totals(uuid, uuid) from public, anon;
grant execute on function term_class_figures(uuid, uuid, uuid) to authenticated;
grant execute on function term_fee_totals(uuid, uuid) to authenticated;
