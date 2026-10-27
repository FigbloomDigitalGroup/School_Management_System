-- Sports and co-curricular activities: clubs, societies, teams, music and
-- drama, and the fixtures, competitions, trips and performances they go to.
--
--   activities                   a club, team or society. The office creates
--                                and closes them and picks the patrons.
--   activity_patrons             the teachers who run one. A patron manages
--                                its members and events; nothing else.
--   activity_members             the learners in it, with an optional role
--                                ("Captain", "Secretary").
--   activity_events              a fixture, competition, trip or performance:
--                                when, where, against or hosted by whom, at
--                                what level (inter-house up to national, the
--                                Kenya school games ladder), and its result.
--   activity_event_participants  the learners who took part, and what each
--                                won (a medal, a trophy, "Best actor").
--                                A row with an award or an achievement is
--                                that learner's achievement on their profile.
--
-- Who sees what: anyone in the school sees the activities, who runs them and
-- the events (a fixture list is no more private than the timetable). Who is
-- in a club or took part in an event -- a learner's name against it -- is
-- staff, plus each family for its own children.
--
-- Telling families about an upcoming event is an ordinary announcement to
-- the participants' parents (audience kind 'people'), sent from the app with
-- activity_event_family() below supplying the people; send-push does the rest.

-- ---------------------------------------------------------------- tables
create table activities (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants on delete cascade,
  name             text not null check (length(trim(name)) between 1 and 120),
  category         text not null check (category in ('sport', 'club', 'arts', 'other')),
  description      text not null default '' check (length(description) <= 2000),
  -- "Tuesdays and Thursdays, 4:10 to 5:30 pm, main field": free text, since
  -- games time rarely fits the lesson timetable's periods
  meeting_schedule text not null default '' check (length(meeting_schedule) <= 300),
  active           boolean not null default true,
  created_by       uuid references profiles on delete set null default auth.uid(),
  created_at       timestamptz not null default now()
);
create unique index activities_tenant_name on activities (tenant_id, lower(trim(name)));

create table activity_patrons (
  activity_id uuid not null references activities on delete cascade,
  teacher_id  uuid not null references profiles on delete cascade,
  tenant_id   uuid not null references tenants on delete cascade,
  primary key (activity_id, teacher_id)
);
create index on activity_patrons (teacher_id);

create table activity_members (
  activity_id uuid not null references activities on delete cascade,
  student_id  uuid not null references students on delete cascade,
  tenant_id   uuid not null references tenants on delete cascade,
  role        text check (role is null or length(trim(role)) between 1 and 60),
  joined_on   date not null default current_date,
  primary key (activity_id, student_id)
);
create index on activity_members (student_id);

create table activity_events (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants on delete cascade,
  activity_id    uuid not null references activities on delete cascade,
  title          text not null check (length(trim(title)) between 1 and 160),
  kind           text not null check (kind in ('fixture', 'competition', 'trip', 'performance', 'other')),
  level          text check (level in ('school', 'inter_house', 'zonal', 'sub_county', 'county', 'regional', 'national', 'international')),
  starts_at      timestamptz not null,
  ends_at        timestamptz check (ends_at is null or ends_at >= starts_at),
  venue          text not null default '' check (length(venue) <= 200),
  -- the other side of a fixture, or whoever hosts a competition or festival
  opponent       text not null default '' check (length(opponent) <= 200),
  status         text not null default 'scheduled' check (status in ('scheduled', 'completed', 'cancelled')),
  -- the result: "2-1", "45 points", and for a team the outcome and placing
  score          text not null default '' check (length(score) <= 120),
  outcome        text check (outcome in ('won', 'drew', 'lost')),
  position       int check (position is null or position between 1 and 1000),
  notes          text not null default '' check (length(notes) <= 4000),
  -- when families were last told about it, so the app can say so and not resend by accident
  notified_at    timestamptz,
  created_by     uuid references profiles on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index on activity_events (tenant_id, starts_at);
create index on activity_events (activity_id, starts_at);

create table activity_event_participants (
  event_id    uuid not null references activity_events on delete cascade,
  student_id  uuid not null references students on delete cascade,
  tenant_id   uuid not null references tenants on delete cascade,
  award       text check (award in ('gold', 'silver', 'bronze', 'trophy', 'certificate', 'other')),
  position    int check (position is null or position between 1 and 1000),
  -- "Gold, 400 m", "Best actor", "Top scorer": what the card on their profile says
  achievement text check (achievement is null or length(trim(achievement)) between 1 and 160),
  primary key (event_id, student_id)
);
create index on activity_event_participants (student_id);

-- ---------------------------------------------------------------- who may do what
-- Security definer so the policies below don't depend on the read policies of
-- the tables they look at.

-- The office, or a teacher who is one of the activity's patrons.
create or replace function may_manage_activity(p_activity_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from activities a
     where a.id = p_activity_id
       and (
         may_administer(a.tenant_id)
         or (a.tenant_id = my_tenant() and my_role() = 'teacher'
             and exists (select 1 from activity_patrons p where p.activity_id = a.id and p.teacher_id = auth.uid()))
       )
  )
$$;

create or replace function may_manage_activity_event(p_event_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select may_manage_activity(e.activity_id) from activity_events e where e.id = p_event_id), false)
$$;

