-- Fleet tracking, phase 5: hardening, starting with alerts. Every ping a
-- driver's page sends is checked, server-side, for two things: is this
-- vehicle going faster than it should, and is it far from any stop on the
-- route it's meant to be running. Evaluating this in a trigger (rather than
-- in the client) means it can't be skipped by a stale app build and applies
-- equally whether the ping came from a driver's phone or a future import.

alter table vehicles add column speed_limit_kmh int not null default 80 check (speed_limit_kmh > 0);

create table vehicle_alerts (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants on delete cascade,
  vehicle_id      uuid not null references vehicles on delete cascade,
  trip_id         uuid references trips on delete set null,
  kind            text not null check (kind in ('speed', 'geofence')),
  detail          text not null,
  lat             double precision not null,
  lng             double precision not null,
  acknowledged_at timestamptz,
  acknowledged_by uuid references profiles on delete set null,
  created_at      timestamptz not null default now()
);
create index on vehicle_alerts (tenant_id, created_at desc);
create index on vehicle_alerts (vehicle_id, kind, acknowledged_at);

alter table vehicle_alerts enable row level security;

create policy vehicle_alerts_read on vehicle_alerts for select
  using (is_super() or (tenant_id = my_tenant() and is_staff()));
-- "write" here only ever means acknowledging — nothing lets a client insert
-- or delete an alert; that's the trigger's job alone.
create policy vehicle_alerts_ack on vehicle_alerts for update
  using (is_super() or (tenant_id = my_tenant() and is_staff()))
  with check (is_super() or (tenant_id = my_tenant() and is_staff()));

-- security definer + owned by the migration role (postgres, a superuser)
-- so the insert below is never blocked by RLS regardless of which role's
-- ping triggered it — same pattern as is_driver()/my_vehicles() above.
create or replace function evaluate_vehicle_alert() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_speed_limit int;
  v_min_dist_m  double precision;
  v_recent      timestamptz;
begin
  if NEW.speed_kmh is not null then
    select speed_limit_kmh into v_speed_limit from vehicles where id = NEW.vehicle_id;
    if NEW.speed_kmh > v_speed_limit then
      select max(created_at) into v_recent
        from vehicle_alerts
        where vehicle_id = NEW.vehicle_id and kind = 'speed' and acknowledged_at is null;
      if v_recent is null or v_recent < now() - interval '5 minutes' then
        insert into vehicle_alerts (tenant_id, vehicle_id, trip_id, kind, detail, lat, lng)
        values (
          NEW.tenant_id, NEW.vehicle_id, NEW.trip_id, 'speed',
          format('Doing %s km/h in an %s km/h zone', round(NEW.speed_kmh::numeric), v_speed_limit),
          NEW.lat, NEW.lng
        );
      end if;
    end if;
  end if;

  -- Routes are only stored as discrete stops, not a full path, so "off
  -- route" is approximated as "far from every stop on the assigned route" —
  -- coarse, but catches a wrong-turn or a diverted trip without needing a
  -- polyline the admin UI doesn't collect.
  if NEW.trip_id is not null then
    select min(
      2 * 6371000 * asin(sqrt(
        power(sin(radians(rs.lat - NEW.lat) / 2), 2)
        + cos(radians(NEW.lat)) * cos(radians(rs.lat)) * power(sin(radians(rs.lng - NEW.lng) / 2), 2)
      ))
    ) into v_min_dist_m
    from trips t
    join route_stops rs on rs.route_id = t.route_id
    where t.id = NEW.trip_id;

    if v_min_dist_m is not null and v_min_dist_m > 1500 then
      select max(created_at) into v_recent
        from vehicle_alerts
        where vehicle_id = NEW.vehicle_id and kind = 'geofence' and acknowledged_at is null;
      if v_recent is null or v_recent < now() - interval '5 minutes' then
        insert into vehicle_alerts (tenant_id, vehicle_id, trip_id, kind, detail, lat, lng)
        values (
          NEW.tenant_id, NEW.vehicle_id, NEW.trip_id, 'geofence',
          format('%s m from the nearest stop on its route', round(v_min_dist_m::numeric)),
          NEW.lat, NEW.lng
        );
      end if;
    end if;
  end if;

  return NEW;
end;
$$;

create trigger vehicle_locations_alert_check
  after insert on vehicle_locations
  for each row execute function evaluate_vehicle_alert();

alter publication supabase_realtime add table vehicle_alerts;
