-- In-app calls and Figbloom live classes, on LiveKit Cloud.
--
-- The audio and video never touch Supabase: LiveKit carries them. What lives
-- here is who may talk to whom, the call log, and which live classes are
-- running. The call-token edge function holds the LiveKit key and secret,
-- checks these rules, and hands the browser a short-lived token for one room.
--
--   may_contact(a, b)   whether two people may call (and later chat with)
--                       each other: staff with staff, a parent with their
--                       own child, their child's teachers and the office
--   my_contacts()       everyone the caller may contact, with a name to show
--   calls               one row per 1:1 call: ringing -> accepted / declined /
--                       missed -> ended. The callee hears it ring over
--                       Realtime (and push, when the phone app is installed).
--                       Written by call-token (service role) and
--                       set_call_status(); the office can read the log.
--   live_classes        a class's live lesson while it runs. A teacher starts
--                       and ends it through call-token; learners in the class
--                       and their parents see "Live now" and join.
--
-- Online classes (20261025010000) also learn a second kind of room: a
-- standing link or a dated lesson can say "Figbloom live class" (room =
-- 'live', no url) instead of a pasted Meet / Zoom / Teams link.

-- ================================================================ who may contact whom

-- A teacher of this learner: teaches their class a subject, is their class
-- teacher, or (higher ed) instructs a section they're enrolled in.
create or replace function teaches_learner(p_teacher_id uuid, p_student_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
      select 1 from students s join teaching_assignments ta on ta.class_id = s.class_id
      where s.id = p_student_id and ta.teacher_id = p_teacher_id)
    or exists (
      select 1 from students s join classes c on c.id = s.class_id
      where s.id = p_student_id and c.class_teacher_id = p_teacher_id)
    or exists (
      select 1 from enrollments e join course_sections cs on cs.id = e.course_section_id
      where e.student_id = p_student_id and e.status = 'enrolled' and cs.instructor_id = p_teacher_id)
$$;

-- One direction of the pairing rule; may_contact() tries both. Roles are
-- compared as text so a staff role added later can join the list without
-- this depending on the enum value already existing.
create or replace function may_contact_from(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles pa, profiles pb
    where pa.id = a and pb.id = b and pa.tenant_id is not null and pa.tenant_id = pb.tenant_id
      and (
        -- staff with staff: the office, teachers, drivers
        (pa.role::text in ('school_admin', 'teacher', 'driver') and pb.role::text in ('school_admin', 'teacher', 'driver'))
        -- a parent with the principal / office
        or (pa.role = 'parent' and pb.role = 'school_admin')
        -- a parent with their own child
        or (pa.role = 'parent' and pb.role = 'student' and exists (
              select 1 from guardians g join students s on s.id = g.student_id
              where g.profile_id = pa.id and s.profile_id = pb.id and s.active))
        -- a parent with a teacher of one of their children
        or (pa.role = 'parent' and pb.role = 'teacher' and exists (
              select 1 from guardians g join students s on s.id = g.student_id
              where g.profile_id = pa.id and s.active and teaches_learner(pb.id, s.id)))
      )
  )
$$;

-- Symmetric. Only answers about the caller themself: otherwise anyone could
-- probe whose parent is whose. auth.uid() is null for the service role
-- (call-token), which may ask about anyone.
create or replace function may_contact(a uuid, b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select a <> b
    and (auth.uid() is null or auth.uid() in (a, b) or is_super())
    and (may_contact_from(a, b) or may_contact_from(b, a))
$$;

revoke execute on function may_contact_from(uuid, uuid) from public;
revoke execute on function teaches_learner(uuid, uuid) from public;
grant execute on function may_contact(uuid, uuid) to authenticated;

-- The caller's address book. Names and titles only: a parent can't read
-- other profiles, and doesn't need a teacher's phone number to call them in
-- the app.
create or replace function my_contacts()
returns table(id uuid, full_name text, role text, staff_title text, avatar_url text)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.role::text, p.staff_title, p.avatar_url
  from profiles p
  where p.tenant_id = my_tenant() and p.id <> auth.uid() and may_contact(auth.uid(), p.id)
  order by p.full_name
$$;

grant execute on function my_contacts() to authenticated;

-- ================================================================ calls

create table calls (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants on delete cascade,
  caller_id    uuid references profiles on delete set null,
  callee_id    uuid references profiles on delete set null,
  -- names as they were when the call was made: a parent's ringing screen
  -- can't read the teacher's profile row
  caller_name  text not null,
  callee_name  text not null,
  video        boolean not null default false,
  status       text not null default 'ringing' check (status in ('ringing', 'accepted', 'declined', 'missed', 'ended')),
  created_at   timestamptz not null default now(),
  answered_at  timestamptz,
  ended_at     timestamptz,
  ended_by     uuid references profiles on delete set null,
  constraint calls_two_people check (caller_id is distinct from callee_id)
);
create index on calls (callee_id, created_at desc);
create index on calls (caller_id, created_at desc);
create index on calls (tenant_id, created_at desc);

alter table calls enable row level security;

-- The two people on the call; the office sees the school's call log (who
-- called whom, when, how long), never anything said.
create policy calls_read on calls for select
  using (caller_id = auth.uid() or callee_id = auth.uid() or may_administer(tenant_id));

alter publication supabase_realtime add table calls;

