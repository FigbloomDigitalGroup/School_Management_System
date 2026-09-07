-- Fleet tracking, phase 1: schema + RLS for vehicles, routes and drivers.
-- Phase 2 (a driver-facing page) will start writing to vehicle_locations and
-- flipping trips active/completed — this phase is the shape everything else
-- builds on, plus admin CRUD for it.
--
-- The driver's phone reports location via a plain browser page (no native
-- app), so it can only report while that page is open and in the foreground —
-- fine for "the bus is 4 stops away", not silent all-day background tracking.

create table vehicles (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants on delete cascade,
  plate_number text not null,
  make_model   text,
  capacity     int check (capacity is null or capacity > 0),
  active       boolean not null default true,
  -- last-known position, kept here too (not just in vehicle_locations) so
  -- "where is this bus right now" is a single indexed row read, not a
  -- max(recorded_at) scan over the whole history table
  last_lat     double precision,
  last_lng     double precision,
  last_ping_at timestamptz,
  created_at   timestamptz not null default now(),
  unique (tenant_id, plate_number)
);

create table routes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants on delete cascade,
  name        text not null,
  description text,
  active      boolean not null default true,
  unique (tenant_id, name)
);

create table route_stops (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants on delete cascade,
  route_id  uuid not null references routes on delete cascade,
  name      text not null,
  lat       double precision not null,
  lng       double precision not null,
  sequence  int not null,
  unique (route_id, sequence)
);
create index on route_stops (route_id);

create table vehicle_assignments (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants on delete cascade,
  vehicle_id uuid not null references vehicles on delete cascade,
  driver_id  uuid not null references profiles on delete cascade,
  route_id   uuid references routes on delete set null,
  active     boolean not null default true
);
-- a vehicle has at most one active driver assignment at a time
create unique index one_active_assignment_per_vehicle on vehicle_assignments (vehicle_id) where active;
create index on vehicle_assignments (driver_id) where active;

create type trip_status as enum ('active', 'completed', 'cancelled');
create type trip_direction as enum ('to_school', 'from_school');

create table trips (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants on delete cascade,
  vehicle_id uuid not null references vehicles on delete cascade,
  route_id   uuid references routes on delete set null,
  driver_id  uuid not null references profiles on delete restrict,
  direction  trip_direction not null default 'to_school',
  status     trip_status not null default 'active',
  started_at timestamptz not null default now(),
  ended_at   timestamptz
);
create index on trips (tenant_id, status);
-- a vehicle has at most one trip in flight at a time
create unique index one_active_trip_per_vehicle on trips (vehicle_id) where status = 'active';

create table vehicle_locations (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants on delete cascade,
  vehicle_id  uuid not null references vehicles on delete cascade,
  trip_id     uuid references trips on delete set null,
  lat         double precision not null,
  lng         double precision not null,
  speed_kmh   real,
  heading     real,
  recorded_at timestamptz not null default now()
);
create index on vehicle_locations (vehicle_id, recorded_at desc);

-- which route/stop a learner rides — lets a parent see only their own
-- child's bus, never the whole fleet
create table student_transport (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants on delete cascade,
  student_id uuid not null references students on delete cascade,
  route_id   uuid not null references routes on delete cascade,
  stop_id    uuid references route_stops on delete set null,
  unique (student_id)
);

-- ---------------------------------------------------------------- RLS
alter table vehicles                enable row level security;
alter table routes                  enable row level security;
alter table route_stops             enable row level security;
alter table vehicle_assignments     enable row level security;
alter table trips                   enable row level security;
alter table vehicle_locations       enable row level security;
alter table student_transport       enable row level security;

create or replace function is_driver() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'driver' from profiles where id = auth.uid()), false)
$$;

-- the vehicle(s) a driver is actively assigned to
create or replace function my_vehicles() returns setof uuid
language sql stable security definer set search_path = public as $$
  select vehicle_id from vehicle_assignments where driver_id = auth.uid() and active
$$;

-- vehicles/routes/stops: any signed-in tenant member may read (a parent or
-- student needs this to see their own bus); only school_admin manages them
create policy vehicles_read on vehicles for select
  using (is_super() or tenant_id = my_tenant());
create policy vehicles_write on vehicles for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));
-- a driver may update only their own assigned vehicle's last-known position
create policy vehicles_driver_ping on vehicles for update
  using (tenant_id = my_tenant() and is_driver() and id in (select my_vehicles()))
  with check (tenant_id = my_tenant() and is_driver() and id in (select my_vehicles()));

create policy routes_read on routes for select
  using (is_super() or tenant_id = my_tenant());
create policy routes_write on routes for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));

create policy route_stops_read on route_stops for select
  using (is_super() or tenant_id = my_tenant());
create policy route_stops_write on route_stops for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));

create policy vehicle_assignments_read on vehicle_assignments for select
  using (is_super() or tenant_id = my_tenant());
create policy vehicle_assignments_write on vehicle_assignments for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));

-- trips: staff see every trip in their school; a driver sees and drives their own
create policy trips_read on trips for select
  using (is_super() or (tenant_id = my_tenant() and (is_staff() or driver_id = auth.uid())));
create policy trips_staff_write on trips for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));
create policy trips_driver_write on trips for all
  using (tenant_id = my_tenant() and is_driver() and driver_id = auth.uid() and vehicle_id in (select my_vehicles()))
  with check (tenant_id = my_tenant() and is_driver() and driver_id = auth.uid() and vehicle_id in (select my_vehicles()));

-- vehicle_locations: staff read every ping in their school; a parent/student
-- may read only pings tied to a trip on their own child's route; a driver
-- may insert (never edit/delete) pings for their own vehicle's active trip
create policy vehicle_locations_read_staff on vehicle_locations for select
  using (is_super() or (tenant_id = my_tenant() and is_staff()));
create policy vehicle_locations_read_family on vehicle_locations for select
  using (
    tenant_id = my_tenant()
    and exists (
      select 1 from trips t
      join student_transport st on st.route_id = t.route_id
      where t.id = vehicle_locations.trip_id
        and st.student_id in (select my_students())
    )
  );
create policy vehicle_locations_driver_insert on vehicle_locations for insert
  with check (
    tenant_id = my_tenant() and is_driver()
    and vehicle_id in (select my_vehicles())
    and exists (select 1 from trips t where t.id = trip_id and t.driver_id = auth.uid() and t.status = 'active')
  );

create policy student_transport_read on student_transport for select
  using (
    is_super()
    or (tenant_id = my_tenant() and is_staff())
    or student_id in (select my_students())
  );
create policy student_transport_write on student_transport for all
  using (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'))
  with check (is_super() or (tenant_id = my_tenant() and my_role() = 'school_admin'));
