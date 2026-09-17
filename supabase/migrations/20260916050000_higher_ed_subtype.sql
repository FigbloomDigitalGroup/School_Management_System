-- FIG-363 (FIG-357 v1): descriptive higher-ed sub-type only. No functional
-- change to semesters/course_sections/GPA — a short course and a university
-- behave identically today; this just lets the product (and the org-admin
-- console) say which kind of higher_ed tenant this is, rather than "higher_ed"
-- being the only signal available.
create type higher_ed_subtype as enum ('university', 'college', 'short_course', 'tvet');
alter table tenants add column higher_ed_subtype higher_ed_subtype;
-- null for k12 tenants; a higher_ed tenant sets it at onboarding, defaulting
-- to 'university' in the UI rather than being enforced not-null here, since
-- backfilling every existing higher_ed tenant with a guessed subtype would be
-- a worse default than leaving it genuinely unknown.
