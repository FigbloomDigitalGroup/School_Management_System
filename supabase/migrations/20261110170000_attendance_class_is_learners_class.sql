-- FIG-1407: an attendance row's class must be the learner's class.
--
-- The write policy checks the class on the ROW (is this teacher assigned to it?), and the triggers checked the learner's school and, since
-- FIG-1313, that the row's class, term and learner belong to the same school. Nothing checked that the learner is in that class. So a teacher
-- could insert a row for a Form 1 East learner under their own Form 2 West register, and the stray row then stopped the learner's own teacher
-- from taking that learner's register: the key is learner and day, their upsert hit the stray row, and its update half was checked against
-- the stray row's class and refused (42501).
--
-- A before insert or update trigger on the class and learner columns now refuses a row whose class is not the learner's class (23514, in
-- words, without naming the learner: the caller may not be allowed to see whose they are). It looks the learner up with the owner's rights,
-- so a teacher's limited view of other classes cannot turn into a false refusal. Rows already in the table are not touched, and the history
-- of a learner who later changes class stays as it was: the trigger only fires when a row is written. (A register taken for a class and sent
-- after the learner moved to another class must still go in: the next migration, 20261110180000, remembers each learner's most recent move.)

create or replace function attendance_class_is_learners_class() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  learners_class uuid;
begin
  select class_id into learners_class from students where id = new.student_id;
  if learners_class is distinct from new.class_id then
    raise exception 'That learner is not in this class, so they cannot be marked in its register.' using errcode = '23514';
  end if;
  return new;
end $$;

-- Named with the zz_ prefix so it runs after the learner-and-school trigger (triggers fire in name order): a learner of another school is still
-- refused by that trigger, with its own error, and this rule only judges rows that are in the right school.
create trigger zz_attendance_class_is_learners_class
  before insert or update of student_id, class_id on attendance
  for each row execute function attendance_class_is_learners_class();
