-- A parent's or guardian's consent before a school keeps a learner's health
-- details (student_health, 20261025050000).
--
-- Health details are optional. A school asks for them to know which
-- activities a learner can take part in, what they can eat, and what to do in
-- an emergency. Under the Data Protection Act, 2019 (s.33, a child's data;
-- s.44-46, health data) that needs a parent's or guardian's consent, and a
-- family that says no is treated no differently. Until now nothing recorded
-- consent: an admin, the CSV import or a parent could save details freely.
--
--   health_consents     one row per learner: 'given' or 'withdrawn', how
--                       ('app': a guardian agreed in their app; 'paper': the
--                       office recorded a signed form), which guardian agreed
--                       in the app, who recorded it, the name of whoever
--                       signed the form and the date on it
--   health_consent_log  every change, append-only
--
-- What consent covers: allergies, medical conditions, medication, blood
-- group, diet, support needs and notes (HEALTH_FIELDS below). The family
-- doctor and the emergency contact are contact details, not health details,
-- and stay outside it.
--
-- The rule (student_health_consent trigger): health details can be added or
-- changed only while consent is 'given'. Without it they can only be removed
-- (a field emptied, or items taken out of a list), so a family or the office
-- can always clear them. This applies to every writer, the API and service
-- role alike.
--
-- Withdrawing (set_health_consent with p_give false) clears the health
-- fields in the same transaction and keeps the doctor and emergency contact.
-- The log keeps who decided and when, never the details themselves.
--
-- Details saved before this migration have no consent row. They stay, and
-- staff still see them; the office sees "consent not recorded", and the
-- learner's guardians are asked to agree or remove them
-- (my_health_consent_requests) the next time they open their app.
--
-- Who decides: either guardian of the learner, in their app ('app'); or the
-- office's people area from a signed form ('paper', naming who signed it and
-- the date on it). The office can also withdraw on a parent's request,
-- naming who asked. Reading the consent: the learner's guardians, and the
-- people and medical areas.
--
-- Recreated: nothing. student_health's policies and stamp trigger stay as
-- they are.

-- ---------------------------------------------------------------- tables
create table health_consents (
  student_id  uuid primary key references students on delete cascade,
  tenant_id   uuid not null references tenants on delete cascade,
  status      text not null check (status in ('given', 'withdrawn')),
  method      text not null check (method in ('app', 'paper')),
  -- the guardian who decided in their app; null for a paper form
  guardian_id uuid references profiles on delete set null,
  -- who pressed the button: the guardian, or the office for a paper form
  recorded_by uuid references profiles on delete set null,
  -- paper only: who signed the form (or asked to withdraw), and the form's date
  signed_by   text check (signed_by is null or char_length(signed_by) between 1 and 120),
  form_date   date,
  changed_at  timestamptz not null default now(),
  constraint health_consents_paper_named check (method = 'app' or signed_by is not null)
);
create index on health_consents (tenant_id);

create table health_consent_log (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants on delete cascade,
  student_id  uuid not null references students on delete cascade,
  status      text not null check (status in ('given', 'withdrawn')),
  method      text not null check (method in ('app', 'paper')),
  guardian_id uuid references profiles on delete set null,
  recorded_by uuid references profiles on delete set null,
  signed_by   text,
  form_date   date,
  -- the wall clock, not the transaction's start, so changes keep their order
  changed_at  timestamptz not null default clock_timestamp()
);
create index on health_consent_log (student_id, changed_at desc);
create index on health_consent_log (tenant_id);

alter table health_consents enable row level security;
alter table health_consent_log enable row level security;

-- No write policies: set_health_consent() is the only way in.
create policy health_consents_read on health_consents for select
  using (has_perm(tenant_id, 'people') or has_perm(tenant_id, 'medical')
         or exists (select 1 from guardians g where g.student_id = health_consents.student_id and g.profile_id = auth.uid()));
create policy health_consent_log_read on health_consent_log for select
  using (has_perm(tenant_id, 'people') or has_perm(tenant_id, 'medical')
         or exists (select 1 from guardians g where g.student_id = health_consent_log.student_id and g.profile_id = auth.uid()));

