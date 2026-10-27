-- Two transport additions.
--
-- A. Drivers mark children on and off the bus. Every trip gets a rider list
--    (trip_riders), seeded from student_transport when the trip starts. The
--    driver marks each child "on bus", "not here" or "got off"; each change
--    writes a bus_updates row for that child's family ("Amani got on the bus
--    at 15:31"), which reaches their feed over Realtime and their phone via
--    the rider-update edge function. Ending a trip with anyone still marked
--    on board raises a vehicle_alerts row so the office sees it.
--
-- B. Where a learner lives (students.home_*), so the school can plan routes
--    and stops. An admin sets it from People; a guardian sets their own
--    child's through set_child_home().

-- ================================================================ A. riders

create table trip_riders (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants on delete cascade,
  trip_id       uuid not null references trips on delete cascade,
  student_id    uuid not null references students on delete cascade,
  -- their stop on the route; null when the office hasn't picked one yet
  -- (still a rider), or the route's stops were re-saved mid-trip
  stop_id       uuid references route_stops on delete set null,
  status        text not null default 'expected' check (status in ('expected', 'boarded', 'alighted', 'absent')),
  boarded_at    timestamptz,
  boarded_lat   double precision,
  boarded_lng   double precision,
  alighted_at   timestamptz,
  alighted_lat  double precision,
  alighted_lng  double precision,
  marked_by     uuid references profiles on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (trip_id, student_id)
);
create index on trip_riders (student_id, created_at desc);
create index on trip_riders (tenant_id, created_at desc);

alter table trip_riders enable row level security;

-- The trip's own driver may mark riders while the trip runs, and for two
-- hours after it ends: marks made in a dead zone sit in the phone's offline
-- queue, and a queued write the database refuses blocks everything queued
-- behind it.
create or replace function driver_may_mark(p_trip_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from trips t
    where t.id = p_trip_id and t.driver_id = auth.uid() and t.tenant_id = my_tenant()
      and (t.status = 'active' or t.ended_at > now() - interval '2 hours')
  )
$$;

