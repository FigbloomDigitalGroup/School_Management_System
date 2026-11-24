-- Behaviour and discipline log, with merit / demerit points each school sets up for itself.
--
--   behaviour_settings     one row per school (none = the defaults below): points on/off, mode
--                          (merits_only: merits add; demerits_only: demerits take away from a starting
--                          balance; both), when points start again (term / year / never), the largest
--                          points one entry may carry, thresholds ("-15 in a period: Parent meeting",
--                          "+30: Certificate", shown as badges), and what families see (merits and the
--                          total always; demerits and incidents only when the school turns them on).
--   behaviour_categories   the school's own list (Helping others +2, Fighting -5 serious, ...). Never
--                          deleted: archived, so entries that used one keep it.
--   behaviour_entries      one merit, demerit or incident for one learner. points are signed (+ merit,
--                          - demerit, 0 or - for an incident). Never changed or deleted: a mistake is
--                          voided with a reason (void_behaviour_entry). A serious one (severity
--                          'serious') is an incident to follow up: action_taken and follow_up_status
--                          (open / resolved) are set by the office (set_behaviour_incident).
--   behaviour_staff_notes  the "staff only" note of an entry, in a table of its own that families and
--                          learners can never read (RLS is per row, so a column could not be hidden).
--
-- Who:
--   * a teacher records for, and reads, the learners they teach: their class (class teacher) or a
--     class they have a teaching assignment in (my_taught_student_ids), and anything they recorded;
--   * the office: the new admin area 'discipline' (full admins have it), everything at the school,
--     the settings, the categories, voiding and the incident record;
--   * a guardian or the learner: their own entries, merits always, demerits / incidents as the
--     school's settings allow, never voided ones, never staff notes. The points total comes from
--     behaviour_points(), which counts every entry (a total that hid demerits would be wrong).
--
-- Every policy works out the caller's rights once per statement with the helpers of
-- 20261124300000_rls_once_per_query (my_perm_tenant_ids, my_guardian_student_ids, (select ...)).
--
-- Depends on nothing from the attendance migrations of 2026-11-10.

-- ================================================================ the 'discipline' area

create or replace function is_admin_area(p_area text) returns boolean
language sql immutable as $$
  select p_area in ('people', 'fees', 'academics', 'attendance', 'transport', 'communication',
                    'inventory', 'activities', 'visitors', 'medical', 'leave', 'audit', 'discipline')
$$;

-- ================================================================ tables

create or replace function behaviour_thresholds_valid(p jsonb) returns boolean
language sql immutable as $$
  select jsonb_typeof(p) = 'array'
     and jsonb_array_length(p) <= 10
     and coalesce((select bool_and(
           jsonb_typeof(e) = 'object'
           and jsonb_typeof(e -> 'points') = 'number'
           and (e ->> 'points')::numeric = trunc((e ->> 'points')::numeric)
           and (e ->> 'points')::numeric <> 0
           and abs((e ->> 'points')::numeric) <= 10000
           and jsonb_typeof(e -> 'label') = 'string'
           and char_length(btrim(e ->> 'label')) between 1 and 60)
         from jsonb_array_elements(p) e), true)
$$;

create table behaviour_settings (
  tenant_id             uuid primary key references tenants on delete cascade,
  points_enabled        boolean not null default true,
  mode                  text not null default 'both' check (mode in ('merits_only', 'demerits_only', 'both')),
  -- where a learner starts each period in demerits_only mode (ignored by the other modes: they start at 0)
  starting_points      int not null default 100 check (starting_points between 0 and 10000),
  reset                 text not null default 'term' check (reset in ('term', 'year', 'never')),
  max_points_per_entry  int not null default 10 check (max_points_per_entry between 1 and 100),
  thresholds            jsonb not null default '[{"points": -15, "label": "Parent meeting"}, {"points": 30, "label": "Certificate"}]'::jsonb
                        check (behaviour_thresholds_valid(thresholds)),
  parents_see_demerits  boolean not null default false,
  parents_see_incidents boolean not null default false,
  updated_by            uuid references profiles on delete set null,
  updated_at            timestamptz not null default now()
);

