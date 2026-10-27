-- Online classes for days the school can't meet in person (teachers' strikes,
-- protests, insecurity, floods). No built-in video: teachers paste a Google
-- Meet / Zoom / Teams link and families tap "Join". Lessons still follow the
-- normal timetable_slots week; these tables only say *which* lessons are
-- online on a given date and *where* to join them.
--
--   remote_days         school-wide switch: every lesson between starts_on
--                       and ends_on runs online. Declared by the office.
--   class_meeting_links a teacher's standing room for a class (+ subject),
--                       reused every remote day so nobody re-pastes links.
--   online_lessons      one dated period made online (or given a different
--                       link) even on a normal school day.
--
-- Which link a period uses is resolved client-side (packages/shared
-- onlineClasses.ts): dated override > class+subject link > class-wide link.

-- A pasted meeting link must be a real https URL: anything else is either a
-- typo or something we shouldn't be putting behind a "Join" button.
create or replace function is_meeting_url(u text) returns boolean
language sql immutable as $$
  select u ~* '^https://[^\s/]+\.[^\s/]+(/\S*)?$' and length(u) <= 2000
$$;

-- Whether the caller may set a link for this class (+ subject). A subject
-- link belongs to whoever teaches that subject in that class; a class-wide
-- link (subject null — form time, class meeting) to anyone who teaches the
-- class or is its class teacher. Security definer so the policies below
-- don't depend on teaching_assignments/classes read policies staying open.
create or replace function may_set_class_link(p_class_id uuid, p_subject_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select my_role() = 'teacher' and (
    exists (
      select 1 from teaching_assignments ta
      where ta.teacher_id = auth.uid() and ta.class_id = p_class_id
        and (p_subject_id is null or ta.subject_id = p_subject_id))
    or (p_subject_id is null and exists (
      select 1 from classes c where c.id = p_class_id and c.class_teacher_id = auth.uid()))
  )
$$;

create table remote_days (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants on delete cascade,
  starts_on   date not null,
  ends_on     date not null,
  reason      text not null check (length(trim(reason)) > 0),  -- "Teachers' strike"
  created_by  uuid references profiles on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  check (ends_on >= starts_on)
);
create index on remote_days (tenant_id, ends_on);

alter table remote_days enable row level security;

-- everyone in the school needs to know the school is online; only the office declares it
create policy remote_days_read on remote_days for select
  using (is_super() or tenant_id = my_tenant() or may_administer(tenant_id));
create policy remote_days_write on remote_days for all
  using (may_administer(tenant_id))
  with check (may_administer(tenant_id));

create table class_meeting_links (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants on delete cascade,
  class_id    uuid not null references classes on delete cascade,
  -- null = the class-wide room, used for any period without its own link
  subject_id  uuid references subjects on delete cascade,
  url         text not null check (is_meeting_url(url)),
  created_by  uuid references profiles on delete set null default auth.uid(),
  updated_at  timestamptz not null default now(),
  -- nulls not distinct: one class-wide (subject null) link per class, too
  unique nulls not distinct (class_id, subject_id)
);
create index on class_meeting_links (tenant_id, class_id);

alter table class_meeting_links enable row level security;

-- Learners and parents read these to join; links to a school's lessons are
-- no more private than its timetable.
create policy class_links_read on class_meeting_links for select
  using (is_super() or tenant_id = my_tenant() or may_administer(tenant_id));
create policy class_links_write on class_meeting_links for all
  using (may_administer(tenant_id) or (tenant_id = my_tenant() and may_set_class_link(class_id, subject_id)))
  with check (may_administer(tenant_id) or (tenant_id = my_tenant() and may_set_class_link(class_id, subject_id)));

create table online_lessons (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants on delete cascade,
  class_id    uuid not null references classes on delete cascade,
  on_date     date not null,
  start_time  text not null check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  subject_id  uuid references subjects on delete set null,
  -- null = online, using the class's standing link
  url         text check (url is null or is_meeting_url(url)),
  note        text,
  created_by  uuid references profiles on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  -- keyed by the exact period occurrence, same as coverage_assignments
  unique (class_id, on_date, start_time)
);
create index on online_lessons (tenant_id, on_date);

alter table online_lessons enable row level security;

create policy online_lessons_read on online_lessons for select
  using (is_super() or tenant_id = my_tenant() or may_administer(tenant_id));
create policy online_lessons_write on online_lessons for all
  using (may_administer(tenant_id) or (tenant_id = my_tenant() and may_set_class_link(class_id, subject_id)))
  with check (may_administer(tenant_id) or (tenant_id = my_tenant() and may_set_class_link(class_id, subject_id)));
