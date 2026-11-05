-- FIG-1434: a substitute cannot be asked to cover two classes at the same time, or to cover for themself.
--
-- The coverage_assignments table's only rule was one cover per class, date and start time. The same person assigned to cover Form 1 East
-- and Form 3 East on the same date at 08:00 was accepted, and so was a teacher recorded as covering their own lesson (absent teacher and
-- covering teacher the same person).
--
-- A trigger refuses both, in words, when a cover is added or its substitute, date or time changes. Leaving a period as a free period
-- (no substitute) is not looked at. The same substitute being saved again for the same class and time is not "another class", so
-- changing a cover's other details still works.
--
-- Whether the substitute is TEACHING another class at that time (the timetable) is not checked here: the substitute list on the Dashboard
-- leaves such teachers out and the app checks again when the cover is saved (apps/web/src/lib/coverage.ts), so a principal who knows better
-- is not locked out by a timetable that has not been kept up to date.

create or replace function coverage_one_place_at_a_time() returns trigger
language plpgsql security definer set search_path = public as $$
declare other_class text;
begin
  if new.covering_teacher_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.covering_teacher_id is not distinct from old.covering_teacher_id
     and new.date = old.date and new.start_time = old.start_time and new.absent_teacher_id = old.absent_teacher_id then
    return new;
  end if;

  if new.covering_teacher_id = new.absent_teacher_id then
    raise exception 'A teacher cannot cover their own lesson.' using errcode = '23514';
  end if;

  select c.name into other_class
    from coverage_assignments a join classes c on c.id = a.class_id
   where a.tenant_id = new.tenant_id and a.date = new.date and a.start_time = new.start_time
     and a.covering_teacher_id = new.covering_teacher_id and a.class_id <> new.class_id
   limit 1;
  if found then
    raise exception 'That teacher is already covering % at % on %. One person cannot cover two classes at the same time.',
      other_class, new.start_time, to_char(new.date, 'FMDD Mon YYYY') using errcode = '23P01';
  end if;
  return new;
end $$;

drop trigger if exists coverage_one_place_at_a_time on coverage_assignments;
create trigger coverage_one_place_at_a_time before insert or update on coverage_assignments
  for each row execute function coverage_one_place_at_a_time();
