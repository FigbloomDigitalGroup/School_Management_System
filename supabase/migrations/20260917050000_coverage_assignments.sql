-- Records what the principal actually decided for a coverage gap (Phase 3's
-- "needs cover" list was read-only) -- a substitute teacher, or that the
-- period just runs free. Keyed by the exact period occurrence (date + class
-- + start_time, not just date + class + subject) since a class can have the
-- same subject twice in one day at different times.
create table coverage_assignments (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants on delete cascade,
  date                date not null,
  class_id            uuid not null references classes on delete cascade,
  subject_id          uuid not null references subjects on delete cascade,
  start_time          text not null,
  absent_teacher_id   uuid not null references profiles on delete cascade,
  -- null = deliberately left as a free period, not merely unassigned
  covering_teacher_id uuid references profiles on delete set null,
  assigned_by         uuid not null references profiles on delete restrict,
  assigned_at         timestamptz not null default now(),
  unique (date, class_id, start_time)
);
create index on coverage_assignments (tenant_id, date);

alter table coverage_assignments enable row level security;

-- readable by anyone in the school (same shape as timetable_slots/teaching_assignments),
-- written only by a school_admin
create policy coverage_read on coverage_assignments for select
  using (is_super() or tenant_id = my_tenant());
create policy coverage_write on coverage_assignments for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));
