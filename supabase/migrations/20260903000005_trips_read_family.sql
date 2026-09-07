-- trips_read only granted staff and the trip's own driver — a parent/student
-- had no way to see a trip at all, which silently broke
-- vehicle_locations_read_family too (its EXISTS subquery joins through
-- trips, and RLS applies to that subquery under the querying user's own
-- policies, not the definer's).
create policy trips_read_family on trips for select
  using (
    tenant_id = my_tenant()
    and exists (
      select 1 from student_transport st
      where st.route_id = trips.route_id and st.student_id in (select my_students())
    )
  );