create table behaviour_categories (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants on delete cascade,
  kind        text not null check (kind in ('merit', 'demerit')),
  name        text not null check (char_length(btrim(name)) between 2 and 60),
  -- the default size of an entry (always positive here; a demerit's entry is stored negative)
  points      int not null check (points between 0 and 100),
  severity    text check (severity in ('minor', 'major', 'serious')),
  sort_order  int not null default 0,
  archived_at timestamptz,
  created_by  uuid references profiles on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  constraint behaviour_categories_severity check ((kind = 'merit') = (severity is null))
);
create unique index behaviour_categories_name_unique on behaviour_categories (tenant_id, kind, lower(btrim(name)));
-- (an entry's category is checked to be the same school's by behaviour_entry_prepare)
create unique index behaviour_categories_tenant_id on behaviour_categories (tenant_id, id);

create table behaviour_entries (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants on delete cascade,
  student_id         uuid not null references students on delete cascade,
  category_id        uuid references behaviour_categories on delete restrict,
  kind               text not null check (kind in ('merit', 'demerit', 'incident')),
  points             int not null,
  severity           text check (severity in ('minor', 'major', 'serious')),
  note               text check (note is null or char_length(note) <= 1000),
  occurred_on        date not null default current_date,
  class_id           uuid references classes on delete set null,      -- the learner's class when recorded
  subject_id         uuid references subjects on delete set null,
  recorded_by        uuid references profiles on delete set null default auth.uid(),
  created_at         timestamptz not null default now(),
  -- a correction: the entry stays, uncounted and hidden from families
  voided_at          timestamptz,
  voided_by          uuid references profiles on delete set null,
  void_reason        text check (void_reason is null or char_length(void_reason) between 3 and 300),
  -- the incident record (serious ones)
  action_taken       text check (action_taken in ('warning', 'detention', 'parent_called', 'parent_meeting',
                                                  'suspension', 'counsellor', 'other')),
  follow_up_status   text check (follow_up_status in ('open', 'resolved')),
  resolved_by        uuid references profiles on delete set null,
  resolved_at        timestamptz,
  parent_notified_at timestamptz,
  constraint behaviour_entries_sign check (
    (kind = 'merit' and points > 0) or (kind = 'demerit' and points < 0) or (kind = 'incident' and points <= 0)),
  constraint behaviour_entries_category check (kind = 'incident' or category_id is not null),
  constraint behaviour_entries_merit_severity check (kind <> 'merit' or severity is null),
  constraint behaviour_entries_incident_note check (kind <> 'incident' or category_id is not null or note is not null),
  constraint behaviour_entries_void check ((voided_at is null) = (void_reason is null))
);
create index on behaviour_entries (tenant_id, occurred_on desc);
create index on behaviour_entries (student_id, occurred_on desc);
create index on behaviour_entries (tenant_id, class_id, occurred_on desc);
create index on behaviour_entries (recorded_by);
create index behaviour_entries_open on behaviour_entries (tenant_id) where follow_up_status = 'open';

create table behaviour_staff_notes (
  entry_id   uuid primary key references behaviour_entries on delete cascade,
  tenant_id  uuid not null references tenants on delete cascade,
  note       text not null check (char_length(note) between 1 and 1000),
  created_by uuid references profiles on delete set null default auth.uid(),
  created_at timestamptz not null default now()
);
create index on behaviour_staff_notes (tenant_id);

alter table behaviour_settings enable row level security;
alter table behaviour_categories enable row level security;
alter table behaviour_entries enable row level security;
alter table behaviour_staff_notes enable row level security;

-- ================================================================ the caller's rights, as sets

-- Learners the caller teaches: in a class they are class teacher of, or have a teaching assignment in.
-- Read as security definer (like my_teaching_pairs), once per statement.
create or replace function my_taught_student_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select s.id from students s
   where s.tenant_id = my_tenant()
     and my_role() = 'teacher'
     and (s.class_id in (select ta.class_id from teaching_assignments ta where ta.teacher_id = auth.uid())
          or s.class_id in (select c.id from classes c where c.class_teacher_id = auth.uid()))
$$;

-- The kinds of entry families (guardians, learners) at the caller's school may see.
create or replace function my_behaviour_family_kinds() returns setof text
language sql stable security definer set search_path = public as $$
  select 'merit'
  union all
  select 'demerit' from behaviour_settings where tenant_id = my_tenant() and parents_see_demerits
  union all
  select 'incident' from behaviour_settings where tenant_id = my_tenant() and parents_see_incidents
$$;

-- ================================================================ policies

create policy behaviour_settings_read on behaviour_settings for select to authenticated using (
  (select is_super()) or tenant_id = (select my_tenant()) or tenant_id in (select my_perm_tenant_ids('discipline')));
create policy behaviour_settings_insert on behaviour_settings for insert to authenticated with check (
  (select is_super()) or tenant_id in (select my_perm_tenant_ids('discipline')));
create policy behaviour_settings_update on behaviour_settings for update to authenticated
  using ((select is_super()) or tenant_id in (select my_perm_tenant_ids('discipline')))
  with check ((select is_super()) or tenant_id in (select my_perm_tenant_ids('discipline')));

create policy behaviour_categories_read on behaviour_categories for select to authenticated using (
  (select is_super()) or tenant_id = (select my_tenant()) or tenant_id in (select my_perm_tenant_ids('discipline')));
create policy behaviour_categories_insert on behaviour_categories for insert to authenticated with check (
  (select is_super()) or tenant_id in (select my_perm_tenant_ids('discipline')));
create policy behaviour_categories_update on behaviour_categories for update to authenticated
  using ((select is_super()) or tenant_id in (select my_perm_tenant_ids('discipline')))
  with check ((select is_super()) or tenant_id in (select my_perm_tenant_ids('discipline')));
-- no delete policy: a category is archived, never deleted

create policy behaviour_entries_read on behaviour_entries for select to authenticated using (
  (select is_super())
  or tenant_id in (select my_perm_tenant_ids('discipline'))
  or (tenant_id = (select my_tenant())
      and (recorded_by = (select auth.uid()) or student_id in (select my_taught_student_ids())))
  or (tenant_id = (select my_tenant())
      and voided_at is null
      and kind in (select my_behaviour_family_kinds())
      and (student_id in (select my_guardian_student_ids())
           or student_id in (select s.id from students s where s.profile_id = (select auth.uid()))))
);
create policy behaviour_entries_insert on behaviour_entries for insert to authenticated with check (
  (select is_super())
  or tenant_id in (select my_perm_tenant_ids('discipline'))
  or (tenant_id = (select my_tenant()) and (select my_role()) = 'teacher'::app_role
      and student_id in (select my_taught_student_ids()))
);
-- no update or delete policy: void_behaviour_entry and set_behaviour_incident are the only changes

create policy behaviour_staff_notes_read on behaviour_staff_notes for select to authenticated using (
  (select is_super())
  or tenant_id in (select my_perm_tenant_ids('discipline'))
  or (tenant_id = (select my_tenant()) and (select my_role()) = 'teacher'::app_role
      and entry_id in (select e.id from behaviour_entries e))      -- the entries the teacher may read
);
create policy behaviour_staff_notes_insert on behaviour_staff_notes for insert to authenticated with check (
  (select is_super())
  or tenant_id in (select my_perm_tenant_ids('discipline'))
  or (tenant_id = (select my_tenant())
      and entry_id in (select e.id from behaviour_entries e where e.recorded_by = (select auth.uid())))
);

-- ================================================================ recording

-- Checks and completes an entry: the learner and category are this school's, the kind matches the
-- category, the points have the right sign and are within the school's limit, the date is not in the
-- future. Fills in the learner's class, the severity (from the category) and who recorded it. A
-- signed-in caller can't set the void or incident columns (those have their own functions); the server
-- (the demo seed, with no one signed in) may, to load history.
create or replace function behaviour_entry_prepare() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_cat    behaviour_categories%rowtype;
  v_stu    students%rowtype;
  v_max    int;
  v_today  date := (now() at time zone 'Africa/Nairobi')::date;
  v_server boolean := auth.uid() is null;
begin
  select * into v_stu from students where id = NEW.student_id;
  if v_stu.id is null or v_stu.tenant_id <> NEW.tenant_id then
    raise exception 'That learner is not at this school' using errcode = '42501';
  end if;
  if v_stu.archived_at is not null and not v_server then
    raise exception '% has left the school', v_stu.full_name using errcode = '23514';
  end if;

  if NEW.category_id is not null then
    select * into v_cat from behaviour_categories where id = NEW.category_id;
    if v_cat.id is null or v_cat.tenant_id <> NEW.tenant_id then
      raise exception 'That category is not this school''s' using errcode = '42501';
    end if;
    if v_cat.archived_at is not null and not v_server then
      raise exception '"%" is no longer in use', v_cat.name using errcode = '23514';
    end if;
    if (NEW.kind = 'incident' and v_cat.kind <> 'demerit') or (NEW.kind <> 'incident' and v_cat.kind <> NEW.kind) then
      raise exception '"%" is a % category', v_cat.name, v_cat.kind using errcode = '22023';
    end if;
  elsif NEW.kind <> 'incident' then
    raise exception 'Choose a category' using errcode = '22023';
  end if;

  select max_points_per_entry into v_max from behaviour_settings where tenant_id = NEW.tenant_id;
  v_max := coalesce(v_max, 10);
  if NEW.points is null then
    NEW.points := case NEW.kind when 'merit' then v_cat.points else -coalesce(v_cat.points, 0) end;
  end if;
  if NEW.kind <> 'incident' and NEW.points = 0 then
    raise exception 'A % needs at least 1 point', NEW.kind using errcode = '22023';
  end if;
  if abs(NEW.points) > v_max and not v_server then
    raise exception 'This school allows at most % points for one entry', v_max using errcode = '22023';
  end if;

  NEW.severity := case NEW.kind
                    when 'merit' then null
                    when 'demerit' then v_cat.severity
                    else coalesce(NEW.severity, v_cat.severity, 'serious') end;
  if NEW.occurred_on is null then NEW.occurred_on := v_today; end if;
  if NEW.occurred_on > v_today then
    raise exception 'The date can''t be in the future' using errcode = '22023';
  end if;
  if NEW.occurred_on < v_today - 366 and not v_server then
    raise exception 'That date is more than a year ago' using errcode = '22023';
  end if;
  if NEW.subject_id is not null and not exists (select 1 from subjects where id = NEW.subject_id and tenant_id = NEW.tenant_id) then
    raise exception 'That subject is not this school''s' using errcode = '42501';
  end if;
  NEW.note := nullif(btrim(coalesce(NEW.note, '')), '');

  if v_server then
    NEW.class_id := coalesce(NEW.class_id, v_stu.class_id);
    NEW.follow_up_status := coalesce(NEW.follow_up_status, case when NEW.severity = 'serious' then 'open' end);
  else
    NEW.class_id := v_stu.class_id;
    NEW.recorded_by := auth.uid();
    NEW.created_at := now();
    NEW.voided_at := null; NEW.voided_by := null; NEW.void_reason := null;
    NEW.action_taken := null; NEW.resolved_by := null; NEW.resolved_at := null; NEW.parent_notified_at := null;
    NEW.follow_up_status := case when NEW.severity = 'serious' then 'open' end;
  end if;
  return NEW;
end $$;

create trigger behaviour_entry_prepare before insert on behaviour_entries
  for each row execute function behaviour_entry_prepare();

-- In-app notices (announcements to one person, channel in_app: no SMS, email or push) when a serious
-- entry is recorded by someone signed in: to the learner's class teacher (unless they recorded it),
-- and to the learner's guardians when the school lets families see that kind of entry. The staff-only
-- note is never in a notice. The server's own inserts (the demo seed) send nothing.
create or replace function behaviour_entry_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_learner text;
  v_what    text;
  v_teacher uuid;
  v_family  boolean;
  g         record;
begin
  if auth.uid() is null or NEW.severity is distinct from 'serious' then return null; end if;
  select full_name into v_learner from students where id = NEW.student_id;
  v_what := coalesce((select name from behaviour_categories where id = NEW.category_id), 'An incident');
  select class_teacher_id into v_teacher from classes where id = NEW.class_id;
  if v_teacher is not null and v_teacher <> auth.uid() then
    insert into announcements (tenant_id, author_id, subject, body, audience, channels, published_at)
    values (NEW.tenant_id, auth.uid(), 'Serious incident: ' || v_learner,
            v_what || ' was recorded for ' || v_learner || ' on ' || to_char(NEW.occurred_on, 'DD Mon YYYY') || '.'
              || coalesce(E'\n\n' || NEW.note, '') || E'\n\nThe office follows it up on the Behaviour page.',
            jsonb_build_object('kind', 'user', 'user_id', v_teacher), array['in_app'], now());
  end if;
  select (NEW.kind = 'demerit' and parents_see_demerits) or (NEW.kind = 'incident' and parents_see_incidents)
    into v_family from behaviour_settings where tenant_id = NEW.tenant_id;
  if coalesce(v_family, false) then
    for g in select distinct profile_id from guardians where student_id = NEW.student_id and profile_id is not null loop
      insert into announcements (tenant_id, author_id, subject, body, audience, channels, published_at)
      values (NEW.tenant_id, auth.uid(), 'About ' || v_learner,
              v_what || ' was recorded for ' || v_learner || ' on ' || to_char(NEW.occurred_on, 'DD Mon YYYY')
                || '. The school will be in touch about what happens next.',
              jsonb_build_object('kind', 'user', 'user_id', g.profile_id), array['in_app'], now());
    end loop;
  end if;
  return null;
end $$;

create trigger behaviour_entry_notify after insert on behaviour_entries
  for each row execute function behaviour_entry_notify();

-- Records one category for one or more learners (a class merit), with the same note and staff-only
-- note on each. Runs with the caller's rights: the insert policies decide whom they may record for.
-- p_points is the size (1..max), signed by the kind; null takes the category's default.
create or replace function record_behaviour(
  p_student_ids uuid[], p_kind text, p_category_id uuid, p_points int default null, p_note text default null,
  p_staff_note text default null, p_occurred_on date default null, p_subject_id uuid default null, p_severity text default null
) returns int
language plpgsql security invoker set search_path = public as $$
declare
  v_tenant uuid := my_tenant();
  v_ids    uuid[] := array(select distinct x from unnest(coalesce(p_student_ids, '{}')) x where x is not null);
  v_staff  text := nullif(btrim(coalesce(p_staff_note, '')), '');
  v_points int;
  v_id     uuid;
  s        uuid;
begin
  if v_tenant is null then raise exception 'Sign in to a school first' using errcode = '42501'; end if;
  if cardinality(v_ids) = 0 then raise exception 'Choose at least one learner' using errcode = '22023'; end if;
  if cardinality(v_ids) > 80 then raise exception 'Record for at most 80 learners at once' using errcode = '22023'; end if;
  if p_kind is null or p_kind not in ('merit', 'demerit', 'incident') then raise exception 'Unknown kind %', p_kind using errcode = '22023'; end if;
  if p_points is not null and p_points < 0 then raise exception 'Enter the points as a positive number' using errcode = '22023'; end if;
  v_points := case when p_points is null then null when p_kind = 'merit' then p_points else -p_points end;
  foreach s in array v_ids loop
    insert into behaviour_entries (tenant_id, student_id, category_id, kind, points, severity, note, occurred_on, subject_id)
    values (v_tenant, s, p_category_id, p_kind, v_points, p_severity, p_note,
            coalesce(p_occurred_on, (now() at time zone 'Africa/Nairobi')::date), p_subject_id)
    returning id into v_id;
    if v_staff is not null then
      insert into behaviour_staff_notes (entry_id, tenant_id, note) values (v_id, v_tenant, left(v_staff, 1000));
    end if;
  end loop;
  return cardinality(v_ids);
end $$;

-- Voids an entry (a mistake): it stays in the log, struck through for staff, and stops counting and
-- showing to families. Whoever recorded it, or the office.
create or replace function void_behaviour_entry(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v behaviour_entries%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  select * into v from behaviour_entries where id = p_id for update;
  if v.id is null or not (has_perm(v.tenant_id, 'discipline') or (v.recorded_by = auth.uid() and v.tenant_id = my_tenant())) then
    raise exception 'Only whoever recorded this, or the office, can void it' using errcode = '42501';
  end if;
  if v.voided_at is not null then raise exception 'This entry is already voided' using errcode = '23514'; end if;
  if char_length(v_reason) < 3 then raise exception 'Say why it is being voided' using errcode = '22023'; end if;
  update behaviour_entries set voided_at = now(), voided_by = auth.uid(), void_reason = left(v_reason, 300) where id = p_id;
end $$;

-- The office's record of an incident: the action taken, open or resolved, and whether the parents were
-- told. Any entry that isn't voided can be followed up this way (a serious one starts open).
create or replace function set_behaviour_incident(p_id uuid, p_action text, p_status text, p_parent_notified boolean default false)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v behaviour_entries%rowtype;
begin
  select * into v from behaviour_entries where id = p_id for update;
  if v.id is null or not has_perm(v.tenant_id, 'discipline') then
    raise exception 'Only the office (the discipline area) records what was done about an incident' using errcode = '42501';
  end if;
  if v.voided_at is not null then raise exception 'This entry was voided' using errcode = '23514'; end if;
  if p_status is null or p_status not in ('open', 'resolved') then raise exception 'Status is open or resolved' using errcode = '22023'; end if;
  if p_action is not null and p_action not in ('warning', 'detention', 'parent_called', 'parent_meeting', 'suspension', 'counsellor', 'other') then
    raise exception 'Unknown action %', p_action using errcode = '22023';
  end if;
  update behaviour_entries set
    action_taken = p_action,
    follow_up_status = p_status,
    resolved_by = case when p_status = 'resolved' then coalesce(v.resolved_by, auth.uid()) end,
    resolved_at = case when p_status = 'resolved' then coalesce(v.resolved_at, now()) end,
    parent_notified_at = case when coalesce(p_parent_notified, false) then coalesce(v.parent_notified_at, now()) end
  where id = p_id;
end $$;

-- The suggested categories for a Kenyan school, added when the office asks (Settings). Ones the school
-- already has (same name and kind) are left alone. Returns how many were added.
create or replace function add_default_behaviour_categories(p_tenant uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if not (has_perm(p_tenant, 'discipline') or auth.role() = 'service_role') then
    raise exception 'Only the office (the discipline area) sets up behaviour categories' using errcode = '42501';
  end if;
  insert into behaviour_categories (tenant_id, kind, name, points, severity, sort_order)
  select p_tenant, d.kind, d.name, d.points, d.severity, d.ord
    from (values
      ('merit', 'Helping others', 2, null, 1), ('merit', 'Leadership', 3, null, 2), ('merit', 'Academic effort', 2, null, 3),
      ('merit', 'Clean classroom duty', 1, null, 4), ('merit', 'Sportsmanship', 2, null, 5),
      ('demerit', 'Late to class', 1, 'minor', 11), ('demerit', 'Incomplete homework', 1, 'minor', 12),
      ('demerit', 'Uniform not proper', 1, 'minor', 13), ('demerit', 'Disrupting class', 2, 'minor', 14),
      ('demerit', 'Disrespect', 3, 'major', 15), ('demerit', 'Vandalism', 5, 'major', 16),
      ('demerit', 'Fighting', 5, 'serious', 17), ('demerit', 'Bullying', 10, 'serious', 18),
      ('demerit', 'Exam malpractice', 10, 'serious', 19)
    ) as d(kind, name, points, severity, ord)
   where not exists (select 1 from behaviour_categories c
                      where c.tenant_id = p_tenant and c.kind = d.kind and lower(btrim(c.name)) = lower(d.name));
  get diagnostics n = row_count;
  return n;
end $$;

-- ================================================================ points

-- The points period that holds p_on (packages/shared/src/behaviour.ts behaviourPeriod is the same rule):
--   never  no start, no end.
--   term   from the start of the latest term that started on or before p_on to the day before the next
--          term starts (the holiday after a term belongs to it). Before any term: from 1 January.
--   year   the school year of that term (terms.year; the calendar year when there is none): from its
--          first term's start (else 1 January) to the day before the next year's first term (else 31 Dec).
-- A null end means open-ended.
create or replace function behaviour_period(p_tenant uuid, p_reset text, p_on date)
returns table (starts date, ends date)
language sql stable security definer set search_path = public as $$
  with cur as (
    select t.year, t.starts_on from terms t
     where t.tenant_id = p_tenant and t.starts_on <= p_on
     order by t.starts_on desc limit 1
  ), y as (
    select coalesce((select year from cur), extract(year from p_on)::int) as y
  ), nxt as (
    select min(t.starts_on) as n from terms t where t.tenant_id = p_tenant and t.starts_on > p_on
  )
  select
    case p_reset
      when 'never' then null
      when 'term' then coalesce((select starts_on from cur), make_date((select y from y), 1, 1))
      else coalesce((select min(t.starts_on) from terms t where t.tenant_id = p_tenant and t.year = (select y from y)),
                    make_date((select y from y), 1, 1))
    end,
    case p_reset
      when 'never' then null
      when 'term' then (select n from nxt) - 1
      else coalesce((select min(t.starts_on) from terms t where t.tenant_id = p_tenant and t.year = (select y from y) + 1),
                    make_date((select y from y) + 1, 1, 1)) - 1
    end
$$;

-- Each learner's points in the period holding p_on (today in Nairobi by default), counting every entry
-- that isn't voided, whatever families may see of them: merit_points (the merits' sum), demerit_points
-- (the demerits' and incidents' sum, 0 or less) and balance as the school's mode counts it:
--   merits_only    0 + merits          demerits_only  starting_points + demerits      both  0 + merits + demerits
-- balance is null when the school has points turned off. Thresholds compare merit_points (a positive
-- threshold) or demerit_points (a negative one).
--
-- Whose: p_student_ids, or (null) every current learner at the caller's school, limited to those the
-- caller may see: the office ('discipline'), the learners a teacher teaches, a guardian's children, the
-- learner themself; and the server (seed and checks). Security definer, so a family's total counts the
-- demerits they are not shown.
create or replace function behaviour_points(p_student_ids uuid[] default null, p_on date default null)
returns table (student_id uuid, period_start date, period_end date, merit_points int, demerit_points int, balance int)
language sql stable security definer set search_path = public as $$
  with params as (
    select coalesce(p_on, (now() at time zone 'Africa/Nairobi')::date) as on_day,
           (auth.uid() is null and (auth.role() = 'service_role' or session_user in ('postgres', 'supabase_admin'))) as server
  ), allowed as (
    select s.id, s.tenant_id from students s, params
     where case when p_student_ids is null then s.tenant_id = my_tenant() and s.archived_at is null
                else s.id = any (p_student_ids) end
       and (params.server
            or is_super()
            or s.tenant_id in (select my_perm_tenant_ids('discipline'))
            or s.id in (select my_taught_student_ids())
            or (s.tenant_id = my_tenant()
                and (s.id in (select my_guardian_student_ids()) or s.profile_id = auth.uid())))
  ), cfg as (
    select a.id, a.tenant_id,
           coalesce(bs.points_enabled, true) as enabled,
           coalesce(bs.mode, 'both') as mode,
           coalesce(bs.starting_points, 100) as start_bal,
           coalesce(bs.reset, 'term') as reset
      from allowed a left join behaviour_settings bs on bs.tenant_id = a.tenant_id
  ), periods as (
    select c.*, p.starts, p.ends from cfg c, params, lateral behaviour_period(c.tenant_id, c.reset, params.on_day) p
  ), sums as (
    select pr.id,
           coalesce(sum(e.points) filter (where e.points > 0), 0)::int as merits,
           coalesce(sum(e.points) filter (where e.points < 0), 0)::int as demerits
      from periods pr cross join params
      left join behaviour_entries e
        on e.student_id = pr.id and e.voided_at is null and e.occurred_on <= params.on_day
       and (pr.starts is null or e.occurred_on >= pr.starts)
       and (pr.ends is null or e.occurred_on <= pr.ends)
     group by pr.id
  )
  select pr.id, pr.starts, pr.ends, s.merits, s.demerits,
         case when not pr.enabled then null
              when pr.mode = 'merits_only' then s.merits
              when pr.mode = 'demerits_only' then pr.start_bal + s.demerits
              else s.merits + s.demerits end
    from periods pr join sums s on s.id = pr.id
$$;

-- ================================================================ audit (20261104000000)

insert into audit_table_config (table_name, category, keep_values) values
  ('behaviour_settings', 'academic', true), ('behaviour_categories', 'academic', true),
  ('behaviour_entries', 'academic', true), ('behaviour_staff_notes', 'academic', false);

create trigger behaviour_settings_audit_ins after insert on behaviour_settings referencing new table as new_rows
  for each statement execute function audit_table_change('academic', 'true', 'tenant_id');
create trigger behaviour_settings_audit_upd after update on behaviour_settings referencing old table as old_rows new table as new_rows
  for each statement execute function audit_table_change('academic', 'true', 'tenant_id');
create trigger behaviour_categories_audit_ins after insert on behaviour_categories referencing new table as new_rows
  for each statement execute function audit_table_change('academic', 'true', 'id');
create trigger behaviour_categories_audit_upd after update on behaviour_categories referencing old table as old_rows new table as new_rows
  for each statement execute function audit_table_change('academic', 'true', 'id');
create trigger behaviour_entries_audit_ins after insert on behaviour_entries referencing new table as new_rows
  for each statement execute function audit_table_change('academic', 'true', 'id');
create trigger behaviour_entries_audit_upd after update on behaviour_entries referencing old table as old_rows new table as new_rows
  for each statement execute function audit_table_change('academic', 'true', 'id');
create trigger behaviour_staff_notes_audit_ins after insert on behaviour_staff_notes referencing new table as new_rows
  for each statement execute function audit_table_change('academic', 'false', 'entry_id');

-- ================================================================ grants

revoke execute on function behaviour_entry_prepare() from public, anon, authenticated;
revoke execute on function behaviour_entry_notify() from public, anon, authenticated;
revoke execute on function my_taught_student_ids() from public, anon;
revoke execute on function my_behaviour_family_kinds() from public, anon;
revoke execute on function record_behaviour(uuid[], text, uuid, int, text, text, date, uuid, text) from public, anon;
revoke execute on function void_behaviour_entry(uuid, text) from public, anon;
revoke execute on function set_behaviour_incident(uuid, text, text, boolean) from public, anon;
revoke execute on function add_default_behaviour_categories(uuid) from public, anon;
revoke execute on function behaviour_period(uuid, text, date) from public, anon;
revoke execute on function behaviour_points(uuid[], date) from public, anon;
grant execute on function my_taught_student_ids() to authenticated, service_role;
grant execute on function my_behaviour_family_kinds() to authenticated, service_role;
grant execute on function record_behaviour(uuid[], text, uuid, int, text, text, date, uuid, text) to authenticated, service_role;
grant execute on function void_behaviour_entry(uuid, text) to authenticated, service_role;
grant execute on function set_behaviour_incident(uuid, text, text, boolean) to authenticated, service_role;
grant execute on function add_default_behaviour_categories(uuid) to authenticated, service_role;
grant execute on function behaviour_period(uuid, text, date) to authenticated, service_role;
grant execute on function behaviour_points(uuid[], date) to authenticated, service_role;
