-- Higher-ed foundation (FIG-326): a tenant is strictly one institution type,
-- set at onboarding. Every table added for higher-ed concepts (courses,
-- course_sections, enrollments, ...) in later migrations is additive and
-- never touches a K-12 table — the one unavoidable exception is
-- students.class_id, which must become nullable so a higher-ed student can
-- exist at all. The K-12 invariant ("every K-12 student has exactly one
-- class") is preserved exactly via trigger, since Postgres check constraints
-- cannot contain subqueries.

create type institution_type as enum ('k12', 'higher_ed');

alter table tenants add column institution_type institution_type not null default 'k12';

-- Per-tenant display-label overrides ("Teacher" -> "Lecturer", etc). Empty by
-- default; packages/shared/src/roleLabels.ts falls back to institution_type
-- defaults when a key is absent.
alter table tenants add column role_labels jsonb not null default '{}'::jsonb;

alter table students alter column class_id drop not null;

create or replace function students_class_required_for_k12() returns trigger
language plpgsql as $$
begin
  if new.class_id is null and (select institution_type from tenants where id = new.tenant_id) = 'k12' then
    raise exception 'K-12 students must have a class_id';
  end if;
  return new;
end $$;

create trigger students_class_required_for_k12
  before insert or update on students
  for each row execute function students_class_required_for_k12();