-- ---------------------------------------------------------------- the rule
create or replace function health_consent_given(p_student_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from health_consents where student_id = p_student_id and status = 'given')
$$;
revoke execute on function health_consent_given(uuid) from public, anon;
grant execute on function health_consent_given(uuid) to authenticated, service_role;

-- Whether a student_health row holds any health details (HEALTH_FIELDS).
create or replace function student_health_has_details(h student_health) returns boolean
language sql immutable as $$
  select cardinality(h.allergies) > 0 or cardinality(h.medical_conditions) > 0
      or nullif(trim(h.medications), '') is not null or h.blood_group is not null
      or nullif(trim(h.dietary_needs), '') is not null or nullif(trim(h.special_needs), '') is not null
      or nullif(trim(h.notes), '') is not null
$$;

-- Without consent, health details may only be removed: on insert there must
-- be none, and on update each field must be unchanged, emptied, or (for the
-- lists) have items taken out.
create or replace function student_health_consent() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_only_removed boolean;
begin
  if health_consent_given(NEW.student_id) then return NEW; end if;
  if TG_OP = 'INSERT' then
    v_only_removed := not student_health_has_details(NEW);
  else
    v_only_removed :=
          NEW.allergies <@ OLD.allergies
      and NEW.medical_conditions <@ OLD.medical_conditions
      and (NEW.medications is not distinct from OLD.medications or nullif(trim(NEW.medications), '') is null)
      and (NEW.blood_group is not distinct from OLD.blood_group or NEW.blood_group is null)
      and (NEW.dietary_needs is not distinct from OLD.dietary_needs or nullif(trim(NEW.dietary_needs), '') is null)
      and (NEW.special_needs is not distinct from OLD.special_needs or nullif(trim(NEW.special_needs), '') is null)
      and (NEW.notes is not distinct from OLD.notes or nullif(trim(NEW.notes), '') is null);
  end if;
  if not v_only_removed then
    raise exception 'A parent or guardian needs to agree before the school keeps health details for this learner.'
      using errcode = '42501';
  end if;
  return NEW;
end $$;

-- Named to sort before student_health_stamp, so it sees the values as written.
create trigger student_health_consent before insert or update on student_health
  for each row execute function student_health_consent();

