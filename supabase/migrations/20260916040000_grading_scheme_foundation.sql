-- FIG-359 (FIG-356 foundation): country-configurable grading needs two things
-- before any scheme registry can exist — a country to key the registry on, and
-- a per-class level, because a 'combined' tenant (primary + secondary in one
-- school) needs different classes graded under different schemes, not one
-- scheme for the whole tenant.

-- tenants.county is Kenya-specific sub-national (a county name); there is no
-- country dimension anywhere today, so every scale in the app is implicitly
-- hardcoded to Kenya. Defaulting existing/new tenants to 'KE' preserves
-- current behaviour exactly while making the registry key real.
alter table tenants add column country text not null default 'KE';

-- classes.level is deliberately separate from tenants.level: tenants.level
-- ('primary'/'secondary'/'combined') stays a whole-tenant descriptor (used at
-- onboarding to pre-fill new classes), but grading must key off each class's
-- own level so a 'combined' tenant's primary classes get CBC while its
-- secondary classes get KCSE, both in the same tenant.
create type class_level as enum ('primary', 'junior_secondary', 'secondary');
alter table classes add column level class_level not null default 'secondary';
-- Every existing class today belongs to a plain secondary school, so the
-- column default backfills them correctly with no manual data migration.

-- classes.form_level was hardcoded to KCSE's Form 1-4 range regardless of
-- level — a primary school's Grade 1-6 or a junior-secondary's Grade 7-9
-- couldn't be represented at all. The valid range now depends on level, which
-- a plain check() can't express (no cross-column conditional), so this moves
-- to a trigger — same shape as students_class_required_for_k12().
alter table classes drop constraint classes_form_level_check;

create or replace function classes_form_level_range() returns trigger
language plpgsql as $$
begin
  if new.level = 'primary' and new.form_level not between 1 and 6 then
    raise exception 'Primary classes must have form_level between 1 and 6';
  elsif new.level = 'junior_secondary' and new.form_level not between 7 and 9 then
    raise exception 'Junior secondary classes must have form_level between 7 and 9';
  elsif new.level = 'secondary' and new.form_level not between 1 and 4 then
    raise exception 'Secondary classes must have form_level between 1 and 4';
  end if;
  return new;
end $$;

create trigger classes_form_level_range before insert or update on classes
  for each row execute function classes_form_level_range();
