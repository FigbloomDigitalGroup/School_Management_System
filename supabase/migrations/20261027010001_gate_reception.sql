-- Visitors: recorded at the gate, received at the office.
--
-- The guard records everyone who comes in (name, phone, ID number, plate,
-- why they're here and who they've come to see). The visit reaches the
-- receptionist over Realtime before the visitor reaches the office, and
-- moves through the reception queue:
--
--   expected      recorded at the gate, walking up
--   at_reception  arrived at the office (a walk-in recorded at
--                 reception starts here)
--   with_host     handed over to whoever they came to see
--   left          signed out, at the gate or the office
--
-- Who they've come to see (host_kind):
--   office     the office in general; reception deals with it
--   principal  the principal / administration: escalated to every school
--              admin straight away
--   teacher    one member of staff (host_id), who is told too
--   learner    a parent or guardian come about one learner (student_id)
--
-- The receptionist can escalate any other visit by hand. Escalation only
-- goes one way: once the principal's office has been told, it stays told.
--
-- "Told" means two things, the same two every family bus update gets: the
-- visit row itself, which hosts and admins read live (their consoles pop it
-- up), and a phone push from the visit-notify edge function, which the
-- recording screen calls after each insert or escalation. host_pushed_at and
-- escalation_pushed_at are that function's memory, so a visit is pushed to
-- each audience once however many times it's called; only the service role
-- may set them.

create or replace function is_front_desk() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role in ('guard', 'receptionist') from profiles where id = auth.uid()), false)
$$;

create table visits (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants on delete cascade,
  visitor_name          text not null check (char_length(trim(visitor_name)) between 1 and 120),
  visitor_phone         text check (visitor_phone is null or char_length(visitor_phone) <= 30),
  id_number             text check (id_number is null or char_length(id_number) <= 40),
  vehicle_plate         text check (vehicle_plate is null or char_length(vehicle_plate) <= 20),
  purpose               text not null check (char_length(trim(purpose)) between 1 and 300),
  host_kind             text not null check (host_kind in ('office', 'principal', 'teacher', 'learner')),
  host_id               uuid references profiles on delete set null,
  student_id            uuid references students on delete set null,
  -- names as they were when the visit was recorded: the guard and the
  -- receptionist can't read profiles or students, and the log should still
  -- say who was visited after a teacher leaves the school
  host_name             text,
  student_name          text,
  entry_point           text not null default 'gate' check (entry_point in ('gate', 'reception')),
  status                text not null default 'expected' check (status in ('expected', 'at_reception', 'with_host', 'left')),
  escalated             boolean not null default false,
  escalated_at          timestamptz,
  note                  text check (note is null or char_length(note) <= 500),
  recorded_by           uuid references profiles on delete set null default auth.uid(),
  arrived_at            timestamptz not null default now(),
  reception_at          timestamptz,
  with_host_at          timestamptz,
  left_at               timestamptz,
  host_pushed_at        timestamptz,
  escalation_pushed_at  timestamptz,
  updated_at            timestamptz not null default now()
);
create index on visits (tenant_id, arrived_at desc);
create index on visits (host_id, arrived_at desc);
create index on visits (tenant_id, status) where status <> 'left';

alter table visits enable row level security;

-- The front desk and the office see every visit; a member of staff sees the
-- ones for them.
create policy visits_read on visits for select
  using (
    may_administer(tenant_id)
    or (tenant_id = my_tenant() and is_front_desk())
    or (tenant_id = my_tenant() and host_id = auth.uid())
  );
create policy visits_insert on visits for insert
  with check (may_administer(tenant_id) or (tenant_id = my_tenant() and is_front_desk()));
create policy visits_update on visits for update
  using (may_administer(tenant_id) or (tenant_id = my_tenant() and is_front_desk()))
  with check (may_administer(tenant_id) or (tenant_id = my_tenant() and is_front_desk()));
-- the log is the school's record of who came in: only the office removes a row
create policy visits_delete on visits for delete
  using (may_administer(tenant_id));

-- Names, escalation and the time of each step, filled in server-side.
create or replace function visits_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_host profiles%rowtype;
  v_student students%rowtype;
