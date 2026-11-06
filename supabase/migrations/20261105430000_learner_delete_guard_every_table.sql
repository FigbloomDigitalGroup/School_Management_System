-- FIG-1467: the learner delete guard covers every table that would lose rows with the learner.
--
-- guard_student_delete (20261023100000) exists so that deleting a learner cannot erase a family's records: it refuses when the learner has
-- attendance, marks, fee records, CBE results, course records, homework hand-ins or documents, and tells the person to archive instead.
-- Only those tables were named in it. QA 15 found at least ten more that cascade from students and went with the learner silently: report
-- cards, health records, items on loan, club memberships, parents' bio-data requests, core competencies, exam attempts, bus trip records, ...
--
-- It now also asks the catalog: after the named checks (kept, for their friendly wording) it looks at every other table with a foreign key
-- to students that cascades on delete, and refuses if any of them holds a row for the learner. A table someone adds next year is covered
-- without remembering to edit this function.
--
-- Left out on purpose:
--   guardians            only the link between a learner and a parent; the family's accounts are not erased by it
--   student_transport    a bus assignment, current state, no history
--   health_consents and health_consent_log
--                        they describe a student_health record, and that record is guarded (a learner who has had a health
--                        record cleared and nothing else can be deleted, with their consent log)
-- (visits sets its learner to null and is not a cascade.)
--
-- The whole-school removal still works: the guard steps aside when the delete is itself a cascade (trigger depth above 1).
--
-- supabase/rls-checks/integrity.sql (C1) checks it with real deletes.

create or replace function guard_student_delete() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  found_on text[] := '{}';
  r record;
  has_rows boolean;
begin
  if pg_trigger_depth() > 1 then return old; end if;

  if exists (select 1 from attendance where student_id = old.id) then found_on := array_append(found_on, 'attendance'); end if;
  if exists (select 1 from marks where student_id = old.id) then found_on := array_append(found_on, 'exam marks'); end if;
  if exists (select 1 from fee_invoices where student_id = old.id) then found_on := array_append(found_on, 'fee records'); end if;
  if exists (select 1 from cbe_results where student_id = old.id)
     or exists (select 1 from cbe_assessment_comments where student_id = old.id) then found_on := array_append(found_on, 'CBE results'); end if;
  if exists (select 1 from course_marks where student_id = old.id)
     or exists (select 1 from course_grades where student_id = old.id)
     or exists (select 1 from enrollments where student_id = old.id) then found_on := array_append(found_on, 'course records'); end if;
  if exists (select 1 from assignment_submissions where student_id = old.id) then found_on := array_append(found_on, 'homework hand-ins'); end if;
  if exists (select 1 from student_documents where student_id = old.id) then found_on := array_append(found_on, 'documents'); end if;

  -- every other table that would lose rows with the learner
  for r in
    select c.conrelid::regclass::text as tbl, a.attname::text as col
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
     where c.contype = 'f' and c.confrelid = 'public.students'::regclass and c.confdeltype = 'c' and cardinality(c.conkey) = 1
       and c.conrelid::regclass::text <> all (array[
             'attendance', 'marks', 'fee_invoices', 'cbe_results', 'cbe_assessment_comments', 'course_marks', 'course_grades', 'enrollments',
             'assignment_submissions', 'student_documents',
             'guardians', 'student_transport', 'health_consents', 'health_consent_log'])
     order by 1
  loop
    execute format('select exists (select 1 from %s where %I = $1)', r.tbl, r.col) into has_rows using old.id;
    if has_rows then
      found_on := array_append(found_on, case r.tbl
        when 'report_cards' then 'report cards'
        when 'student_health' then 'a health record'
        when 'inventory_issues' then 'items on loan'
        when 'activity_members' then 'club memberships'
        when 'activity_event_participants' then 'club and activity records'
        when 'learner_competencies' then 'competency records'
        when 'student_bio_requests' then 'bio-data requests'
        when 'trip_riders' then 'bus trip records'
        when 'sick_bay_visits' then 'sick bay visits'
        when 'exam_attempts' then 'exam attempts'
        when 'fee_charges' then 'fee charges'
        else replace(r.tbl, '_', ' ')
      end);
    end if;
  end loop;

  if cardinality(found_on) > 0 then
    raise exception '% has % on file, so they can''t be deleted. Archive them instead: they leave class lists and billing, and everything is kept.',
      old.full_name, array_to_string(found_on, ', ')
      using errcode = '23001';
  end if;
  return old;
end $$;
