-- FIG-1376: "entered by" on a mark is always the person who saved it, not whatever the app sends.
--
-- marks.entered_by is a column the app fills with the signed-in profile id (Gradebook.tsx, teacherData.ts). Nothing on the server tied it to
-- the person writing: the row policy checks the school and whether the caller may teach the subject, and no trigger set or checked the
-- column. A teacher could save a mark for their own class with the school admin's id in entered_by, and the stored row said the admin typed
-- it; a later edit (the upsert replaces the row) was attributed to whatever id was sent. It is the record you look at after a dispute about
-- a changed mark. Same gap, same column, on course_marks (higher education) and cbe_results (the CBE rubric).
--
-- A before insert or update trigger now sets entered_by to the caller (auth.uid()) on all three. Nothing the apps send can differ, so
-- nothing changes for a teacher or admin: the gradebooks already send their own id, and send_exam_scores_to_gradebook already writes
-- auth.uid(). When there is no signed-in caller (the service role, the seed scripts, the database console) the value is left as given,
-- so those keep working. "Entered by" stays "who saved this row last", as it was.

create or replace function entered_by_is_the_caller() returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null then
    new.entered_by := auth.uid();
  end if;
  return new;
end $$;

create trigger entered_by_is_the_caller before insert or update on marks
  for each row execute function entered_by_is_the_caller();
create trigger entered_by_is_the_caller before insert or update on course_marks
  for each row execute function entered_by_is_the_caller();
create trigger entered_by_is_the_caller before insert or update on cbe_results
  for each row execute function entered_by_is_the_caller();