-- How long a call rings before it counts as missed. The browser gives up at
-- the same point (CALL_RING_SECONDS in packages/shared/src/calls.ts).
create or replace function call_ring_expired(p_created_at timestamptz) returns boolean
language sql stable as $$ select p_created_at < now() - interval '45 seconds' $$;

-- The only way a call changes state after call-token creates it:
--   accepted / declined   the callee, while it rings
--   missed                the caller hanging up before an answer (or giving up)
--   ended                 either of them, once it was answered
-- Anything else is refused, so a stale tab can't revive a finished call.
create or replace function set_call_status(p_call_id uuid, p_status text) returns calls
language plpgsql security definer set search_path = public as $$
declare
  v_call calls%rowtype;
  v_me   uuid := auth.uid();
begin
  select * into v_call from calls where id = p_call_id for update;
  if v_call.id is null or v_me is null or v_me not in (v_call.caller_id, v_call.callee_id) then
    raise exception 'That call could not be found' using errcode = '42501';
  end if;

  if v_call.status = 'ringing' and call_ring_expired(v_call.created_at) then
    update calls set status = 'missed', ended_at = now() where id = p_call_id returning * into v_call;
  end if;

  if p_status in ('accepted', 'declined') and v_me = v_call.callee_id and v_call.status = 'ringing' then
    update calls set status = p_status, answered_at = case when p_status = 'accepted' then now() end,
      ended_at = case when p_status = 'declined' then now() end
    where id = p_call_id returning * into v_call;
  elsif p_status = 'missed' and v_me = v_call.caller_id and v_call.status = 'ringing' then
    update calls set status = 'missed', ended_at = now(), ended_by = v_me where id = p_call_id returning * into v_call;
  elsif p_status = 'ended' and v_call.status = 'accepted' then
    update calls set status = 'ended', ended_at = now(), ended_by = v_me where id = p_call_id returning * into v_call;
  elsif p_status = 'ended' and v_call.status in ('declined', 'missed', 'ended') then
    -- hanging up twice (both tabs, or after the other side already did) is fine
    null;
  elsif p_status = 'accepted' and v_call.status = 'missed' then
    raise exception 'The call has already ended' using errcode = '22023';
  elsif v_call.status <> p_status then
    raise exception 'A % call cannot become %', v_call.status, p_status using errcode = '22023';
  end if;
  return v_call;
end;
$$;

grant execute on function set_call_status(uuid, text) to authenticated;

-- ================================================================ live classes

create table live_classes (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants on delete cascade,
  class_id              uuid not null references classes on delete cascade,
  -- null = a class-wide session (form time, a class meeting)
  subject_id            uuid references subjects on delete set null,
  -- "Form 2 East · Mathematics", shown on the Join card
  title                 text not null check (char_length(title) between 1 and 160),
  started_by            uuid references profiles on delete set null,
  -- learners join with mic and camera off and can't turn them on unless the
  -- teacher allows it; parents only ever watch
  learners_may_publish  boolean not null default false,
  started_at            timestamptz not null default now(),
  ended_at              timestamptz
);
-- one live lesson per class at a time
create unique index live_classes_one_running on live_classes (class_id) where ended_at is null;
create index on live_classes (tenant_id, started_at desc);

alter table live_classes enable row level security;

-- As open as class_meeting_links: knowing a class is live is no more private
-- than its timetable. Joining still needs a token from call-token, which
-- checks the caller is in the class. Writes are call-token's (service role).
create policy live_classes_read on live_classes for select
  using (is_super() or tenant_id = my_tenant() or may_administer(tenant_id));

alter publication supabase_realtime add table live_classes;

-- What the caller is in a live class: 'host' (teaches the class, or the
-- office), 'learner' (in the class), 'family' (a parent of a learner in it),
-- or null. call-token asks this as the user.
create or replace function live_class_role(p_live_class_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when may_administer(lc.tenant_id)
      or (lc.tenant_id = my_tenant() and may_set_class_link(lc.class_id, null)) then 'host'
    when exists (select 1 from students s where s.class_id = lc.class_id and s.profile_id = auth.uid() and s.active) then 'learner'
    when exists (
      select 1 from guardians g join students s on s.id = g.student_id
      where g.profile_id = auth.uid() and s.class_id = lc.class_id and s.active) then 'family'
  end
  from live_classes lc
  where lc.id = p_live_class_id
$$;

-- Whether the caller may start a live class for this class (+ subject).
create or replace function may_host_class(p_class_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from classes c
    where c.id = p_class_id
      and (may_administer(c.tenant_id) or (c.tenant_id = my_tenant() and may_set_class_link(p_class_id, null)))
  )
$$;

grant execute on function live_class_role(uuid) to authenticated;
grant execute on function may_host_class(uuid) to authenticated;

-- ================================================================ online-class rooms

-- 'link' = a pasted Meet / Zoom / Teams url; 'live' = the class's Figbloom
-- live class, which has no url (learners join in the app).
alter table class_meeting_links
  add column room text not null default 'link' check (room in ('link', 'live')),
  alter column url drop not null,
  add constraint class_meeting_links_room_url check ((room = 'live') = (url is null));

-- On a dated lesson, url null with room 'link' still means "use the class's
-- standing room"; room 'live' says this one period is a live class.
alter table online_lessons
  add column room text not null default 'link' check (room in ('link', 'live')),
  add constraint online_lessons_room_url check (room = 'link' or url is null);