-- ---------------------------------------------------------------- deciding
-- Give or withdraw consent for one learner. Answers the new status.
--   a guardian of the learner: in their app; p_signed_by and p_form_date are
--     ignored
--   the people area: from a paper form. Giving needs who signed it and the
--     date on it (not in the future); withdrawing needs who asked.
-- Withdrawing clears the health fields (not the doctor or emergency contact).
-- Repeating the current decision changes nothing and logs nothing.
create or replace function set_health_consent(
  p_student_id uuid, p_give boolean, p_signed_by text default null, p_form_date date default null
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_student  students;
  v_guardian boolean;
  v_method   text;
  v_status   text := case when p_give then 'given' else 'withdrawn' end;
  v_signed   text := nullif(left(trim(coalesce(p_signed_by, '')), 120), '');
  v_form     date := p_form_date;
  c          health_consents;
begin
  select * into v_student from students where id = p_student_id;
  if v_student.id is null or v_student.tenant_id is distinct from my_tenant() then
    raise exception 'That learner could not be found.' using errcode = '42501';
  end if;
  if p_give is null then
    raise exception 'Choose whether to give or withdraw consent.' using errcode = '22023';
  end if;
  v_guardian := exists (select 1 from guardians g where g.student_id = p_student_id and g.profile_id = auth.uid());

  if v_guardian then
    v_method := 'app';
    v_signed := null;
    v_form := null;
  elsif has_perm(v_student.tenant_id, 'people') then
    v_method := 'paper';
    if v_signed is null then
      raise exception '%', case when p_give then 'Enter the name of the parent or guardian who signed the form.'
                                else 'Enter the name of the parent or guardian who asked to withdraw.' end
        using errcode = '22023';
    end if;
    if p_give and v_form is null then
      raise exception 'Enter the date on the signed form.' using errcode = '22023';
    end if;
    if v_form > current_date then
      raise exception 'The form''s date can''t be in the future.' using errcode = '22023';
    end if;
  else
    raise exception 'Only the learner''s parent or guardian, or the school office, can record this.' using errcode = '42501';
  end if;

  select * into c from health_consents where student_id = p_student_id for update;
  if c.student_id is not null and c.status = v_status then
    return v_status;
  end if;

  insert into health_consents (student_id, tenant_id, status, method, guardian_id, recorded_by, signed_by, form_date, changed_at)
  values (p_student_id, v_student.tenant_id, v_status, v_method,
          case when v_method = 'app' then auth.uid() end, auth.uid(), v_signed, v_form, now())
  on conflict (student_id) do update
     set status = excluded.status, method = excluded.method, guardian_id = excluded.guardian_id,
         recorded_by = excluded.recorded_by, signed_by = excluded.signed_by, form_date = excluded.form_date,
         changed_at = excluded.changed_at;

  insert into health_consent_log (tenant_id, student_id, status, method, guardian_id, recorded_by, signed_by, form_date)
  values (v_student.tenant_id, p_student_id, v_status, v_method,
          case when v_method = 'app' then auth.uid() end, auth.uid(), v_signed, v_form);

  if not p_give then
    update student_health
       set allergies = '{}', medical_conditions = '{}', medications = null, blood_group = null,
           dietary_needs = null, special_needs = null, notes = null
     where student_id = p_student_id;
  end if;

  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (v_student.tenant_id, auth.uid(), my_actor_label(),
          format('Health consent %s for %s%s', v_status, v_student.full_name,
                 case when v_method = 'paper' then ' (signed form)' else '' end),
          'provisioning',
          jsonb_build_object('student_id', p_student_id, 'status', v_status, 'method', v_method));
  return v_status;
end $$;
revoke execute on function set_health_consent(uuid, boolean, text, date) from public, anon;
grant execute on function set_health_consent(uuid, boolean, text, date) to authenticated;

-- ---------------------------------------------------------------- reading
-- One learner's consent, with names, and whether health details are on file.
-- For the learner's guardians and the people and medical areas; anyone else
-- gets no row. status null: nobody has decided yet.
create or replace function health_consent_status(p_student_id uuid)
returns table (
  student_id uuid, status text, method text, guardian_name text, recorded_by_name text,
  signed_by text, form_date date, changed_at timestamptz, has_details boolean
)
language sql stable security definer set search_path = public as $$
  select s.id, c.status, c.method,
         (select full_name from profiles where id = c.guardian_id),
         (select full_name from profiles where id = c.recorded_by),
         c.signed_by, c.form_date, c.changed_at,
         coalesce((select student_health_has_details(h) from student_health h where h.student_id = s.id), false)
    from students s
    left join health_consents c on c.student_id = s.id
   where s.id = p_student_id
     and s.tenant_id = my_tenant()
     and (has_perm(s.tenant_id, 'people') or has_perm(s.tenant_id, 'medical')
          or exists (select 1 from guardians g where g.student_id = s.id and g.profile_id = auth.uid()))
$$;
revoke execute on function health_consent_status(uuid) from public, anon;
grant execute on function health_consent_status(uuid) to authenticated;

-- The caller's children whose health details are on file with no decision
-- yet: what the parent's home page asks about.
create or replace function my_health_consent_requests()
returns table (student_id uuid, full_name text)
language sql stable security definer set search_path = public as $$
  select s.id, s.full_name
    from guardians g
    join students s on s.id = g.student_id and s.active
    join student_health h on h.student_id = s.id
   where g.profile_id = auth.uid()
     and student_health_has_details(h)
     and not exists (select 1 from health_consents c where c.student_id = s.id)
   order by s.full_name
$$;
revoke execute on function my_health_consent_requests() from public, anon;
grant execute on function my_health_consent_requests() to authenticated;
