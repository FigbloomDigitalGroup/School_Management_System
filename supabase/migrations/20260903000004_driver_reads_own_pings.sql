-- A driver could insert a vehicle_locations row but not see it again — no
-- SELECT policy covered "my own vehicle's pings", only staff and a
-- matching-route guardian/student did. Harmless with a bare insert (no
-- RETURNING), but requesting the row back after insert (`Prefer:
-- return=representation`, or supabase-js's `.insert().select()`) failed RLS
-- entirely, since Postgres evaluates RETURNING against the table's SELECT
-- policies. A driver's own screen reasonably wants to confirm its last ping.
create policy vehicle_locations_read_own on vehicle_locations for select
  using (tenant_id = my_tenant() and is_driver() and vehicle_id in (select my_vehicles()));