-- A learner who rides this trip's route: a driver can't add an arbitrary
-- child to their list (and so message that child's family).
create or replace function rides_trip_route(p_trip_id uuid, p_student_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from trips t join student_transport st on st.route_id = t.route_id
    where t.id = p_trip_id and st.student_id = p_student_id
  )
$$;

-- Staff see the school's riders; a family sees their own children's; a
-- driver sees their own trips'.
create policy trip_riders_read on trip_riders for select
  using (
    is_super()
    or (tenant_id = my_tenant() and is_staff())
    or may_administer(tenant_id)
    or student_id in (select my_students())
    or exists (select 1 from trips t where t.id = trip_riders.trip_id and t.driver_id = auth.uid())
  );
create policy trip_riders_admin_write on trip_riders for all
  using (may_administer(tenant_id)) with check (may_administer(tenant_id));
-- insert as well as update: the offline queue replays marks as upserts
create policy trip_riders_driver_insert on trip_riders for insert
  with check (tenant_id = my_tenant() and is_driver() and driver_may_mark(trip_id) and rides_trip_route(trip_id, student_id));
create policy trip_riders_driver_update on trip_riders for update
  using (tenant_id = my_tenant() and is_driver() and driver_may_mark(trip_id))
  with check (tenant_id = my_tenant() and is_driver() and driver_may_mark(trip_id));

-- Who and when, filled in server-side; a rider row can't be moved to another trip or child.
create or replace function trip_riders_stamp() returns trigger
language plpgsql set search_path = public as $$
begin
  if TG_OP = 'UPDATE' and (NEW.trip_id <> OLD.trip_id or NEW.student_id <> OLD.student_id or NEW.tenant_id <> OLD.tenant_id) then
    raise exception 'A rider row cannot be moved to another trip or learner' using errcode = '42501';
  end if;
  NEW.updated_at := now();
  if TG_OP = 'INSERT' or NEW.status is distinct from OLD.status then
    NEW.marked_by := coalesce(auth.uid(), NEW.marked_by);
  end if;
  if NEW.status = 'boarded' and NEW.boarded_at is null then NEW.boarded_at := now(); end if;
  if NEW.status = 'alighted' and NEW.alighted_at is null then NEW.alighted_at := now(); end if;
  return NEW;
end;
$$;

create trigger trip_riders_stamp before insert or update on trip_riders
  for each row execute function trip_riders_stamp();

-- Everyone on the route is expected the moment a trip starts.
create or replace function trip_seed_riders() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if NEW.route_id is null then return NEW; end if;
  insert into trip_riders (tenant_id, trip_id, student_id, stop_id)
  select NEW.tenant_id, NEW.id, st.student_id, st.stop_id
  from student_transport st
  join students s on s.id = st.student_id
  where st.route_id = NEW.route_id and s.active and s.tenant_id = NEW.tenant_id
  on conflict (trip_id, student_id) do nothing;
  return NEW;
end;
$$;

create trigger trips_seed_riders after insert on trips
  for each row execute function trip_seed_riders();

-- Trips already running when this lands get their lists too.
insert into trip_riders (tenant_id, trip_id, student_id, stop_id)
select t.tenant_id, t.id, st.student_id, st.stop_id
from trips t
join student_transport st on st.route_id = t.route_id
join students s on s.id = st.student_id and s.active
where t.status = 'active'
on conflict (trip_id, student_id) do nothing;

-- Names for the driver's list: a driver can't read students directly, and
-- doesn't need more than a name.
create or replace function trip_rider_list(p_trip_id uuid)
returns table(student_id uuid, full_name text, stop_id uuid, status text, boarded_at timestamptz, alighted_at timestamptz)
language sql stable security definer set search_path = public as $$
  select r.student_id, s.full_name, r.stop_id, r.status, r.boarded_at, r.alighted_at
  from trip_riders r
  join trips t on t.id = r.trip_id
  join students s on s.id = r.student_id
  where r.trip_id = p_trip_id
    and (t.driver_id = auth.uid() or (t.tenant_id = my_tenant() and is_staff()) or may_administer(t.tenant_id))
  order by s.full_name
$$;

grant execute on function trip_rider_list(uuid) to authenticated;

-- ---------------------------------------------------------------- family updates

-- Rider updates name one child, and may have no stop (a rider without one).
alter table bus_updates alter column stop_id drop not null;
alter table bus_updates drop constraint bus_updates_kind_check;
alter table bus_updates add constraint bus_updates_kind_check
  check (kind in ('trip_started', 'distance', 'arrived', 'delay', 'boarded', 'alighted', 'absent'));
-- When rider-update pushed it to the family's phones. bus-tick pushes its
-- own updates as it writes them, so this is only set for rider updates.
alter table bus_updates add column pushed_at timestamptz;

-- "Amani got on the bus at 15:31" / "Amani got off at Imara Daima at 15:52".
-- A trigger, not the app: a mark made offline still tells the family once
-- it syncs, with the time it was actually made.
create or replace function trip_rider_announce() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_trip  trips%rowtype;
  v_first text;
  v_stop  text;
  v_plate text;
  v_clock text;
  v_place text;
  v_title text;
  v_body  text;
  v_key   text;
begin
  if NEW.status = 'expected' then return NEW; end if;
  if TG_OP = 'UPDATE' and OLD.status is not distinct from NEW.status then return NEW; end if;

  select * into v_trip from trips where id = NEW.trip_id;
  select coalesce(nullif(split_part(trim(full_name), ' ', 1), ''), 'Your child') into v_first from students where id = NEW.student_id;
  select name into v_stop from route_stops where id = NEW.stop_id;
  select coalesce(plate_number, 'the bus') into v_plate from vehicles where id = v_trip.vehicle_id;

  v_clock := to_char(
    (case NEW.status when 'boarded' then coalesce(NEW.boarded_at, now())
                     when 'alighted' then coalesce(NEW.alighted_at, now())
                     else now() end) at time zone 'Africa/Nairobi',
    'HH24:MI');

  -- One end of every trip is the school; the other is the child's own stop.
  if (NEW.status = 'boarded' and v_trip.direction = 'from_school') or (NEW.status = 'alighted' and v_trip.direction = 'to_school') then
    v_place := 'school';
  else
    v_place := coalesce(v_stop, 'their stop');
  end if;

  if NEW.status = 'boarded' then
    v_title := format('%s got on the bus at %s', v_first, v_clock);
    v_body := case when v_place = 'school' then format('Left school on %s.', v_plate)
                   else format('Picked up at %s on %s.', v_place, v_plate) end;
  elsif NEW.status = 'alighted' then
    v_title := format('%s got off at %s at %s', v_first, v_place, v_clock);
    v_body := case when v_place = 'school' then format('Arrived at school on %s.', v_plate)
                   else format('Dropped at %s by %s.', v_place, v_plate) end;
  else
    v_title := case when v_trip.direction = 'to_school' then format('%s was not at the pickup', v_first)
                    else format('%s did not get on the bus', v_first) end;
    v_body := format('The driver marked %s as not here at %s. Call the school if that is unexpected.', v_first, v_clock);
  end if;

  -- Each kind once per child per trip: tapping back and forth doesn't spam the family.
  v_key := NEW.status || ':' || NEW.student_id;
  if not exists (select 1 from bus_updates where trip_id = NEW.trip_id and dedupe_key = v_key) then
    insert into bus_updates (tenant_id, trip_id, vehicle_id, stop_id, student_ids, kind, title, body, dedupe_key)
    values (NEW.tenant_id, NEW.trip_id, v_trip.vehicle_id, NEW.stop_id, array[NEW.student_id], NEW.status, v_title, v_body, v_key)
    on conflict do nothing;
  end if;
  return NEW;
end;
$$;

create trigger trip_riders_announce after insert or update of status on trip_riders
  for each row execute function trip_rider_announce();

-- ---------------------------------------------------------------- still on the bus

alter table vehicle_alerts drop constraint vehicle_alerts_kind_check;
alter table vehicle_alerts add constraint vehicle_alerts_kind_check check (kind in ('speed', 'geofence', 'rider'));

-- The driver's app asks them to confirm everyone got off before ending a
-- trip, and lets them say "still on the bus, tell the school" instead. Either
-- way, a trip that ends with children marked on board alerts the office.
create or replace function trip_end_rider_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_count int;
  v_names text;
  v_lat   double precision;
  v_lng   double precision;
begin
  if OLD.status <> 'active' or NEW.status = 'active' then return NEW; end if;
  select count(*), string_agg(s.full_name, ', ' order by s.full_name) into v_count, v_names
  from trip_riders r join students s on s.id = r.student_id
  where r.trip_id = NEW.id and r.status = 'boarded';
  if v_count = 0 then return NEW; end if;

  select coalesce(v.last_lat, 0), coalesce(v.last_lng, 0) into v_lat, v_lng from vehicles v where v.id = NEW.vehicle_id;
  insert into vehicle_alerts (tenant_id, vehicle_id, trip_id, kind, detail, lat, lng)
  values (
    NEW.tenant_id, NEW.vehicle_id, NEW.id, 'rider',
    format('%s still marked on the bus after the trip ended: %s',
      case when v_count = 1 then '1 child' else v_count || ' children' end, v_names),
    v_lat, v_lng
  );
  return NEW;
end;
$$;

create trigger trips_end_rider_check after update of status on trips
  for each row execute function trip_end_rider_check();

-- ================================================================ B. homes

alter table students
  add column home_lat        double precision,
  add column home_lng        double precision,
  -- "opposite Naivas, Imara Daima": how a driver or the office finds the gate
  add column home_landmark   text,
  add column home_updated_at timestamptz,
  add column home_updated_by uuid references profiles on delete set null,
  add constraint students_home_pair check ((home_lat is null) = (home_lng is null)),
  add constraint students_home_range check (home_lat is null or (home_lat between -90 and 90 and home_lng between -180 and 180)),
  add constraint students_home_landmark_len check (home_landmark is null or char_length(home_landmark) <= 200);

create or replace function students_stamp_home() returns trigger
language plpgsql set search_path = public as $$
begin
  if (TG_OP = 'INSERT' and (NEW.home_lat is not null or NEW.home_landmark is not null))
     or (TG_OP = 'UPDATE' and (NEW.home_lat, NEW.home_lng, NEW.home_landmark) is distinct from (OLD.home_lat, OLD.home_lng, OLD.home_landmark)) then
    NEW.home_updated_at := now();
    NEW.home_updated_by := auth.uid();
  end if;
  return NEW;
end;
$$;

create trigger students_stamp_home before insert or update on students
  for each row execute function students_stamp_home();

-- A guardian can't write students (student_write is admin-only), so their
-- one write is this: their own child's home, nothing else on the row.
-- Admins may call it too. Both coordinates or neither; 0,0 is a phone that
-- had no fix, not a home.
create or replace function set_child_home(p_student_id uuid, p_lat double precision, p_lng double precision, p_landmark text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from students where id = p_student_id;
  if v_tenant is null
     or not (exists (select 1 from guardians g where g.student_id = p_student_id and g.profile_id = auth.uid()) or may_administer(v_tenant)) then
    raise exception 'You can only set the home of your own child' using errcode = '42501';
  end if;
  if (p_lat is null) <> (p_lng is null) then
    raise exception 'Give both latitude and longitude, or neither' using errcode = '22023';
  end if;
  if p_lat is not null and (p_lat not between -90 and 90 or p_lng not between -180 and 180 or (abs(p_lat) < 0.0001 and abs(p_lng) < 0.0001)) then
    raise exception 'That location is not a real place on the map' using errcode = '22023';
  end if;
  update students
  set home_lat = p_lat, home_lng = p_lng, home_landmark = nullif(left(trim(coalesce(p_landmark, '')), 200), '')
  where id = p_student_id;
end;
$$;

grant execute on function set_child_home(uuid, double precision, double precision, text) to authenticated;