revoke execute on function may_manage_activity(uuid) from public, anon;
revoke execute on function may_manage_activity_event(uuid) from public, anon;
grant execute on function may_manage_activity(uuid) to authenticated;
grant execute on function may_manage_activity_event(uuid) to authenticated;

-- ---------------------------------------------------------------- row-level security
alter table activities enable row level security;
alter table activity_patrons enable row level security;
alter table activity_members enable row level security;
alter table activity_events enable row level security;
alter table activity_event_participants enable row level security;

create policy activities_read on activities for select
  using (may_administer(tenant_id) or tenant_id = my_tenant());
-- Creating, closing and deleting a club is the office's; a patron may keep
-- its description and meeting times up to date (the trigger below stops
-- them changing anything else).
create policy activities_insert on activities for insert
  with check (may_administer(tenant_id));
create policy activities_update on activities for update
  using (may_manage_activity(id)) with check (may_manage_activity(id));
create policy activities_delete on activities for delete
  using (may_administer(tenant_id));

create policy activity_patrons_read on activity_patrons for select
  using (may_administer(tenant_id) or tenant_id = my_tenant());
create policy activity_patrons_write on activity_patrons for all
  using (may_administer(tenant_id)) with check (may_administer(tenant_id));

create policy activity_members_read on activity_members for select
  using (
    may_administer(tenant_id)
    or (tenant_id = my_tenant() and (is_staff() or student_id in (select my_students())))
  );
create policy activity_members_write on activity_members for all
  using (may_manage_activity(activity_id)) with check (may_manage_activity(activity_id));

create policy activity_events_read on activity_events for select
  using (may_administer(tenant_id) or tenant_id = my_tenant());
create policy activity_events_write on activity_events for all
  using (may_manage_activity(activity_id)) with check (may_manage_activity(activity_id));

create policy activity_event_participants_read on activity_event_participants for select
  using (
    may_administer(tenant_id)
    or (tenant_id = my_tenant() and (is_staff() or student_id in (select my_students())))
  );
create policy activity_event_participants_write on activity_event_participants for all
  using (may_manage_activity_event(event_id)) with check (may_manage_activity_event(event_id));

-- ---------------------------------------------------------------- consistency guards
-- A patron only edits the club's description and meeting times; the name,
-- category, whether it's running and its school are the office's.
create or replace function activities_consistent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    if new.tenant_id <> old.tenant_id then
      raise exception 'An activity can''t move to another school.' using errcode = '42501';
    end if;
    if not may_administer(old.tenant_id)
       and (new.name is distinct from old.name or new.category is distinct from old.category or new.active is distinct from old.active) then
      raise exception 'Only the school office can rename, recategorise or close an activity.' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger activities_consistent before insert or update on activities
  for each row execute function activities_consistent();

