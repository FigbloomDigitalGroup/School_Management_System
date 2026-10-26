-- Parents fill in their child's bio data.
--
-- A family already keeps health (student_health) and home (set_child_home)
-- up to date. This adds the rest of what a school records about a learner
-- and lets a guardian supply it, in two kinds:
--
--   everyday details  nationality, religion, previous school. A guardian's
--                     change applies at once, like health and home.
--   identity details  full name, date of birth, gender, birth certificate
--                     number, NEMIS UPI. These end up on report cards, exam
--                     registration and NEMIS, so a guardian's change waits
--                     for the office: it becomes a student_bio_requests row
--                     an admin approves or rejects from People.
--
-- An admin's change applies at once, whichever kind. Admission number,
-- class, boarding and fees stay the school's: they aren't in either list.
--
-- Guardians still can't write students (student_write is admin-only). Their
-- one way in is set_child_bio(), which touches only the columns above.
-- Every change is stamped on the row (bio_updated_at/by) and logged to
-- audit_events by field name; the values stay on the learner's record.
--
-- A guardian's own contact details are their profiles row, which
-- MyAccountFields already edits; profiles.alt_phone adds a second number.

-- ================================================================ columns

alter table students
  add column birth_cert_no   text,
  add column upi_no          text,
  add column nationality     text,
  add column religion        text,
  add column previous_school text,
  add column bio_updated_at  timestamptz,
  add column bio_updated_by  uuid references profiles on delete set null,
  add constraint students_bio_len check (
    coalesce(char_length(birth_cert_no), 0) <= 30 and coalesce(char_length(upi_no), 0) <= 20
    and coalesce(char_length(nationality), 0) <= 60 and coalesce(char_length(religion), 0) <= 60
    and coalesce(char_length(previous_school), 0) <= 160
  );

-- A second number for when the first is off: parents set it themselves
-- (guard_profile_self_edit lets descriptive fields through).
alter table profiles
  add column alt_phone text,
  add constraint profiles_alt_phone_len check (alt_phone is null or char_length(alt_phone) <= 40);

-- ================================================================ requests

create table student_bio_requests (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants on delete cascade,
  student_id   uuid not null references students on delete cascade,
  requested_by uuid references profiles on delete set null,
  -- the identity fields asked for, {field: new value}; null clears a field
  changes      jsonb not null check (jsonb_typeof(changes) = 'object'),
  -- what those fields held when asked, so the office sees "from -> to"
  previous     jsonb not null default '{}'::jsonb,
  status       text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  decided_by   uuid references profiles on delete set null,
  decided_at   timestamptz,
  note         text check (note is null or char_length(note) <= 500),
  created_at   timestamptz not null default now()
);
-- One open request per learner: a guardian asking again replaces it.
create unique index student_bio_requests_one_pending on student_bio_requests (student_id) where status = 'pending';
create index on student_bio_requests (tenant_id, status, created_at desc);

alter table student_bio_requests enable row level security;

-- The office sees its school's; a family sees their own child's. Written
-- only through set_child_bio() and decide_bio_request().
create policy student_bio_requests_read on student_bio_requests for select
  using (may_administer(tenant_id) or student_id in (select my_students()));

create trigger student_bio_requests_student_tenant before insert or update of tenant_id, student_id on student_bio_requests
  for each row execute function enforce_student_tenant();

-- ================================================================ helpers

