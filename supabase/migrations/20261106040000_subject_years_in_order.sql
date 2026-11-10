-- FIG-1436: a subject cannot start in a later form than it ends in.
--
-- subjects_level_range_valid requires each of min_form_level and max_form_level to be a valid year for the subject's level (Form 1 to 4
-- for the 8-4-4 level; a first form of 5 is refused). It never compared the two: a subject from Form 4 to Form 1 was saved, a range no
-- form falls in, so the subject was offered to no class. This adds the missing comparison: when both ends are set, the first must not be
-- after the last. A blank end means "no limit on that side", so a subject with only one end set is untouched.
--
-- Added NOT VALID, then validated: the rule applies to every new subject and every edit at once, and if a database already holds a subject
-- that runs backwards the migration still completes (it says so in a warning, naming how many) instead of stopping a deploy. Those rows
-- stay as they are until someone edits them (an edit is checked) or fixes them and runs
--   alter table subjects validate constraint subjects_years_in_order;

alter table subjects
  add constraint subjects_years_in_order
  check (min_form_level is null or max_form_level is null or min_form_level <= max_form_level) not valid;

do $$
declare
  backwards bigint;
begin
  alter table subjects validate constraint subjects_years_in_order;
exception when check_violation then
  select count(*) into backwards from subjects where min_form_level > max_form_level;
  raise warning '% subject(s) already start in a later form than they end in; subjects_years_in_order is enforced for new and edited subjects but not yet validated for these rows', backwards;
end $$;
