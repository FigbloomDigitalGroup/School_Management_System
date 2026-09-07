-- Real per-class timetable, replacing DEMO_TIMETABLE's static reference data.
-- label is free text rather than a subjects FK on purpose — a real school
-- week includes periods (Games, Library, Class meeting) that are not
-- academic subjects at all.

create table timetable_slots (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants on delete cascade,
  class_id   uuid not null references classes on delete cascade,
  day        text not null check (day in ('Mon','Tue','Wed','Thu','Fri')),
  start_time text not null check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  label      text not null,
  room       text,
  unique (class_id, day, start_time)
);
create index on timetable_slots (tenant_id, class_id);

alter table timetable_slots enable row level security;

-- readable by anyone in the school (same as terms/classes/subjects), written by school_admin only
create policy timetable_read on timetable_slots for select
  using (is_super() or tenant_id = my_tenant());
create policy timetable_write on timetable_slots for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));
