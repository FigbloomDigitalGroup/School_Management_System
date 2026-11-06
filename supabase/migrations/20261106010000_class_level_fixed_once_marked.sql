-- FIG-1435: a class that already has marks cannot be moved to another level.
--
-- A grade is not stored. The marks table keeps only the number, and the label is worked out every time it is shown from the country and
-- the class's level (gradingSchemeFor and gradeFor: the parent Results and Home, the student Results, Reports, Performance, report cards).
-- So changing a class's level re-labelled every mark the class has: for the same mark the 8-4-4 (KCSE) scale and the junior secondary
-- (CBE rubric) scale give a different label for 101 of 101 marks (30 is D- on one and AE2 on the other). The table only checked that the
-- year is valid for the level, so a school admin could do it with one request, and past results changed under families without a word.
--
-- The screens do not offer a level change, so nothing a teacher or admin does today runs into this. It refuses a level change while any
-- learner of the class has a mark, in words, and leaves everything else alone: a class with no marks can still be corrected (a class made
-- at the wrong level on the first day), and the year within a level (form_level) is not touched. Moving learners to a class at the right
-- level is the way to do it once there are marks.
--
-- SECURITY DEFINER so the answer does not depend on which marks the caller's row-level security lets them see.

create or replace function classes_level_fixed_once_marked() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from marks m join students s on s.id = m.student_id where s.class_id = new.id) then
    raise exception '% already has marks, so its level cannot be changed: every grade it shows is worked out from the level, so every one would change. Make a class at the new level and move the learners to it.', new.name
      using errcode = '23514';
  end if;
  return new;
end $$;

create trigger classes_level_fixed_once_marked
  before update of level on classes
  for each row
  when (old.level is distinct from new.level)
  execute function classes_level_fixed_once_marked();