-- One identity value from the client, tidied. Raises on a value that can't be right.
create or replace function bio_identity_value(p_field text, p_value jsonb) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v text := nullif(trim(coalesce(p_value #>> '{}', '')), '');
  d date;
begin
  if p_field = 'full_name' then
    v := regexp_replace(coalesce(v, ''), '\s+', ' ', 'g');
    if v = '' or char_length(v) > 120 then
      raise exception 'A learner needs a name of up to 120 characters' using errcode = '22023';
    end if;
  elsif p_field = 'date_of_birth' then
    if v is not null then
      begin
        d := v::date;
      exception when others then
        raise exception 'That date of birth is not a date' using errcode = '22023';
      end;
      if d > current_date or d < date '1900-01-01' then
        raise exception 'That date of birth is not possible' using errcode = '22023';
      end if;
      v := d::text;
    end if;
  elsif p_field = 'gender' then
    if v is not null and v not in ('male', 'female') then
      raise exception 'Gender must be male or female' using errcode = '22023';
    end if;
  elsif p_field in ('birth_cert_no', 'upi_no') then
    -- "123 456" and "123456" are the same certificate
    v := nullif(upper(regexp_replace(coalesce(v, ''), '\s+', '', 'g')), '');
    if v is not null and char_length(v) > case when p_field = 'upi_no' then 20 else 30 end then
      raise exception '% is too long', case when p_field = 'upi_no' then 'The UPI number' else 'The birth certificate number' end using errcode = '22023';
    end if;
  else
    raise exception 'Unknown bio field %', p_field using errcode = '22023';
  end if;
  return to_jsonb(v);
end;
$$;

-- An identity field's current value, as stored, for comparing and for "previous".
create or replace function bio_identity_current(s students, p_field text) returns jsonb
language sql immutable set search_path = public as $$
  select case p_field
    when 'full_name' then to_jsonb(s.full_name)
    when 'date_of_birth' then to_jsonb(s.date_of_birth::text)
    when 'gender' then to_jsonb(s.gender)
    when 'birth_cert_no' then to_jsonb(s.birth_cert_no)
    when 'upi_no' then to_jsonb(s.upi_no)
  end
$$;

-- Write identity values that have already been through bio_identity_value().
-- Internal: called by set_child_bio() for admins and decide_bio_request() on approval.
create or replace function apply_bio_identity(p_student_id uuid, c jsonb) returns void
language sql security definer set search_path = public as $$
  update students set
    full_name     = case when c ? 'full_name' then c->>'full_name' else full_name end,
    date_of_birth = case when c ? 'date_of_birth' then (c->>'date_of_birth')::date else date_of_birth end,
    gender        = case when c ? 'gender' then c->>'gender' else gender end,
    birth_cert_no = case when c ? 'birth_cert_no' then c->>'birth_cert_no' else birth_cert_no end,
    upi_no        = case when c ? 'upi_no' then c->>'upi_no' else upi_no end
  where id = p_student_id
$$;

revoke execute on function apply_bio_identity(uuid, jsonb) from public, anon, authenticated;

-- ================================================================ set_child_bio

-- Save a learner's bio data. p_bio holds any of the fields below; a key
-- that's absent is left as it is, null or "" clears it. Returns
-- {"saved": [fields applied], "pending": [fields sent to the office]}.
create or replace function set_child_bio(p_student_id uuid, p_bio jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  s          students%rowtype;
  v_admin    boolean;
  v_field    text;
  v_new      jsonb;
  v_saved    text[] := '{}';
  v_pending  text[] := '{}';
  v_changes  jsonb := '{}'::jsonb;
  v_previous jsonb := '{}'::jsonb;
  v_nat      text;
  v_rel      text;
  v_prev     text;
begin
  select * into s from students where id = p_student_id for update;
  if not found then
    raise exception 'You can only change the details of your own child' using errcode = '42501';
  end if;
  v_admin := may_administer(s.tenant_id);
  if not v_admin and not exists (select 1 from guardians g where g.student_id = p_student_id and g.profile_id = auth.uid()) then
    raise exception 'You can only change the details of your own child' using errcode = '42501';
  end if;
  if p_bio is null or jsonb_typeof(p_bio) <> 'object' then
    raise exception 'Bio data must be an object' using errcode = '22023';
  end if;

  -- everyday details: applied for anyone allowed here
  v_nat  := case when p_bio ? 'nationality' then nullif(left(trim(coalesce(p_bio->>'nationality', '')), 60), '') else s.nationality end;
  v_rel  := case when p_bio ? 'religion' then nullif(left(trim(coalesce(p_bio->>'religion', '')), 60), '') else s.religion end;
  v_prev := case when p_bio ? 'previous_school' then nullif(left(trim(coalesce(p_bio->>'previous_school', '')), 160), '') else s.previous_school end;
  if v_nat is distinct from s.nationality then v_saved := array_append(v_saved, 'nationality'); end if;
  if v_rel is distinct from s.religion then v_saved := array_append(v_saved, 'religion'); end if;
  if v_prev is distinct from s.previous_school then v_saved := array_append(v_saved, 'previous_school'); end if;

  -- identity details: only the ones that actually change
  foreach v_field in array array['full_name', 'date_of_birth', 'gender', 'birth_cert_no', 'upi_no'] loop
    if p_bio ? v_field then
      v_new := bio_identity_value(v_field, p_bio->v_field);
      if v_new is distinct from bio_identity_current(s, v_field) then
        v_changes := v_changes || jsonb_build_object(v_field, v_new);
        v_previous := v_previous || jsonb_build_object(v_field, bio_identity_current(s, v_field));
      end if;
    end if;
  end loop;

  if cardinality(v_saved) > 0 then
    update students set nationality = v_nat, religion = v_rel, previous_school = v_prev where id = p_student_id;
  end if;

  if v_changes <> '{}'::jsonb then
    if v_admin then
      perform apply_bio_identity(p_student_id, v_changes);
      v_saved := v_saved || array(select jsonb_object_keys(v_changes));
      -- the office has now set these itself: an open request for them is moot
      update student_bio_requests set status = 'rejected', decided_by = auth.uid(), decided_at = now(),
        note = 'Superseded: the office changed these details directly'
      where student_id = p_student_id and status = 'pending' and changes ?| array(select jsonb_object_keys(v_changes));
    else
      v_pending := array(select jsonb_object_keys(v_changes));
      insert into student_bio_requests (tenant_id, student_id, requested_by, changes, previous)
      values (s.tenant_id, p_student_id, auth.uid(), v_changes, v_previous)
      on conflict (student_id) where status = 'pending' do update
        set requested_by = excluded.requested_by,
            -- asking again keeps what was asked before and wasn't asked about now
            changes = student_bio_requests.changes || excluded.changes,
            previous = excluded.previous || student_bio_requests.previous,
            created_at = now();
    end if;
  end if;

  if cardinality(v_saved) > 0 then
    update students set bio_updated_at = now(), bio_updated_by = auth.uid() where id = p_student_id;
  end if;

  if cardinality(v_saved) > 0 or cardinality(v_pending) > 0 then
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    values (s.tenant_id, auth.uid(), my_actor_label(),
            case when cardinality(v_saved) > 0 then format('Bio data updated for %s', s.full_name)
                 else format('Bio data change requested for %s', s.full_name) end,
            'provisioning',
            jsonb_build_object('student_id', p_student_id, 'fields', to_jsonb(v_saved), 'pending_fields', to_jsonb(v_pending)));
  end if;

  return jsonb_build_object('saved', to_jsonb(v_saved), 'pending', to_jsonb(v_pending));
end;
$$;

-- ================================================================ decide_bio_request

-- The office approves (the values are written) or rejects a pending
-- request; the guardian who asked can withdraw it (p_approve false).
create or replace function decide_bio_request(p_request_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  r      student_bio_requests%rowtype;
  v_name text;
  v_status text;
begin
  select * into r from student_bio_requests where id = p_request_id for update;
  if not found or r.status <> 'pending' then
    raise exception 'That request has already been dealt with' using errcode = '22023';
  end if;

  if may_administer(r.tenant_id) then
    v_status := case when p_approve then 'approved' else 'rejected' end;
  elsif r.requested_by = auth.uid() and not p_approve then
    v_status := 'withdrawn';
  else
    raise exception 'Only the school office can approve changes to a learner''s details' using errcode = '42501';
  end if;

  if v_status = 'approved' then
    perform apply_bio_identity(r.student_id, r.changes);
    update students set bio_updated_at = now(), bio_updated_by = r.requested_by where id = r.student_id;
  end if;

  update student_bio_requests
  set status = v_status, decided_by = auth.uid(), decided_at = now(), note = nullif(left(trim(coalesce(p_note, '')), 500), '')
  where id = p_request_id;

  select full_name into v_name from students where id = r.student_id;
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (r.tenant_id, auth.uid(), my_actor_label(),
          format('Bio data change %s for %s', v_status, coalesce(v_name, 'a learner')),
          'provisioning',
          jsonb_build_object('student_id', r.student_id, 'request_id', r.id,
                             'fields', to_jsonb(array(select jsonb_object_keys(r.changes)))));
end;
$$;

revoke execute on function set_child_bio(uuid, jsonb), decide_bio_request(uuid, boolean, text) from public, anon;
grant execute on function set_child_bio(uuid, jsonb), decide_bio_request(uuid, boolean, text) to authenticated;
