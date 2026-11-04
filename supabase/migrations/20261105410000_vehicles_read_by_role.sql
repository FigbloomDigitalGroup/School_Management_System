-- FIG-1304: who reads which bus.
--
-- vehicles carries each bus's plate and last position (last_lat, last_lng, last_ping_at), and its read policy was "anyone in the school":
-- every parent, learner and driver saw every bus of the school. The school's ruling:
--
--   * a parent (and a learner) sees only the bus their own child (themselves) rides: the vehicles that run a trip on a route the
--     learner is on (student_transport);
--   * a driver sees only their own bus (vehicle_assignments);
--   * teachers and the school admin see every bus, as does staff holding the transport area.
--
-- The family branch is a function (my_family_vehicles) so the policy does not have to read trips and student_transport through those
-- tables' own policies. The live positions in vehicle_locations were already limited the same way (vehicle_locations_read_own /
-- _read_family / _read_staff).
--
-- supabase/rls-checks/roles_in_school.sql checks it.

create or replace function my_family_vehicles() returns setof uuid
language sql stable security definer set search_path = public as $$
  select distinct t.vehicle_id
    from trips t
    join student_transport st on st.route_id = t.route_id
   where t.vehicle_id is not null
     and st.student_id in (select my_family_students())
$$;

alter policy vehicles_read on vehicles using (
  is_super()
  or has_perm(tenant_id, 'transport')
  or (tenant_id = my_tenant() and (
        is_staff()
     or id in (select my_vehicles())
     or id in (select my_family_vehicles())
  ))
);