begin
  if TG_OP = 'UPDATE' and NEW.tenant_id <> OLD.tenant_id then
    raise exception 'A visit cannot be moved to another school' using errcode = '42501';
  end if;

  -- The visit is for staff at this school, about a learner at this school.
  -- Checked when the host or learner is set, not on every update: a teacher
  -- deleted later leaves host_id null (and host_name still saying who).
  if NEW.host_kind = 'teacher' then
    if TG_OP = 'INSERT' or NEW.host_id is distinct from OLD.host_id or OLD.host_kind <> 'teacher' then
      select * into v_host from profiles where id = NEW.host_id;
      if v_host.id is null or v_host.tenant_id <> NEW.tenant_id or v_host.role not in ('teacher', 'school_admin') then
        raise exception 'Pick a member of staff at this school' using errcode = '22023';
      end if;
      NEW.host_name := v_host.full_name;
    end if;
  else
    NEW.host_id := null;
    NEW.host_name := null;
  end if;
  if NEW.host_kind = 'learner' then
    if TG_OP = 'INSERT' or NEW.student_id is distinct from OLD.student_id or OLD.host_kind <> 'learner' then
      select * into v_student from students where id = NEW.student_id;
      if v_student.id is null or v_student.tenant_id <> NEW.tenant_id then
        raise exception 'Pick a learner at this school' using errcode = '22023';
      end if;
      NEW.student_name := v_student.full_name;
    end if;
  else
    NEW.student_id := null;
    NEW.student_name := null;
  end if;

  if TG_OP = 'INSERT' then
    NEW.recorded_by := coalesce(auth.uid(), NEW.recorded_by);
    NEW.arrived_at := now();
    NEW.escalated_at := null;
    -- a walk-in at the office is already at reception
    if NEW.entry_point = 'reception' and NEW.status = 'expected' then NEW.status := 'at_reception'; end if;
  else
    NEW.recorded_by := OLD.recorded_by;
    NEW.arrived_at := OLD.arrived_at;
    NEW.escalated := NEW.escalated or OLD.escalated;
    -- stamped here, never sent: the consoles recognise a fresh escalation by
    -- escalated_at equalling updated_at (visitors.ts visitAlert)
    NEW.escalated_at := OLD.escalated_at;
  end if;

  if NEW.host_kind = 'principal' then NEW.escalated := true; end if;
  if NEW.escalated and NEW.escalated_at is null then NEW.escalated_at := now(); end if;

  if NEW.status in ('at_reception', 'with_host') and NEW.reception_at is null then NEW.reception_at := now(); end if;
  if NEW.status = 'with_host' and NEW.with_host_at is null then NEW.with_host_at := now(); end if;
  if NEW.status = 'left' and NEW.left_at is null then NEW.left_at := now(); end if;
  if NEW.status <> 'left' then NEW.left_at := null; end if;

  -- push bookkeeping belongs to visit-notify (service role, no auth.uid())
  if auth.uid() is not null then
    if TG_OP = 'INSERT' then
      NEW.host_pushed_at := null;
      NEW.escalation_pushed_at := null;
    else
      -- a visit passed on to someone else is pushed to its new host
      NEW.host_pushed_at := case when NEW.host_id is distinct from OLD.host_id then null else OLD.host_pushed_at end;
      NEW.escalation_pushed_at := OLD.escalation_pushed_at;
    end if;
  end if;

  NEW.updated_at := now();
  return NEW;
end;
$$;

create trigger visits_stamp before insert or update on visits
  for each row execute function visits_stamp();

alter publication supabase_realtime add table visits;

-- ---------------------------------------------------------------- pickers

-- Who a visitor can ask for: the school's teachers and admins, by name and
-- title. The guard and the receptionist can't read profiles, and don't need
-- more than this.
create or replace function visit_hosts(p_tenant_id uuid)
returns table(id uuid, full_name text, role app_role, staff_title text)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.role, p.staff_title
  from profiles p
  where p.tenant_id = p_tenant_id
    and p.role in ('teacher', 'school_admin')
    and (may_administer(p_tenant_id) or (p_tenant_id = my_tenant() and is_front_desk()))
  order by p.full_name
$$;

grant execute on function visit_hosts(uuid) to authenticated;

-- A learner a parent says they've come about, found by name or admission
-- number: a handful of matches, never the roll.
create or replace function visit_find_learners(p_tenant_id uuid, p_query text)
returns table(id uuid, full_name text, admission_no text, class_name text)
language sql stable security definer set search_path = public as $$
  select s.id, s.full_name, s.admission_no, c.name
  from students s
  left join classes c on c.id = s.class_id
  where s.tenant_id = p_tenant_id
    and s.active
    and char_length(trim(coalesce(p_query, ''))) >= 2
    and (s.full_name ilike '%' || trim(p_query) || '%' or s.admission_no ilike trim(p_query) || '%')
    and (may_administer(p_tenant_id) or (p_tenant_id = my_tenant() and is_front_desk()))
  order by s.full_name
  limit 8
$$;

grant execute on function visit_find_learners(uuid, text) to authenticated;
