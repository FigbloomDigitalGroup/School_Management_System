-- Phase 2 of the HR/timetable-coverage feature (Phase 1 was
-- timetable_slots.subject_id): teachers request leave, the principal
-- approves or rejects it. Phase 3 will cross-reference approved leave
-- against the timetable to flag periods that need cover.

create type leave_status as enum ('pending', 'approved', 'rejected', 'cancelled');

create table leave_requests (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants on delete cascade,
  teacher_id  uuid not null references profiles on delete cascade,
  starts_on   date not null,
  ends_on     date not null,
  reason      text,
  status      leave_status not null default 'pending',
  reviewed_by uuid references profiles on delete set null,
  reviewed_at timestamptz,
  review_note text,
  created_at  timestamptz not null default now(),
  check (ends_on >= starts_on)
);
create index on leave_requests (tenant_id, teacher_id);
create index on leave_requests (tenant_id, status);

alter table leave_requests enable row level security;

-- a teacher sees only their own requests; a school_admin sees every request in the tenant
create policy leave_read on leave_requests for select
  using (is_super() or (tenant_id = my_tenant() and (my_role() = 'school_admin' or teacher_id = auth.uid())));

create policy leave_insert on leave_requests for insert
  with check (tenant_id = my_tenant() and teacher_id = auth.uid() and my_role() = 'teacher');

-- the requester can only cancel their own still-pending request; a school_admin can update any
-- (approve/reject) regardless of its current status
create policy leave_update on leave_requests for update
  using (
    is_super()
    or (tenant_id = my_tenant() and my_role() = 'school_admin')
    or (tenant_id = my_tenant() and teacher_id = auth.uid() and status = 'pending')
  )
  with check (
    is_super()
    or (tenant_id = my_tenant() and my_role() = 'school_admin')
    or (tenant_id = my_tenant() and teacher_id = auth.uid())
  );
