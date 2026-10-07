-- Uber-style bus updates for families: "on its way, arriving ~7:42", "1 km
-- away", "at your stop", "heavy traffic, running ~8 min late".
--
-- The bus-tick edge function writes these as the bus moves (the driver's
-- app calls it after each location ping), then pushes each new one to the
-- guardians' phones. Families read them here too -- live, via Realtime --
-- for the in-app feed and pop-ups. Nothing but the service role writes.
--
-- One row per (trip, stop, milestone): siblings at the same stop share a
-- row (student_ids), and the unique dedupe_key means a milestone can only
-- ever be announced once per trip, however many ticks race to it.

create table bus_updates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants on delete cascade,
  trip_id     uuid not null references trips on delete cascade,
  vehicle_id  uuid not null references vehicles on delete cascade,
  stop_id     uuid not null references route_stops on delete cascade,
  student_ids uuid[] not null,
  kind        text not null check (kind in ('trip_started', 'distance', 'arrived', 'delay')),
  -- Starts with "Bus ..." so a push can personalise it ("Amani's bus ...").
  title       text not null,
  body        text not null,
  distance_m  int,
  eta_at      timestamptz,
  dedupe_key  text not null,
  created_at  timestamptz not null default now(),
  unique (trip_id, stop_id, dedupe_key)
);
create index on bus_updates (tenant_id, created_at desc);
create index on bus_updates using gin (student_ids);

alter table bus_updates enable row level security;

-- A family sees updates for their own children's stops; staff see the school's.
create policy bus_updates_read on bus_updates for select
  using (
    is_super()
    or (tenant_id = my_tenant() and is_staff())
    or student_ids && array(select g.student_id from guardians g where g.profile_id = auth.uid())
    or student_ids && array(select s.id from students s where s.profile_id = auth.uid())
  );

alter publication supabase_realtime add table bus_updates;

-- bus-tick's memory between ticks, per stop with riders: the arrival time
-- promised at the start (what "running late" is measured against), and when
-- Google was last asked. Service role only: no policies.
create table bus_stop_progress (
  trip_id           uuid not null references trips on delete cascade,
  stop_id           uuid not null references route_stops on delete cascade,
  baseline_eta      timestamptz,
  last_eta          timestamptz,
  last_checked_at   timestamptz,
  -- how late the last delay update said it was, so the next only goes out
  -- once it's slipped another 5 minutes
  late_notified_min int not null default 0,
  -- lateness the last check saw but hasn't been confirmed by the next one:
  -- one live-traffic reading can swing several minutes and back
  late_pending_min  int,
  primary key (trip_id, stop_id)
);
alter table bus_stop_progress enable row level security;
