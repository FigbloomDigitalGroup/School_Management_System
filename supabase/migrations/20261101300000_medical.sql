-- The sick bay: what the medical area (20261031000000) is for.
--
-- A school nurse or matron (usually other staff, staff_title "Nurse" or
-- "Matron", given the medical area or the "Nurse / matron" preset; a
-- teacher can hold it too) keeps three records here:
--
--   sick_bay_visits        one visit to the sick bay: when the learner came
--                          in, the complaint, observations (temperature,
--                          pulse, anything else), the nurse's assessment and
--                          treatment, the outcome (back to class, resting in
--                          the sick bay, sent home, referred to hospital,
--                          admitted), when they left and a follow-up note.
--                          A visit with no time out is "in the sick bay
--                          now": the board.
--   visit_medications      medicine given at a visit: drug, dose, when. Can
--                          take its quantity off a Medical stock line in the
--                          inventory (see "stock" below). Never edited or
--                          deleted: a wrong entry is corrected by a note.
--   medication_schedules   prescribed medicine a learner takes at school
--                          (common for boarders): drug, dose, times of day,
--                          start and end date, who prescribed it.
--   medication_doses       one dose on the round: given, refused or missed,
--                          when, and who gave it. A dose not yet recorded has
--                          no row; the round list works out what is due from
--                          the schedules (packages/shared/src/medical.ts).
--   medication_requests    a guardian asking the nurse to give their child a
--                          prescribed medicine ("Amoxicillin 250mg 3x daily
--                          for 5 days"), with an optional photo of the
--                          prescription in private-documents
--                          (<tenant>/medical/<student>/...). The nurse
--                          approves it into a schedule, or declines it.
--   medical_notices        what a guardian is told about a visit, in the
--                          app (and pushed to their phone by the
--                          medical-notify function): written by the database
--                          when a visit's outcome is set, if the school's
--                          setting says so.
--   medical_settings       per school: tell guardians about every visit, or
--                          only serious outcomes (sent home, referred,
--                          admitted; the default).
--
-- Who sees what. This is health data about children, so:
--   * clinical details (every table above) are read only by has_perm(tenant,
--     'medical'): the medical area's holders and full admins (school_admin,
--     org admins, super admins), and by the learner's own guardians, for
--     their own child, through the guardians table directly. Not through
--     my_students(), which answers every learner to any teacher (is_staff()).
--     A teacher without the medical area reads none of it, and neither does
--     a learner (their family has it). is_staff() is not widened.
--   * a class teacher learns only that a learner is in the sick bay now, or
--     was sent home (or is away from class after the sick bay) today, from
--     sick_bay_class_status(): no complaint, no assessment, nothing else.
--   * opening one learner's medical record goes through medical_record(),
--     which writes who opened it and when to the school's audit trail
--     ('access', the learner's id and name only, never a clinical detail).
--     Lists (the board, the round, the reports) are not logged one row at a
--     time; the record a nurse opens is.
--   * the health record itself (student_health, 20261025050000) keeps its
--     own rules: the medical area already reads it (20261031000001).
--
-- Writes: the medical area writes visits, medicines given, schedules and
-- doses. Approving or declining a guardian's request, marking a sent-home
-- learner in that day's register, and marking notices read go through the
-- functions below, which check the area and the learner's school
-- themselves. Nothing here is deleted from the app: these are records of
-- care.
--
-- Attendance: sending a learner home (or to hospital, or admitting them)
-- doesn't change the register by itself. The nurse marks the learner
-- excused (or absent) for that day with medical_mark_attendance(), a clear
-- button on the visit, which writes the existing attendance mark with a
-- note "Sick bay: sent home". The medical area doesn't need the
-- attendance area for this one learner-day.
--
-- Stock: a visit medication can name a stock line in the Medical inventory
-- category (added to inventory_items in 20261101300001) and a quantity;
-- the trigger takes it off the line's quantity under a row lock, refusing
-- more than is left. The nurse picks from medical_stock(), since the
-- medical area doesn't read the whole inventory.

-- ---------------------------------------------------------------- settings
create table medical_settings (
  tenant_id        uuid primary key references tenants on delete cascade,
  -- 'serious': only sent home, referred to hospital or admitted; 'all': every visit
  notify_guardians text not null default 'serious' check (notify_guardians in ('all', 'serious')),
  updated_by       uuid references profiles on delete set null default auth.uid(),
  updated_at       timestamptz not null default now()
);

alter table medical_settings enable row level security;
-- anyone at the school may know the rule (a parent wonders why they weren't told); the medical area sets it
create policy medical_settings_read on medical_settings for select
  using (tenant_id = my_tenant() or has_perm(tenant_id, 'medical'));
create policy medical_settings_write on medical_settings for all
  using (has_perm(tenant_id, 'medical')) with check (has_perm(tenant_id, 'medical'));

-- The guardian rule, the same as notifiesGuardians() in packages/shared/src/medical.ts.
create or replace function medical_outcome_notifies(p_policy text, p_outcome text) returns boolean
language sql immutable as $$
  select p_outcome is not null
     and (coalesce(p_policy, 'serious') = 'all' or p_outcome in ('home', 'hospital', 'admitted'))
$$;

-- Whether this person is a guardian of this learner. Not my_students(),
-- which answers every learner to a teacher.
create or replace function is_guardian_of(p_student_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from guardians g where g.student_id = p_student_id and g.profile_id = auth.uid())
$$;

-- ---------------------------------------------------------------- visits
create table sick_bay_visits (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants on delete cascade,
  student_id           uuid not null references students on delete cascade,
  time_in              timestamptz not null default now(),
  complaint            text not null check (char_length(trim(complaint)) between 1 and 300),
  -- degrees Celsius
  temperature_c        numeric(4, 1) check (temperature_c is null or temperature_c between 30 and 45),
  pulse_bpm            int check (pulse_bpm is null or pulse_bpm between 20 and 250),
  -- anything else seen or measured: "BP 110/70, pale, vomited once"
  observations         text check (observations is null or char_length(observations) <= 2000),
  assessment           text check (assessment is null or char_length(assessment) <= 2000),
  treatment            text check (treatment is null or char_length(treatment) <= 2000),
  -- null while the nurse is still seeing them
  outcome              text check (outcome is null or outcome in ('class', 'rest', 'home', 'hospital', 'admitted')),
  -- the hospital or clinic they were referred to or admitted at
  referred_to          text check (referred_to is null or char_length(referred_to) <= 200),
  -- null: still in the sick bay
  time_out             timestamptz,
  follow_up            text check (follow_up is null or char_length(follow_up) <= 2000),
  -- set by medical_mark_attendance()
  attendance_mark      attendance_mark,
  attendance_marked_at timestamptz,
  logged_by            uuid references profiles on delete set null default auth.uid(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (time_out is null or time_out >= time_in)
);
create index on sick_bay_visits (tenant_id, time_in desc);
create index on sick_bay_visits (student_id, time_in desc);
create index sick_bay_visits_open on sick_bay_visits (tenant_id) where time_out is null;

create table visit_medications (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants on delete cascade,
  visit_id          uuid not null references sick_bay_visits on delete cascade,
  drug              text not null check (char_length(trim(drug)) between 1 and 120),
  dose              text not null check (char_length(trim(dose)) between 1 and 120),
  given_at          timestamptz not null default now(),
  given_by          uuid references profiles on delete set null default auth.uid(),
  -- a Medical stock line this came out of, and how many units
  inventory_item_id uuid references inventory_items on delete set null,
  stock_quantity    int check (stock_quantity is null or stock_quantity between 1 and 1000),
  created_at        timestamptz not null default now(),
  check ((inventory_item_id is null) = (stock_quantity is null))
);
create index on visit_medications (visit_id);
create index on visit_medications (tenant_id, given_at desc);

alter table sick_bay_visits enable row level security;
alter table visit_medications enable row level security;

create policy sick_bay_visits_read on sick_bay_visits for select
  using (has_perm(tenant_id, 'medical') or is_guardian_of(student_id));
create policy sick_bay_visits_insert on sick_bay_visits for insert
  with check (has_perm(tenant_id, 'medical'));
create policy sick_bay_visits_update on sick_bay_visits for update
  using (has_perm(tenant_id, 'medical')) with check (has_perm(tenant_id, 'medical'));

create policy visit_medications_read on visit_medications for select
  using (has_perm(tenant_id, 'medical')
         or exists (select 1 from sick_bay_visits v where v.id = visit_medications.visit_id and is_guardian_of(v.student_id)));
create policy visit_medications_insert on visit_medications for insert
  with check (has_perm(tenant_id, 'medical'));

create trigger sick_bay_visits_student_tenant before insert or update of tenant_id, student_id on sick_bay_visits
  for each row execute function enforce_student_tenant();

-- Tidy text, stamp the change, keep a visit on its learner, and keep the
-- attendance stamps for medical_mark_attendance() alone.
create or replace function sick_bay_visits_stamp() returns trigger
language plpgsql set search_path = public as $$
begin
  if TG_OP = 'UPDATE' then
    if NEW.student_id <> OLD.student_id or NEW.tenant_id <> OLD.tenant_id then
      raise exception 'A visit cannot be moved to another learner' using errcode = '42501';
    end if;
    if (NEW.attendance_mark, NEW.attendance_marked_at) is distinct from (OLD.attendance_mark, OLD.attendance_marked_at)
       and current_setting('figbloom.medical_attendance', true) is distinct from 'on' then
      raise exception 'Use "Mark in the register" to change attendance' using errcode = '42501';
    end if;
  elsif NEW.attendance_mark is not null or NEW.attendance_marked_at is not null then
    raise exception 'Use "Mark in the register" to change attendance' using errcode = '42501';
  end if;
  NEW.complaint := trim(NEW.complaint);
  NEW.observations := nullif(trim(coalesce(NEW.observations, '')), '');
  NEW.assessment := nullif(trim(coalesce(NEW.assessment, '')), '');
  NEW.treatment := nullif(trim(coalesce(NEW.treatment, '')), '');
  NEW.referred_to := nullif(trim(coalesce(NEW.referred_to, '')), '');
  NEW.follow_up := nullif(trim(coalesce(NEW.follow_up, '')), '');
  NEW.updated_at := now();
  return NEW;
end;
$$;

create trigger sick_bay_visits_stamp before insert or update on sick_bay_visits
  for each row execute function sick_bay_visits_stamp();

-- A medicine given belongs to its visit's school, and a stock line it names
-- loses that many units, under a lock so two nurses can't both take the last.
create or replace function visit_medications_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_visit sick_bay_visits%rowtype;
  v_item  inventory_items%rowtype;
begin
  select * into v_visit from sick_bay_visits where id = NEW.visit_id;
  if v_visit.id is null or v_visit.tenant_id <> NEW.tenant_id then
    raise exception 'That visit does not belong to this school.' using errcode = '42501';
  end if;
  NEW.drug := trim(NEW.drug);
  NEW.dose := trim(NEW.dose);
  NEW.given_by := coalesce(auth.uid(), NEW.given_by);
  if NEW.inventory_item_id is not null then
    select * into v_item from inventory_items where id = NEW.inventory_item_id for update;
    if v_item.id is null or v_item.tenant_id <> NEW.tenant_id or v_item.category <> 'medical'
       or v_item.tracking <> 'stock' or v_item.retired_at is not null then
      raise exception 'Pick a Medical stock line from this school''s inventory.' using errcode = '22023';
    end if;
    if v_item.quantity < NEW.stock_quantity then
      raise exception 'Only % of % left in stock.', v_item.quantity, v_item.name using errcode = '23514';
    end if;
    update inventory_items set quantity = quantity - NEW.stock_quantity where id = v_item.id;
  end if;
  return NEW;
end;
$$;

create trigger visit_medications_stamp before insert on visit_medications
  for each row execute function visit_medications_stamp();

-- The school's Medical stock lines with what's left: the nurse's picker.
create or replace function medical_stock(p_tenant_id uuid) returns table(id uuid, name text, quantity int)
language sql stable security definer set search_path = public as $$
  select i.id, i.name, i.quantity
    from inventory_items i
   where i.tenant_id = p_tenant_id
     and i.category = 'medical' and i.tracking = 'stock' and i.retired_at is null
     and has_perm(p_tenant_id, 'medical')
   order by i.name
$$;

-- ---------------------------------------------------------------- guardians told
create table medical_notices (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants on delete cascade,
  student_id  uuid not null references students on delete cascade,
  -- the guardian told
  profile_id  uuid not null references profiles on delete cascade,
  visit_id    uuid not null references sick_bay_visits on delete cascade,
  outcome     text not null,
  title       text not null,
  body        text not null,
  created_at  timestamptz not null default now(),
  read_at     timestamptz,
  -- claimed by medical-notify before it sends, so a visit is pushed once
  pushed_at   timestamptz,
  -- one notice per guardian per outcome: "rest" then "sent home" is two
  unique (visit_id, profile_id, outcome)
);
create index on medical_notices (profile_id, created_at desc);

alter table medical_notices enable row level security;
-- your own notices, and the medical area sees who was told; written only by the trigger below
create policy medical_notices_read on medical_notices for select
  using (profile_id = auth.uid() or has_perm(tenant_id, 'medical'));

-- When a visit's outcome is set (or changes), each guardian is told, if the
-- school's setting covers that outcome. In-app here; medical-notify pushes.
create or replace function sick_bay_visits_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_policy text;
  v_first  text;
  v_what   text;
begin
  if NEW.outcome is null or (TG_OP = 'UPDATE' and NEW.outcome is not distinct from OLD.outcome) then
    return NEW;
  end if;
  select notify_guardians into v_policy from medical_settings where tenant_id = NEW.tenant_id;
  if not medical_outcome_notifies(v_policy, NEW.outcome) then
    return NEW;
  end if;
  select coalesce(nullif(split_part(trim(full_name), ' ', 1), ''), 'Your child') into v_first from students where id = NEW.student_id;
  v_what := case NEW.outcome
    when 'class' then 'went back to class'
    when 'rest' then 'is resting in the sick bay'
    when 'home' then 'is being sent home. Please arrange to collect them'
    when 'hospital' then 'has been referred to ' || coalesce(NEW.referred_to, 'hospital')
    when 'admitted' then 'has been admitted' || coalesce(' at ' || NEW.referred_to, '')
  end;
  insert into medical_notices (tenant_id, student_id, profile_id, visit_id, outcome, title, body)
  select NEW.tenant_id, NEW.student_id, g.profile_id, NEW.id, NEW.outcome,
         format('%s visited the sick bay', v_first),
         format('%s was seen by the school nurse at %s and %s. Open Health for the details.',
                v_first, to_char(NEW.time_in at time zone 'Africa/Nairobi', 'HH24:MI'), v_what)
    from guardians g
   where g.student_id = NEW.student_id and g.tenant_id = NEW.tenant_id
  on conflict (visit_id, profile_id, outcome) do nothing;
  return NEW;
end;
$$;

create trigger sick_bay_visits_notify after insert or update of outcome on sick_bay_visits
  for each row execute function sick_bay_visits_notify();

-- A guardian marks their notices about one child read.
create or replace function mark_medical_notices_read(p_student_id uuid) returns void
language sql security definer set search_path = public as $$
  update medical_notices set read_at = now()
   where profile_id = auth.uid() and student_id = p_student_id and read_at is null
$$;

-- ---------------------------------------------------------------- medication
create or replace function medication_times_valid(p_times text[]) returns boolean
language sql immutable as $$
  select cardinality(p_times) between 1 and 8
     and coalesce(bool_and(t ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'), false)
    from unnest(p_times) t
$$;

create table medication_schedules (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants on delete cascade,
  student_id    uuid not null references students on delete cascade,
  drug          text not null check (char_length(trim(drug)) between 1 and 120),
  dose          text not null check (char_length(trim(dose)) between 1 and 120),
  -- school clock, 'HH:MM', sorted
  times         text[] not null check (medication_times_valid(times)),
  starts_on     date not null,
  -- null: until stopped
  ends_on       date,
  prescribed_by text not null default 'doctor' check (prescribed_by in ('doctor', 'parent')),
  -- the doctor or clinic, or the parent's name
  prescriber    text check (prescriber is null or char_length(prescriber) <= 120),
  notes         text check (notes is null or char_length(notes) <= 1000),
  -- stopped early (a course changed): kept for its doses
  stopped_at    timestamptz,
  created_by    uuid references profiles on delete set null default auth.uid(),
  created_at    timestamptz not null default now(),
  check (ends_on is null or ends_on >= starts_on)
);
create index on medication_schedules (tenant_id, starts_on);
create index on medication_schedules (student_id);

create table medication_doses (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants on delete cascade,
  schedule_id uuid not null references medication_schedules on delete cascade,
  student_id  uuid not null references students on delete cascade,
  due_on      date not null,
  due_time    text not null,
  status      text not null check (status in ('given', 'refused', 'missed')),
  recorded_at timestamptz not null default now(),
  given_by    uuid references profiles on delete set null default auth.uid(),
  note        text check (note is null or char_length(note) <= 500),
  unique (schedule_id, due_on, due_time)
);
create index on medication_doses (tenant_id, due_on);
create index on medication_doses (student_id, due_on desc);

alter table medication_schedules enable row level security;
alter table medication_doses enable row level security;

create policy medication_schedules_read on medication_schedules for select
  using (has_perm(tenant_id, 'medical') or is_guardian_of(student_id));
create policy medication_schedules_insert on medication_schedules for insert
  with check (has_perm(tenant_id, 'medical'));
create policy medication_schedules_update on medication_schedules for update
  using (has_perm(tenant_id, 'medical')) with check (has_perm(tenant_id, 'medical'));

create policy medication_doses_read on medication_doses for select
  using (has_perm(tenant_id, 'medical') or is_guardian_of(student_id));
create policy medication_doses_insert on medication_doses for insert
  with check (has_perm(tenant_id, 'medical'));
create policy medication_doses_update on medication_doses for update
  using (has_perm(tenant_id, 'medical')) with check (has_perm(tenant_id, 'medical'));

create trigger medication_schedules_student_tenant before insert or update of tenant_id, student_id on medication_schedules
  for each row execute function enforce_student_tenant();

create or replace function medication_schedules_stamp() returns trigger
language plpgsql set search_path = public as $$
begin
  if TG_OP = 'UPDATE' and (NEW.student_id <> OLD.student_id or NEW.tenant_id <> OLD.tenant_id) then
    raise exception 'A schedule cannot be moved to another learner' using errcode = '42501';
  end if;
  NEW.drug := trim(NEW.drug);
  NEW.dose := trim(NEW.dose);
  NEW.times := (select array_agg(distinct t order by t) from unnest(NEW.times) t);
  NEW.prescriber := nullif(trim(coalesce(NEW.prescriber, '')), '');
  NEW.notes := nullif(trim(coalesce(NEW.notes, '')), '');
  return NEW;
end;
$$;

create trigger medication_schedules_stamp before insert or update on medication_schedules
  for each row execute function medication_schedules_stamp();

-- A dose is one of its schedule's slots: the learner and school come from
-- the schedule, the time is one of its times, the day inside its dates.
create or replace function medication_doses_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_s medication_schedules%rowtype;
begin
  select * into v_s from medication_schedules where id = NEW.schedule_id;
  if v_s.id is null or v_s.tenant_id <> NEW.tenant_id then
    raise exception 'That schedule does not belong to this school.' using errcode = '42501';
  end if;
  if not (NEW.due_time = any (v_s.times)) or NEW.due_on < v_s.starts_on
     or (v_s.ends_on is not null and NEW.due_on > v_s.ends_on) then
    raise exception 'That dose is not on % for %.', v_s.drug, NEW.due_on using errcode = '22023';
  end if;
  NEW.student_id := v_s.student_id;
  NEW.note := nullif(trim(coalesce(NEW.note, '')), '');
  NEW.recorded_at := now();
  NEW.given_by := coalesce(auth.uid(), NEW.given_by);
  return NEW;
end;
$$;

create trigger medication_doses_stamp before insert or update on medication_doses
  for each row execute function medication_doses_stamp();

-- ---------------------------------------------------------------- guardians' requests
create table medication_requests (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants on delete cascade,
  student_id        uuid not null references students on delete cascade,
  requested_by      uuid not null references profiles on delete cascade default auth.uid(),
  drug              text not null check (char_length(trim(drug)) between 1 and 120),
  dose              text not null check (char_length(trim(dose)) between 1 and 120),
  times_per_day     int not null check (times_per_day between 1 and 8),
  starts_on         date not null,
  ends_on           date,
  instructions      text check (instructions is null or char_length(instructions) <= 1000),
  prescriber        text check (prescriber is null or char_length(prescriber) <= 120),
  -- private-documents: <tenant>/medical/<student>/<file>
  prescription_path text check (prescription_path is null or char_length(prescription_path) <= 500),
  status            text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'withdrawn')),
  decided_by        uuid references profiles on delete set null,
  decided_at        timestamptz,
  decision_note     text check (decision_note is null or char_length(decision_note) <= 500),
  schedule_id       uuid references medication_schedules on delete set null,
  created_at        timestamptz not null default now(),
  check (ends_on is null or ends_on >= starts_on)
);
create index on medication_requests (tenant_id, status, created_at desc);
create index on medication_requests (student_id);

alter table medication_requests enable row level security;

create policy medication_requests_read on medication_requests for select
  using (has_perm(tenant_id, 'medical') or is_guardian_of(student_id));
-- a guardian asks for their own child, as themselves, pending, with a photo
-- (if any) in that child's own medical folder
create policy medication_requests_guardian_insert on medication_requests for insert
  with check (is_guardian_of(student_id) and requested_by = auth.uid() and status = 'pending'
              and decided_by is null and decided_at is null and schedule_id is null
              and (prescription_path is null
                   or prescription_path like tenant_id::text || '/medical/' || student_id::text || '/%'));
-- and withdraws it while it's still pending; nothing else changes from the app
create policy medication_requests_guardian_withdraw on medication_requests for update
  using (requested_by = auth.uid() and status = 'pending')
  with check (requested_by = auth.uid() and status = 'withdrawn');

create trigger medication_requests_student_tenant before insert or update of tenant_id, student_id on medication_requests
  for each row execute function enforce_student_tenant();

-- A withdrawal changes the status and nothing else.
create or replace function medication_requests_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if TG_OP = 'INSERT' then
    NEW.drug := trim(NEW.drug);
    NEW.dose := trim(NEW.dose);
    NEW.instructions := nullif(trim(coalesce(NEW.instructions, '')), '');
    NEW.prescriber := nullif(trim(coalesce(NEW.prescriber, '')), '');
    return NEW;
  end if;
  if current_setting('figbloom.medical_decision', true) is distinct from 'on'
     and (NEW.tenant_id, NEW.student_id, NEW.requested_by, NEW.drug, NEW.dose, NEW.times_per_day, NEW.starts_on,
          NEW.ends_on, NEW.instructions, NEW.prescriber, NEW.prescription_path, NEW.decided_by, NEW.decided_at,
          NEW.decision_note, NEW.schedule_id, NEW.created_at)
         is distinct from
         (OLD.tenant_id, OLD.student_id, OLD.requested_by, OLD.drug, OLD.dose, OLD.times_per_day, OLD.starts_on,
          OLD.ends_on, OLD.instructions, OLD.prescriber, OLD.prescription_path, OLD.decided_by, OLD.decided_at,
          OLD.decision_note, OLD.schedule_id, OLD.created_at) then
    raise exception 'A request can only be withdrawn' using errcode = '42501';
  end if;
  return NEW;
end;
$$;

create trigger medication_requests_guard before insert or update on medication_requests
  for each row execute function medication_requests_guard();

-- Approves a pending request into a schedule (the nurse sets the times and
-- may correct the drug, dose and dates from the prescription) and returns
-- the schedule's id.
create or replace function approve_medication_request(
  p_request_id uuid, p_drug text, p_dose text, p_times text[], p_starts_on date, p_ends_on date, p_notes text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_req medication_requests%rowtype;
  v_id  uuid;
begin
  select * into v_req from medication_requests where id = p_request_id for update;
  if v_req.id is null or not has_perm(v_req.tenant_id, 'medical') then
    raise exception 'Only the school''s nurse can approve a medication request.' using errcode = '42501';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'That request has already been %.', v_req.status using errcode = '22023';
  end if;
  insert into medication_schedules (tenant_id, student_id, drug, dose, times, starts_on, ends_on, prescribed_by, prescriber, notes)
  values (v_req.tenant_id, v_req.student_id, coalesce(nullif(trim(p_drug), ''), v_req.drug), coalesce(nullif(trim(p_dose), ''), v_req.dose),
          p_times, coalesce(p_starts_on, v_req.starts_on), p_ends_on,
          case when v_req.prescriber is null then 'parent' else 'doctor' end, v_req.prescriber,
          coalesce(nullif(trim(p_notes), ''), v_req.instructions))
  returning id into v_id;
  perform set_config('figbloom.medical_decision', 'on', true);
  update medication_requests
     set status = 'approved', decided_by = auth.uid(), decided_at = now(), schedule_id = v_id
   where id = v_req.id;
  perform set_config('figbloom.medical_decision', 'off', true);
  return v_id;
end $$;

create or replace function decline_medication_request(p_request_id uuid, p_note text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_req medication_requests%rowtype;
begin
  select * into v_req from medication_requests where id = p_request_id for update;
  if v_req.id is null or not has_perm(v_req.tenant_id, 'medical') then
    raise exception 'Only the school''s nurse can decline a medication request.' using errcode = '42501';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'That request has already been %.', v_req.status using errcode = '22023';
  end if;
  perform set_config('figbloom.medical_decision', 'on', true);
  update medication_requests
     set status = 'declined', decided_by = auth.uid(), decided_at = now(), decision_note = nullif(trim(coalesce(p_note, '')), '')
   where id = v_req.id;
  perform set_config('figbloom.medical_decision', 'off', true);
end $$;

-- ---------------------------------------------------------------- attendance
-- Marks a learner who left the sick bay for home, hospital or admission as
-- excused (or absent) in that day's register, with a note saying why, and
-- stamps the visit. The nurse presses this; it never happens by itself.
create or replace function medical_mark_attendance(p_visit_id uuid, p_mark attendance_mark) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_visit sick_bay_visits%rowtype;
  v_class uuid;
  v_term  uuid;
  v_day   date;
  v_note  text;
begin
  select * into v_visit from sick_bay_visits where id = p_visit_id for update;
  if v_visit.id is null or not has_perm(v_visit.tenant_id, 'medical') then
    raise exception 'Only the school''s nurse can do this.' using errcode = '42501';
  end if;
  if v_visit.outcome is null or v_visit.outcome not in ('home', 'hospital', 'admitted') then
    raise exception 'Only a learner sent home, referred to hospital or admitted is marked from the sick bay.' using errcode = '22023';
  end if;
  if p_mark not in ('excused', 'absent') then
    raise exception 'Mark them excused or absent.' using errcode = '22023';
  end if;
  v_day := (coalesce(v_visit.time_out, v_visit.time_in) at time zone 'Africa/Nairobi')::date;
  select class_id into v_class from students where id = v_visit.student_id;
  if v_class is null then
    raise exception 'This learner is not in a class.' using errcode = '22023';
  end if;
  select id into v_term from terms
   where tenant_id = v_visit.tenant_id and v_day between starts_on and ends_on
   order by is_current desc limit 1;
  if v_term is null then
    raise exception 'No term at this school covers %.', v_day using errcode = '22023';
  end if;
  v_note := 'Sick bay: ' || case v_visit.outcome when 'home' then 'sent home' when 'hospital' then 'referred to hospital' else 'admitted' end;

  insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark, note)
  values (v_visit.tenant_id, v_visit.student_id, v_class, v_term, auth.uid(), v_day, p_mark, v_note)
  on conflict (student_id, taken_on) do update set mark = excluded.mark, note = excluded.note, taken_by = excluded.taken_by;

  perform set_config('figbloom.medical_attendance', 'on', true);
  update sick_bay_visits set attendance_mark = p_mark, attendance_marked_at = now() where id = v_visit.id;
  perform set_config('figbloom.medical_attendance', 'off', true);
end $$;

-- ---------------------------------------------------------------- teachers
-- What a class teacher (or anyone teaching the class, or holding the
-- attendance or medical area) may know: who in the class is in the sick bay
-- now ('in_sick_bay'), was sent home today ('sent_home'), or left the sick
-- bay for hospital or admission today ('away'). Nothing clinical.
create or replace function sick_bay_class_status(p_class_id uuid) returns table(student_id uuid, status text)
language sql stable security definer set search_path = public as $$
  select distinct on (v.student_id) v.student_id,
         case when v.time_out is null then 'in_sick_bay' when v.outcome = 'home' then 'sent_home' else 'away' end
    from classes c
    join students s on s.class_id = c.id and s.tenant_id = c.tenant_id
    join sick_bay_visits v on v.student_id = s.id and v.tenant_id = c.tenant_id
   where c.id = p_class_id
     and c.tenant_id = my_tenant()
     and (c.class_teacher_id = auth.uid()
          or exists (select 1 from teaching_assignments ta where ta.class_id = c.id and ta.teacher_id = auth.uid())
          or has_perm(c.tenant_id, 'attendance') or has_perm(c.tenant_id, 'medical'))
     and (v.time_out is null
          or (v.outcome in ('home', 'hospital', 'admitted')
              and (v.time_out at time zone 'Africa/Nairobi')::date = (now() at time zone 'Africa/Nairobi')::date))
   order by v.student_id, (v.time_out is null) desc, v.time_in desc
$$;

-- ---------------------------------------------------------------- opening a record
-- One learner's medical record for the nurse: the health record, their
-- visits with medicines given, schedules and the last 60 days of doses, and
-- requests. Writes who opened it to the audit trail (at most once per
-- person per learner in ten minutes, so a screen refreshing doesn't flood
-- it). Learner and name only in the trail: never a clinical detail.
create or replace function medical_record(p_student_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_student students%rowtype;
  v_out     jsonb;
begin
  select * into v_student from students where id = p_student_id;
  if v_student.id is null or not has_perm(v_student.tenant_id, 'medical') then
    raise exception 'Only the school''s nurse can open a medical record.' using errcode = '42501';
  end if;

  if not exists (
    select 1 from audit_events
     where tenant_id = v_student.tenant_id and actor_id = auth.uid() and category = 'access'
       and metadata ->> 'medical_record' = p_student_id::text
       and created_at > now() - interval '10 minutes'
  ) then
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    values (v_student.tenant_id, auth.uid(), my_actor_label(),
            format('Medical record opened: %s (%s)', v_student.full_name, v_student.admission_no),
            'access', jsonb_build_object('medical_record', p_student_id, 'student_id', p_student_id));
  end if;

  select jsonb_build_object(
    'health', (select to_jsonb(h) from student_health h where h.student_id = p_student_id),
    'visits', coalesce((
      select jsonb_agg(to_jsonb(v) || jsonb_build_object('medications', coalesce((
               select jsonb_agg(to_jsonb(m) order by m.given_at) from visit_medications m where m.visit_id = v.id), '[]'::jsonb))
             order by v.time_in desc)
        from sick_bay_visits v where v.student_id = p_student_id), '[]'::jsonb),
    'schedules', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.starts_on desc) from medication_schedules s where s.student_id = p_student_id), '[]'::jsonb),
    'doses', coalesce((
      select jsonb_agg(to_jsonb(d) order by d.due_on desc, d.due_time desc) from medication_doses d
       where d.student_id = p_student_id and d.due_on > current_date - 60), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.created_at desc) from medication_requests r where r.student_id = p_student_id), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;

revoke execute on function medical_stock(uuid), mark_medical_notices_read(uuid),
                           approve_medication_request(uuid, text, text, text[], date, date, text),
                           decline_medication_request(uuid, text), medical_mark_attendance(uuid, attendance_mark),
                           sick_bay_class_status(uuid), medical_record(uuid), is_guardian_of(uuid)
  from public, anon;
grant execute on function medical_stock(uuid), mark_medical_notices_read(uuid),
                          approve_medication_request(uuid, text, text, text[], date, date, text),
                          decline_medication_request(uuid, text), medical_mark_attendance(uuid, attendance_mark),
                          sick_bay_class_status(uuid), medical_record(uuid), is_guardian_of(uuid)
  to authenticated;
