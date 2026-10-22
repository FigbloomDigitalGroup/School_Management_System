-- CBE, part 2 of 2 (levels). form_level is a bare int whose meaning depends on
-- the class's level: Grade 1 and Form 1 are both 1, PP1 is 1 too. Anything
-- that stored a form_level without its level -- fee items, subject ranges,
-- form-wide announcements -- couldn't tell them apart in a school that runs
-- more than one level, and fee_items still carried the original 8-4-4-only
-- `between 1 and 4` check, so a Grade 5 fee item was rejected outright.
--
-- The valid (level, year) pairs now live in one function every table uses.

create or replace function level_year_valid(p_level class_level, p_year int) returns boolean
language sql immutable as $$
  select case p_level
    when 'pre_primary'      then p_year between 1 and 2    -- PP1, PP2
    when 'primary'          then p_year between 1 and 6    -- Grade 1-6
    when 'junior_secondary' then p_year between 7 and 9    -- Grade 7-9
    when 'senior_school'    then p_year between 10 and 12  -- Grade 10-12
    when 'secondary'        then p_year between 1 and 4    -- 8-4-4 Form 1-4
  end
$$;

-- Senior school learners pick one of three pathways; the class carries it.
create type cbe_pathway as enum ('stem', 'social_sciences', 'arts_sports');
alter table classes add column pathway cbe_pathway;

create or replace function classes_form_level_range() returns trigger
language plpgsql as $$
begin
  if not level_year_valid(new.level, new.form_level) then
    raise exception 'form_level % is not valid for a % class', new.form_level, new.level;
  end if;
  if new.pathway is not null and new.level <> 'senior_school' then
    raise exception 'Only senior school classes have a pathway';
  end if;
  return new;
end $$;

-- fee_items: a form-wide item now names its level. Null level keeps the old
-- meaning (every class with that form_level) so existing rows are unchanged.
alter table fee_items add column level class_level;
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'fee_items'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ~ 'form_level >= 1\) AND \(form_level <= 4'
  loop
    execute format('alter table fee_items drop constraint %I', c.conname);
  end loop;
end $$;
alter table fee_items add constraint fee_items_level_year_valid
  check (form_level is null or form_level between 1 and 12);
alter table fee_items add constraint fee_items_level_matches_year
  check (level is null or form_level is null or level_year_valid(level, form_level));

-- subjects: min/max_form_level are read within subjects.level. Null level
-- keeps the old meaning (compare against any class's form_level).
alter table subjects add column level class_level;
alter table subjects add constraint subjects_level_range_valid check (
  level is null
  or ((min_form_level is null or level_year_valid(level, min_form_level))
      and (max_form_level is null or level_year_valid(level, max_form_level)))
);
