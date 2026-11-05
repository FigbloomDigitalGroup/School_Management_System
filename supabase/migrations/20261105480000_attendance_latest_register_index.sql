-- FIG-1496: the admin Dashboard's "latest register date" no longer times out for a school of 1,500 learners.
--
-- The Dashboard asks for the newest register date of the current term:
--   select taken_on from attendance where tenant_id = ? and term_id = ? order by taken_on desc limit 1
-- No index held the rows of one school and term in date order (only tenant + class + date, and student + date), so Postgres read every
-- attendance row of the school through the tenant index, ran the row-level-security check on the 68,040 rows of the term, and sorted
-- them for the newest. At a school of 1,512 learners that took 20.7 s in SQL and was cut off at 8 s in the app (error 57014), so the
-- attendance panel had nothing to show.
--
-- With this index the same query reads one entry and stops: 20,693 ms became 0.56 ms in the QA 18 measurement (tests/load/experiments.sql,
-- block E2). The cost of the per-row permission check itself is FIG-1500, a separate change.

create index if not exists attendance_tenant_id_term_id_taken_on_idx
  on attendance (tenant_id, term_id, taken_on desc);
