-- Where a learner lives, how they get to school, and what the school needs to
-- know about their health.
--
-- A. students.home_address: the typed address ("Plot 12, Kahawa Sukari, off
--    Thika Rd"), next to the map pin and landmark 20261025020000 added. The
--    pin is what plans routes; the address is what a person reads, and what
--    gets looked up on the map when there's no pin yet (a CSV import).
--
-- B. Bus stops that keep their identity. Saving a route's stops used to
--    delete and re-insert every one, which (stop_id on delete set null)
--    silently took every child off their stop. save_route_stops() updates
--    stops in place by id and deletes only the ones taken off the route.
--    assign_learner_bus() puts a learner on a route, at an existing stop or a
--    new one slotted in between two others, in one transaction.
--
-- C. student_health: allergies, conditions, medication, blood group, diet,
--    doctor and emergency contact. One row per learner. Staff read it
--    (teachers need to know about a nut allergy), the learner's guardians and
--    the learner read it, and admins and guardians write it. Edits are logged
--    to audit_events by field name only: the values stay in this table.

-- ================================================================ A. address

alter table students
  add column home_address text,
  add constraint students_home_address_len check (home_address is null or char_length(home_address) <= 300);

-- The stamp from 20261025020000, now counting the address as part of the home.
create or replace function students_stamp_home() returns trigger
language plpgsql set search_path = public as $$
begin
  if (TG_OP = 'INSERT' and (NEW.home_lat is not null or NEW.home_landmark is not null or NEW.home_address is not null))
     or (TG_OP = 'UPDATE' and (NEW.home_lat, NEW.home_lng, NEW.home_landmark, NEW.home_address)
                              is distinct from (OLD.home_lat, OLD.home_lng, OLD.home_landmark, OLD.home_address)) then
    NEW.home_updated_at := now();
    NEW.home_updated_by := auth.uid();
  end if;
  return NEW;
end;
$$;

-- set_child_home gains the address. p_address null leaves the address as it
-- is, so the 4-argument call (a phone dropping a pin) doesn't wipe what the
-- office typed; an empty string clears it.
drop function if exists set_child_home(uuid, double precision, double precision, text);

create or replace function set_child_home(
  p_student_id uuid, p_lat double precision, p_lng double precision, p_landmark text, p_address text default null
) returns void
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
  set home_lat = p_lat, home_lng = p_lng,
      home_landmark = nullif(left(trim(coalesce(p_landmark, '')), 200), ''),
      home_address = case when p_address is null then home_address else nullif(left(trim(p_address), 300), '') end
  where id = p_student_id;
end;
$$;

revoke execute on function set_child_home(uuid, double precision, double precision, text, text) from public, anon;
grant execute on function set_child_home(uuid, double precision, double precision, text, text) to authenticated;

-- ================================================================ B. stops

-- Replace a route's ordered stop list. Each element is {id?, name, lat, lng};
-- an element with the id of one of this route's stops updates that stop (its
-- riders stay on it), one without an id is a new stop, and this route's stops
-- missing from the list are deleted. unique (route_id, sequence) isn't
-- deferrable, so every kept stop is first moved to a negative sequence and
-- then numbered 1..n.
create or replace function save_route_stops(p_route_id uuid, p_stops jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_el     jsonb;
  v_i      bigint;
  v_id     uuid;
  v_name   text;
  v_lat    double precision;
  v_lng    double precision;
begin
  select tenant_id into v_tenant from routes where id = p_route_id for update;
  if v_tenant is null or not may_administer(v_tenant) then
    raise exception 'You can only change the stops of a route at a school you administer' using errcode = '42501';
  end if;
  if p_stops is null or jsonb_typeof(p_stops) <> 'array' then
    raise exception 'Stops must be a list' using errcode = '22023';
  end if;

  delete from route_stops
  where route_id = p_route_id
    and id not in (
      select (e->>'id')::uuid from jsonb_array_elements(p_stops) e where coalesce(e->>'id', '') <> ''
    );

  update route_stops set sequence = -sequence where route_id = p_route_id and sequence > 0;

  for v_el, v_i in select e, n from jsonb_array_elements(p_stops) with ordinality as t(e, n) loop
    v_name := nullif(left(trim(coalesce(v_el->>'name', '')), 120), '');
    v_lat := (v_el->>'lat')::double precision;
    v_lng := (v_el->>'lng')::double precision;
    if v_name is null or v_lat is null or v_lng is null
       or v_lat not between -90 and 90 or v_lng not between -180 and 180 then
      raise exception 'Stop % needs a name and a place on the map', v_i using errcode = '22023';
    end if;
    v_id := nullif(v_el->>'id', '')::uuid;
    if v_id is not null and exists (select 1 from route_stops where id = v_id and route_id = p_route_id) then
      update route_stops set name = v_name, lat = v_lat, lng = v_lng, sequence = v_i where id = v_id;
    else
      insert into route_stops (tenant_id, route_id, name, lat, lng, sequence)
      values (v_tenant, p_route_id, v_name, v_lat, v_lng, v_i);
    end if;
  end loop;
end;
$$;

-- Put a learner on a bus, or take them off one (p_route_id null).
--   p_stop_id   an existing stop on that route (or null: rider without a stop yet)
--   p_new_stop  {name, lat, lng, position}: a new stop at that 1-based place in
--               the route, the stops from there on moving down one. Wins over
--               p_stop_id.
-- Returns the learner's stop id.
create or replace function assign_learner_bus(
  p_student_id uuid, p_route_id uuid, p_stop_id uuid default null, p_new_stop jsonb default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_route_tenant uuid;
  v_stop   uuid := p_stop_id;
  v_pos    int;
  v_count  int;
  v_name   text;
  v_lat    double precision;
  v_lng    double precision;
begin
  select tenant_id into v_tenant from students where id = p_student_id;
  if v_tenant is null or not may_administer(v_tenant) then
    raise exception 'You can only set the bus of a learner at a school you administer' using errcode = '42501';
  end if;

  if p_route_id is null then
    delete from student_transport where student_id = p_student_id;
    return null;
  end if;

  select tenant_id into v_route_tenant from routes where id = p_route_id for update;
  if v_route_tenant is distinct from v_tenant then
    raise exception 'That route is not at this learner''s school' using errcode = '42501';
  end if;

  if p_new_stop is not null then
    v_name := nullif(left(trim(coalesce(p_new_stop->>'name', '')), 120), '');
    v_lat := (p_new_stop->>'lat')::double precision;
    v_lng := (p_new_stop->>'lng')::double precision;
    if v_name is null or v_lat is null or v_lng is null
       or v_lat not between -90 and 90 or v_lng not between -180 and 180 then
      raise exception 'A new stop needs a name and a place on the map' using errcode = '22023';
    end if;
    select count(*) into v_count from route_stops where route_id = p_route_id;
    v_pos := greatest(1, least(coalesce((p_new_stop->>'position')::int, v_count + 1), v_count + 1));
    -- make room: the stops from v_pos on move down one, via negative sequences
    update route_stops set sequence = -sequence where route_id = p_route_id and sequence >= v_pos;
    update route_stops set sequence = -sequence + 1 where route_id = p_route_id and sequence < 0;
    insert into route_stops (tenant_id, route_id, name, lat, lng, sequence)
    values (v_tenant, p_route_id, v_name, v_lat, v_lng, v_pos)
    returning id into v_stop;
  elsif v_stop is not null and not exists (select 1 from route_stops where id = v_stop and route_id = p_route_id) then
    raise exception 'That stop is not on this route' using errcode = '22023';
  end if;

  insert into student_transport (tenant_id, student_id, route_id, stop_id)
  values (v_tenant, p_student_id, p_route_id, v_stop)
  on conflict (student_id) do update set route_id = excluded.route_id, stop_id = excluded.stop_id, tenant_id = excluded.tenant_id;
  return v_stop;
end;
$$;

revoke execute on function save_route_stops(uuid, jsonb), assign_learner_bus(uuid, uuid, uuid, jsonb) from public, anon;
grant execute on function save_route_stops(uuid, jsonb), assign_learner_bus(uuid, uuid, uuid, jsonb) to authenticated;

-- ================================================================ C. health

create table student_health (
  student_id             uuid primary key references students on delete cascade,
  tenant_id              uuid not null references tenants on delete cascade,
  allergies              text[] not null default '{}',
  medical_conditions     text[] not null default '{}',
  medications            text,
  blood_group            text check (blood_group in ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-')),
  dietary_needs          text,
  -- learning or physical support needs, and anything else the school should know
  special_needs          text,
  notes                  text,
  doctor_name            text,
  doctor_phone           text,
  emergency_name         text,
  emergency_relationship text,
  emergency_phone        text,
  updated_at             timestamptz not null default now(),
  updated_by             uuid references profiles on delete set null,
  constraint student_health_list_sizes check (cardinality(allergies) <= 30 and cardinality(medical_conditions) <= 30),
  constraint student_health_text_len check (
    coalesce(char_length(medications), 0) <= 1000 and coalesce(char_length(dietary_needs), 0) <= 500
    and coalesce(char_length(special_needs), 0) <= 1000 and coalesce(char_length(notes), 0) <= 2000
    and coalesce(char_length(doctor_name), 0) <= 120 and coalesce(char_length(doctor_phone), 0) <= 40
    and coalesce(char_length(emergency_name), 0) <= 120 and coalesce(char_length(emergency_relationship), 0) <= 60
    and coalesce(char_length(emergency_phone), 0) <= 40
  )
);
create index on student_health (tenant_id);

alter table student_health enable row level security;

-- Staff (and org admins) see every learner's; a family sees their own child's; a learner sees their own.
create policy student_health_read on student_health for select
  using (may_administer(tenant_id) or (tenant_id = my_tenant() and is_staff()) or student_id in (select my_students()));

-- Admins write any learner's; a guardian writes their own child's. No delete
-- for guardians: clearing the fields is the same thing, and stays audited.
create policy student_health_admin_write on student_health for all
  using (may_administer(tenant_id)) with check (may_administer(tenant_id));
create policy student_health_guardian_insert on student_health for insert
  with check (exists (select 1 from guardians g where g.student_id = student_health.student_id and g.profile_id = auth.uid()));
create policy student_health_guardian_update on student_health for update
  using (exists (select 1 from guardians g where g.student_id = student_health.student_id and g.profile_id = auth.uid()))
  with check (exists (select 1 from guardians g where g.student_id = student_health.student_id and g.profile_id = auth.uid()));

create trigger student_health_student_tenant before insert or update of tenant_id, student_id on student_health
  for each row execute function enforce_student_tenant();

-- Tidy the lists (trimmed, no blanks or repeats), stamp who and when, and log
-- which fields changed. Field names only: health details don't belong in the
-- audit log, which more people can read.
create or replace function student_health_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_changed text[] := '{}';
  v_name    text;
begin
  if TG_OP = 'UPDATE' and NEW.student_id <> OLD.student_id then
    raise exception 'A health record cannot be moved to another learner' using errcode = '42501';
  end if;
  NEW.allergies := coalesce((select array_agg(distinct x order by x) from (select left(trim(a), 80) x from unnest(NEW.allergies) a) t where x <> ''), '{}');
  NEW.medical_conditions := coalesce((select array_agg(distinct x order by x) from (select left(trim(c), 120) x from unnest(NEW.medical_conditions) c) t where x <> ''), '{}');
  NEW.updated_at := now();
  NEW.updated_by := coalesce(auth.uid(), NEW.updated_by);

  if TG_OP = 'INSERT' then
    v_changed := array['created'];
  else
    if NEW.allergies is distinct from OLD.allergies then v_changed := array_append(v_changed, 'allergies'); end if;
    if NEW.medical_conditions is distinct from OLD.medical_conditions then v_changed := array_append(v_changed, 'medical conditions'); end if;
    if NEW.medications is distinct from OLD.medications then v_changed := array_append(v_changed, 'medications'); end if;
    if NEW.blood_group is distinct from OLD.blood_group then v_changed := array_append(v_changed, 'blood group'); end if;
    if NEW.dietary_needs is distinct from OLD.dietary_needs then v_changed := array_append(v_changed, 'dietary needs'); end if;
    if NEW.special_needs is distinct from OLD.special_needs then v_changed := array_append(v_changed, 'special needs'); end if;
    if NEW.notes is distinct from OLD.notes then v_changed := array_append(v_changed, 'notes'); end if;
    if (NEW.doctor_name, NEW.doctor_phone) is distinct from (OLD.doctor_name, OLD.doctor_phone) then v_changed := array_append(v_changed, 'doctor'); end if;
    if (NEW.emergency_name, NEW.emergency_relationship, NEW.emergency_phone)
       is distinct from (OLD.emergency_name, OLD.emergency_relationship, OLD.emergency_phone) then v_changed := array_append(v_changed, 'emergency contact'); end if;
  end if;

  if cardinality(v_changed) > 0 then
    select full_name into v_name from students where id = NEW.student_id;
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    values (NEW.tenant_id, auth.uid(), my_actor_label(),
            format('Health details %s for %s', case when TG_OP = 'INSERT' then 'added' else 'updated' end, coalesce(v_name, 'a learner')),
            'provisioning',
            jsonb_build_object('student_id', NEW.student_id, 'fields', to_jsonb(v_changed)));
  end if;
  return NEW;
end;
$$;

create trigger student_health_stamp before insert or update on student_health
  for each row execute function student_health_stamp();
