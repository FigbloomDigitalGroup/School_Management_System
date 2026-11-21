-- FIG-1407, part 2: a register taken for the class a learner WAS in is still accepted after they have moved to another class.
--
-- 20261110170000 made an attendance row's class have to be the learner's class. That is right for a stray row (a teacher filing someone else's
-- learner in their register), but a register reaches the server later than it is taken: a phone with no signal on Friday sends Friday's register on
-- Monday, and meanwhile an admin may have moved a learner to the right class. A register goes in as ONE request, so one moved learner would have had
-- the whole class's register refused, and on the phone the only choice left is to discard it.
--
-- So the database now remembers each learner's most recent move: students.previous_class_id (the class they came from) and students.class_since
-- (the school's date they moved). A row is accepted when its class is the learner's class now, or when it is the class they came from and the
-- register is dated on or before the day they moved: the learner was in that class on that day, which is the one thing the server can know.
-- Anything else is refused as before, however old the date: a class the learner was never in, or a class from before their last move. (Only the
-- latest move is remembered; a learner moved twice between a register being taken and sent is the one case left to be refused.)
--
-- Nothing is backfilled: a learner who has never moved has no remembered move and is held to their class exactly as in the first migration.

-- previous_class_id is deliberately a plain uuid, not a foreign key to classes: a second relationship between students and classes makes every
-- screen that loads a learner together with their class (students -> classes(...)) fail with "more than one relationship was found". A class
-- that is later deleted simply never matches again.
alter table students
  add column previous_class_id uuid,
  add column class_since date;

create or replace function students_remember_class_move() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.previous_class_id := old.class_id;
  new.class_since := school_today(new.tenant_id);
  return new;
end $$;

create trigger students_remember_class_move
  before update of class_id on students
  for each row
  when (old.class_id is distinct from new.class_id)
  execute function students_remember_class_move();

create or replace function attendance_class_is_learners_class() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  learners_class uuid;
  came_from uuid;
  moved_on date;
begin
  select class_id, previous_class_id, class_since into learners_class, came_from, moved_on from students where id = new.student_id;
  if learners_class is distinct from new.class_id
     and not (came_from is not null and came_from = new.class_id and moved_on is not null and new.taken_on <= moved_on) then
    raise exception 'That learner is not in this class, so they cannot be marked in its register.' using errcode = '23514';
  end if;
  return new;
end $$;
