-- The learner's photo on the driver's rider list.
--
-- trip_rider_list() (20261027000000) gave the driver names only. With a full
-- bus, a face is how a driver checks the child in front of them is the one
-- they're marking on: it now also returns students.avatar_url (null when the
-- school hasn't added a photo; the app shows initials then). Who can call it
-- and which children it lists are unchanged.
--
-- A new output column changes the return type, which create or replace can't
-- do, so it is dropped and created again with the same body and grant.

drop function trip_rider_list(uuid);

create function trip_rider_list(p_trip_id uuid)
returns table(student_id uuid, full_name text, stop_id uuid, status text, boarded_at timestamptz, alighted_at timestamptz, absent_from_class boolean, avatar_url text)
language sql stable security definer set search_path = public as $$
  with trip as (
    select t.* from trips t
    where t.id = p_trip_id
      and (t.driver_id = auth.uid() or (t.tenant_id = my_tenant() and is_staff()) or has_perm(t.tenant_id, 'transport'))
  ),
  riders as (
    select r.student_id, r.stop_id, r.status, r.boarded_at, r.alighted_at
    from trip_riders r join trip on r.trip_id = trip.id
    union all
    -- on the route, but added after the trip started: expected, with no row yet
    select st.student_id, st.stop_id, 'expected', null::timestamptz, null::timestamptz
    from student_transport st join trip on st.route_id = trip.route_id
    join students s on s.id = st.student_id and s.active and s.tenant_id = trip.tenant_id
    where not exists (select 1 from trip_riders r where r.trip_id = trip.id and r.student_id = st.student_id)
  )
  select x.student_id, s.full_name, x.stop_id, x.status, x.boarded_at, x.alighted_at,
    trip.direction = 'from_school'
      and absent_from_class(x.student_id, (trip.started_at at time zone 'Africa/Nairobi')::date),
    s.avatar_url
  from riders x
  cross join trip
  join students s on s.id = x.student_id
  order by s.full_name
$$;

revoke execute on function trip_rider_list(uuid) from public, anon;
grant execute on function trip_rider_list(uuid) to authenticated;
