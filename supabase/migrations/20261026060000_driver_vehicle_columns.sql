-- A driver could change anything about their own vehicle.
--
-- vehicles_driver_ping lets a driver UPDATE the vehicle they're assigned to,
-- so the app can mirror each GPS reading onto it, but a policy can't limit
-- columns: a driver could raise speed_limit_kmh (the number the speeding alerts
-- measure against), rename the plate, deactivate the bus, or change its
-- capacity. The only thing the driver apps write is the last position.
--
-- A trigger now refuses a driver any change outside last_lat / last_lng /
-- last_ping_at. It compares whole rows, so a column added later is protected by
-- default. The office (may_administer) and the service role (bus-tick, seeds)
-- are unaffected.

create or replace function guard_vehicle_driver_columns() returns trigger
language plpgsql as $$
begin
  if auth.uid() is null or may_administer(old.tenant_id) then return new; end if;

  if (to_jsonb(new) - 'last_lat' - 'last_lng' - 'last_ping_at')
     is distinct from (to_jsonb(old) - 'last_lat' - 'last_lng' - 'last_ping_at') then
    raise exception 'A driver can only update the vehicle''s position.' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger vehicles_guard_driver_columns before update on vehicles
  for each row execute function guard_vehicle_driver_columns();
