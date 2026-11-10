-- FIG-1497: the parent's payments list loads, and the parent's home screen opens in well under a second.
--
-- A parent's home screen asks for the payments of their children's invoices. The query was cut off at 8 s (error 57014) even for one
-- parent with nobody else using the system: in SQL it took 12.1 s at a school of 1,512 learners. Two things were missing:
--
--   payments (invoice_id)    Nothing could find one invoice's payments, so Postgres read every payment of every school (4,522 rows
--                            at the load school) and ran the row-level-security check on each one, about 1.1 to 1.4 ms a row for a
--                            parent, before it could throw the other families' payments away. (The only index on invoice_id is the
--                            partial one for pending payments.)
--   students (profile_id)    The rule "a learner reads their own payments" asks which learner this login belongs to, and with no
--                            index it read every learner of the platform (4.4 s of the 12.1 s).
--
-- With both indexes the plan starts from the parent's children's invoices, reaches their payments through the new index, and runs
-- the permission check on those few rows only: 12,105 ms became 28 ms (tests/load/app-calls.ts parent, and the plan as the parent in
-- SQL). The cost of the permission checks themselves, which still grows with the rows a query has to look at, is FIG-1500.
--
-- students (profile_id) is partial because most learners have no login of their own; "profile_id = auth.uid()" can only match rows
-- where it is set, so the planner still uses it.

create index if not exists payments_invoice_id_idx on payments (invoice_id);
create index if not exists students_profile_id_idx on students (profile_id) where profile_id is not null;