-- Patrons are teachers (or the office) at the activity's own school; the row
-- carries that school whatever the client sent.
create or replace function activity_patrons_consistent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.tenant_id := (select tenant_id from activities where id = new.activity_id);
  if not exists (select 1 from profiles where id = new.teacher_id and tenant_id = new.tenant_id and role in ('teacher', 'school_admin')) then
    raise exception 'A patron must be a teacher at this school.' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger activity_patrons_consistent before insert or update on activity_patrons
  for each row execute function activity_patrons_consistent();

create or replace function activity_members_consistent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and (new.activity_id <> old.activity_id or new.student_id <> old.student_id) then
    raise exception 'Remove the member and add them again instead.' using errcode = '22023';
  end if;
  new.tenant_id := (select tenant_id from activities where id = new.activity_id);
  if not exists (select 1 from students where id = new.student_id and tenant_id = new.tenant_id) then
    raise exception 'That learner belongs to another school.' using errcode = '42501';
  end if;
  new.role := nullif(trim(new.role), '');
  return new;
end $$;
create trigger activity_members_consistent before insert or update on activity_members
  for each row execute function activity_members_consistent();

create or replace function activity_events_consistent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.activity_id <> old.activity_id then
    raise exception 'An event can''t move to another activity.' using errcode = '22023';
  end if;
  new.tenant_id := (select tenant_id from activities where id = new.activity_id);
  if new.tenant_id is null then
    raise exception 'That activity could not be found.' using errcode = '23503';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger activity_events_consistent before insert or update on activity_events
  for each row execute function activity_events_consistent();

-- Anyone at the school may take part in an event, not only the club's
-- members: an athletics team is picked from the whole school.
create or replace function activity_event_participants_consistent() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and (new.event_id <> old.event_id or new.student_id <> old.student_id) then
    raise exception 'Remove the participant and add them again instead.' using errcode = '22023';
  end if;
  new.tenant_id := (select tenant_id from activity_events where id = new.event_id);
  if not exists (select 1 from students where id = new.student_id and tenant_id = new.tenant_id) then
    raise exception 'That learner belongs to another school.' using errcode = '42501';
  end if;
  new.achievement := nullif(trim(new.achievement), '');
  return new;
end $$;
create trigger activity_event_participants_consistent before insert or update on activity_event_participants
  for each row execute function activity_event_participants_consistent();

-- ---------------------------------------------------------------- lookups
-- Patrons' names, for families: a parent or learner can't read staff profiles,
-- and "Patron: Mr Otieno" is all they need.
create or replace function activity_patron_names(p_tenant_id uuid)
returns table(activity_id uuid, teacher_id uuid, full_name text)
language sql stable security definer set search_path = public as $$
  select p.activity_id, p.teacher_id, pr.full_name
    from activity_patrons p
    join profiles pr on pr.id = p.teacher_id
   where p.tenant_id = p_tenant_id
     and (p_tenant_id = my_tenant() or may_administer(p_tenant_id))
   order by pr.full_name
$$;
revoke execute on function activity_patron_names(uuid) from public, anon;
grant execute on function activity_patron_names(uuid) to authenticated;

-- Everyone to tell about an event: the participants' guardians, and the
-- participants themselves where they have a login. Only for someone who
-- manages the event; the app sends the announcement to exactly these people.
create or replace function activity_event_family(p_event_id uuid) returns setof uuid
language sql stable security definer set search_path = public as $$
  select distinct x.profile_id from (
    select g.profile_id
      from activity_event_participants ep join guardians g on g.student_id = ep.student_id
     where ep.event_id = p_event_id
    union
    select s.profile_id
      from activity_event_participants ep join students s on s.id = ep.student_id
     where ep.event_id = p_event_id and s.profile_id is not null
  ) x
  where may_manage_activity_event(p_event_id)
$$;
revoke execute on function activity_event_family(uuid) from public, anon;
grant execute on function activity_event_family(uuid) to authenticated;
