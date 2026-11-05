-- FIG-1466: a family reads bus updates of its own school only.
--
-- QA 15 found that a school admin could put another school's learner on their own bus trip (trip_riders took any learner id), and that
-- the update this wrote ("<first name> got on the bus ...", student_ids = that learner) was then readable by that learner's family, because
-- the family branch of bus_updates_read matched on student_ids alone, with no test that the update belongs to the family's school.
--
-- The first half is closed already: since 20261103600000 (FIG-1313) the same-school trigger on trip_riders refuses a learner or a trip from
-- another school. This closes the second half, so that one missed check somewhere else can no longer expose a bus message across schools:
-- the family branches now also require the update's school to be the reader's own school.
--
-- supabase/rls-checks/integrity.sql (C5) checks both halves.

alter policy bus_updates_read on bus_updates using (
  is_super()
  or (tenant_id = my_tenant() and is_staff())
  or (tenant_id = my_tenant() and student_ids && array(select g.student_id from guardians g where g.profile_id = auth.uid()))
  or (tenant_id = my_tenant() and student_ids && array(select s.id from students s where s.profile_id = auth.uid()))
);
