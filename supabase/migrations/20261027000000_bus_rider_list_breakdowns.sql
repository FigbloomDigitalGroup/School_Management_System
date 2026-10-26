-- The driver's rider list, and breakdowns.
--
-- A. trip_rider_list() now gives the driver everyone on, or assigned to, the
--    bus: the trip's rider rows plus anyone put on the route after the trip
--    started (they have no row yet; marking them inserts one). On a
--    from_school trip it also says who was marked absent (or excused) in
--    class that day, so the driver's screen can strike them through instead
--    of waiting for a child who went home hours ago. A driver can't read
--    attendance; this says only "absent from class today", never the note.
--
-- B. The driver reports a breakdown (report_breakdown()). The office gets a
--    vehicle_alerts row ('breakdown') on the Fleet screen, and families get a
--    bus_updates row ('breakdown'), pushed to their phones by rider-update.
--    Only the families of children still on board, or still waiting to be
--    picked up, are told: a child already dropped off, marked not here, or
--    absent from class on an evening trip isn't affected.

-- ================================================================ A. rider list

-- Absent or excused in the register on the trip's own day (Nairobi time).
create or replace function absent_from_class(p_student_id uuid, p_on date) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from attendance a
    where a.student_id = p_student_id and a.taken_on = p_on and a.mark in ('absent', 'excused')
  )
$$;

revoke execute on function absent_from_class(uuid, date) from public, anon, authenticated;

drop function trip_rider_list(uuid);

create function trip_rider_list(p_trip_id uuid)
returns table(student_id uuid, full_name text, stop_id uuid, status text, boarded_at timestamptz, alighted_at timestamptz, absent_from_class boolean)
language sql stable security definer set search_path = public as $$
  with trip as (
    select t.* from trips t
    where t.id = p_trip_id
      and (t.driver_id = auth.uid() or (t.tenant_id = my_tenant() and is_staff()) or may_administer(t.tenant_id))
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
      and absent_from_class(x.student_id, (trip.started_at at time zone 'Africa/Nairobi')::date)
  from riders x
  cross join trip
  join students s on s.id = x.student_id
  order by s.full_name
$$;

grant execute on function trip_rider_list(uuid) to authenticated;

-- ================================================================ B. breakdowns

alter table vehicle_alerts drop constraint vehicle_alerts_kind_check;
alter table vehicle_alerts add constraint vehicle_alerts_kind_check check (kind in ('speed', 'geofence', 'rider', 'breakdown'));

alter table bus_updates drop constraint bus_updates_kind_check;
alter table bus_updates add constraint bus_updates_kind_check
  check (kind in ('trip_started', 'distance', 'arrived', 'delay', 'boarded', 'alighted', 'absent', 'breakdown'));

-- Called by the trip's own driver while it runs. Returns the alert, and how
-- many children's families were told. A second report within 15 minutes of
-- an unacknowledged one is refused: a double tap must not tell families twice.
create or replace function report_breakdown(p_trip_id uuid, p_note text, p_lat double precision, p_lng double precision)
returns table(alert_id uuid, notified int)
language plpgsql security definer set search_path = public as $$
declare
  v_trip    trips%rowtype;
  v_note    text := nullif(left(trim(coalesce(p_note, '')), 300), '');
  v_plate   text;
  v_lat     double precision;
  v_lng     double precision;
  v_on      uuid[];
  v_waiting uuid[];
  v_on_names      text;
  v_waiting_names text;
  v_alert   uuid;
  v_detail  text;
  v_clock   text := to_char(now() at time zone 'Africa/Nairobi', 'HH24:MI');
begin
  select * into v_trip from trips where id = p_trip_id;
  if v_trip.id is null or v_trip.driver_id is distinct from auth.uid() or v_trip.tenant_id is distinct from my_tenant() then
    raise exception 'You can only report a breakdown on your own trip' using errcode = '42501';
  end if;
  if v_trip.status <> 'active' then
    raise exception 'This trip has already ended' using errcode = '22023';
  end if;
  if exists (
    select 1 from vehicle_alerts
    where trip_id = p_trip_id and kind = 'breakdown' and acknowledged_at is null and created_at > now() - interval '15 minutes'
  ) then
    raise exception 'A breakdown on this trip was already reported. The school has been told.' using errcode = '23505';
  end if;

  select coalesce(plate_number, 'the bus'), last_lat, last_lng into v_plate, v_lat, v_lng from vehicles where id = v_trip.vehicle_id;
  -- 0,0 is a phone that had no fix, as in set_child_home
  if p_lat is not null and p_lng is not null and not (abs(p_lat) < 0.0001 and abs(p_lng) < 0.0001) then
    v_lat := p_lat; v_lng := p_lng;
  end if;

  -- The rider list's own rule, so the driver's screen and this agree on who's affected.
  select
    coalesce(array_agg(r.student_id) filter (where r.status = 'boarded'), '{}'),
    coalesce(array_agg(r.student_id) filter (where r.status = 'expected' and not r.absent_from_class), '{}'),
    string_agg(r.full_name, ', ') filter (where r.status = 'boarded'),
    string_agg(r.full_name, ', ') filter (where r.status = 'expected' and not r.absent_from_class)
  into v_on, v_waiting, v_on_names, v_waiting_names
  from trip_rider_list(p_trip_id) r;

  -- The office needs names, not counts: these are the children to collect.
  v_detail := format('Breakdown reported by the driver at %s. On board: %s. Still to be picked up: %s',
    v_clock, coalesce(v_on_names, 'nobody'), coalesce(v_waiting_names, 'nobody'));
  if v_note is not null then v_detail := v_detail || '. Driver''s note: ' || v_note; end if;

  insert into vehicle_alerts (tenant_id, vehicle_id, trip_id, kind, detail, lat, lng)
  values (v_trip.tenant_id, v_trip.vehicle_id, v_trip.id, 'breakdown', v_detail, coalesce(v_lat, 0), coalesce(v_lng, 0))
  returning id into v_alert;

  -- Two messages: a child on the bus is stuck with it; a child at a stop
  -- shouldn't wait for it. Each starts "Bus ..." to be personalised.
  if cardinality(v_on) > 0 then
    insert into bus_updates (tenant_id, trip_id, vehicle_id, stop_id, student_ids, kind, title, body, dedupe_key)
    values (v_trip.tenant_id, v_trip.id, v_trip.vehicle_id, null, v_on, 'breakdown',
      format('Bus has broken down (%s)', v_clock),
      concat_ws(' ', format('%s broke down with your child on board. The school has been told and is arranging the rest of the journey.', v_plate),
        case when v_note is not null then format('Driver: "%s"', v_note) end),
      'breakdown:' || v_alert || ':on');
  end if;
  if cardinality(v_waiting) > 0 then
    insert into bus_updates (tenant_id, trip_id, vehicle_id, stop_id, student_ids, kind, title, body, dedupe_key)
    values (v_trip.tenant_id, v_trip.id, v_trip.vehicle_id, null, v_waiting, 'breakdown',
      format('Bus has broken down (%s)', v_clock),
      concat_ws(' ', format('%s broke down before reaching your child. The school will tell you how they are getting %s.', v_plate,
          case when v_trip.direction = 'to_school' then 'to school' else 'home' end),
        case when v_note is not null then format('Driver: "%s"', v_note) end),
      'breakdown:' || v_alert || ':waiting');
  end if;

  return query select v_alert, cardinality(v_on) + cardinality(v_waiting);
end;
$$;

revoke execute on function report_breakdown(uuid, text, double precision, double precision) from public, anon;
grant execute on function report_breakdown(uuid, text, double precision, double precision) to authenticated;
