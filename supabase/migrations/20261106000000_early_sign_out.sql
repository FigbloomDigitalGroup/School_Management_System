-- FIG-1513 (stage A): early sign-out. A learner marked present in the morning who leaves during the day is recorded: when, why, who
-- authorised it, and who collected them (name, relationship, ID number, phone). The register, the learner's record and the parent app
-- show "left early at HH:MM"; the office and the gate have a daily list; the record is in the audit trail.
--
-- What this migration does NOT do (still FIG-1513, later stages): it does not touch `attendance` (same key, same trigger, same queue),
-- so offline registers on phones in the field are unaffected; it sends no SMS (no provider exists); it does not yet treat a signed-out
-- learner in an afternoon register (that needs FIG-1514, stage C).
--
-- Who may do what (decided by the human task owner, 2026-11-06):
--   record a sign-out   people holding the 'attendance' area (has_perm, which includes full admins and org admins), and the class
--                       teacher of the learner's class: the same two people attendance_write already trusts for registers.
--   void a sign-out     the attendance area, or the person who recorded it. Nobody edits or deletes a record through the app (there
--                       is no write policy and the triggers below refuse edits, even to the service role); a mistake is voided with
--                       a reason (kept in the restricted details) and stays visible. A learner or school removed by a cascade takes its
--                       records with it.
--   read                the sign-out (time, reason, collector name and relationship): the attendance area, the visitors area (the
--                       gate's daily list), the class teacher, the person who recorded it, and the learner's guardians. The learner
--                       does not read the record. The class teacher is the one the learner has NOW, not the class at sign-out time (the
--                       same as for recording; decided by the human task owner).
--                       The restricted details (collector ID number and phone, who authorised the sign-out, the free-text note and the
--                       free-text void reason) live in
--                       their own table, readable only by the attendance area (full admins) and the person who recorded the sign-out.
--                       A row-level policy cannot hide columns, hence two tables.
--   several a day       a learner may leave, return and leave again: each departure is its own record. A second sign-out less than five
--                       minutes from a live one is refused as a double click.
--
-- Writes go through two SECURITY DEFINER functions only; the tables have a read policy and no write policy, like fee_charges.
-- The functions write their own audit events, so the tables are not in audit_table_config. The recording event holds no ID number,
-- phone, note, authorised-by or reason, and the void event says only that the sign-out was voided (the void reason is restricted).
--
-- The learner delete guard (20261105430000) finds early_sign_outs through its cascading foreign key, so a learner with a sign-out is
-- archived, not deleted, without editing that function.

-- ---------------------------------------------------------------- the record
create table early_sign_outs (
  id                         uuid primary key default gen_random_uuid(),
  tenant_id                  uuid not null references tenants on delete cascade,
  student_id                 uuid not null references students on delete cascade,
  -- the learner's class when they were signed out (who the class teacher is, and the list), and names as written then
  class_id                   uuid references classes on delete set null,
  student_name               text not null,
  class_name                 text,
  taken_on                   date not null,
  signed_out_at              timestamptz not null,
  -- the wall-clock time at the school (tenants.timezone), so every screen shows the same HH:MM without knowing the time zone
  signed_out_local           time(0) not null,
  reason                     text not null check (length(btrim(reason)) between 1 and 200),
  collected_by_name          text not null check (length(btrim(collected_by_name)) between 1 and 120),
  collected_by_relationship  text not null check (length(btrim(collected_by_relationship)) between 1 and 60),
  parent_pushed_at           timestamptz,
  recorded_by                uuid references profiles on delete set null,
  recorded_at                timestamptz not null default now(),
  voided_at                  timestamptz,
  voided_by                  uuid references profiles on delete set null
  -- (the free-text void reason is in the restricted details, below)
);
create index early_sign_outs_day_idx on early_sign_outs (tenant_id, taken_on);
create index early_sign_outs_student_idx on early_sign_outs (student_id, taken_on desc);

-- the restricted details: personal data and free text, a stricter read than the sign-out itself
create table early_sign_out_collectors (
  sign_out_id    uuid primary key references early_sign_outs on delete cascade,
  tenant_id      uuid not null references tenants on delete cascade,
  id_number      text not null check (length(btrim(id_number)) between 3 and 30),
  -- the same shape as COLLECTOR_PHONE_PATTERN in packages/shared/src/earlySignOut.ts (guardrail 5: keep the two in step)
  phone          text not null check (phone ~ '^\+?[0-9][0-9 ()-]{5,19}$'),
  authorised_by  text not null check (length(btrim(authorised_by)) between 1 and 120),
  note           text check (note is null or length(btrim(note)) between 1 and 500),
  -- set once, when the sign-out is voided (void_early_sign_out); free text, so it is as restricted as the note
  void_reason    text check (void_reason is null or length(btrim(void_reason)) between 1 and 200)
);

alter table early_sign_outs enable row level security;
alter table early_sign_out_collectors enable row level security;

-- Guardians are matched with the same test the invoice policies use (20261105400000), not my_family_students(): that function also
-- returns the learner themself, who is not meant to read this record.
create policy early_sign_outs_read on early_sign_outs for select to authenticated
  using (
    is_super()
    or has_perm(tenant_id, 'attendance')
    or has_perm(tenant_id, 'visitors')
    or recorded_by = auth.uid()
    or exists (select 1 from guardians g where g.student_id = early_sign_outs.student_id and g.profile_id = auth.uid())
    or exists (select 1 from students s join classes c on c.id = s.class_id
                where s.id = early_sign_outs.student_id and c.class_teacher_id = auth.uid())
  );

create policy early_sign_out_collectors_read on early_sign_out_collectors for select to authenticated
  using (
    is_super()
    or has_perm(tenant_id, 'attendance')
    or exists (select 1 from early_sign_outs e where e.id = early_sign_out_collectors.sign_out_id and e.recorded_by = auth.uid())
  );

-- a school's rows point only at that school's records (20261103600000, FIG-1313); zz_ so it fires after any stamping trigger (20261105300000)
create trigger zz_early_sign_outs_same_school before insert or update on early_sign_outs
  for each row execute function enforce_same_school_refs('class_id', 'classes', 'recorded_by', 'profiles', 'student_id', 'students', 'voided_by', 'profiles');
create trigger zz_early_sign_out_collectors_same_school before insert or update on early_sign_out_collectors
  for each row execute function enforce_same_school_refs('sign_out_id', 'early_sign_outs');

-- ---------------------------------------------------------------- record
create or replace function record_early_sign_out(
  p_student_id uuid,
  p_reason text,
  p_authorised_by text,
  p_collected_by_name text,
  p_collected_by_relationship text,
  p_collected_by_id_number text,
  p_collected_by_phone text,
  p_note text default null,
  -- an earlier time today as the school's clock reads it ("10:45"); null means now. Combined with today in the school's own time zone
  -- here, so no screen has to know the time zone.
  p_signed_out_time time default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  s record;
  v_class text;
  v_tz text;
  v_at timestamptz;
  v_local timestamp;
  v_today date;
  v_reason text := btrim(coalesce(p_reason, ''), E' \t\r\n');
  v_auth text := btrim(coalesce(p_authorised_by, ''), E' \t\r\n');
  v_name text := btrim(coalesce(p_collected_by_name, ''), E' \t\r\n');
  v_rel text := btrim(coalesce(p_collected_by_relationship, ''), E' \t\r\n');
  v_idn text := btrim(coalesce(p_collected_by_id_number, ''), E' \t\r\n');
  v_phone text := btrim(coalesce(p_collected_by_phone, ''), E' \t\r\n');
  v_note text := nullif(btrim(coalesce(p_note, ''), E' \t\r\n'), '');
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in to record a sign-out.' using errcode = '42501';
  end if;

  select st.id, st.tenant_id, st.full_name, st.class_id, st.active into s from students st where st.id = p_student_id;
  if not found
     or not (
       has_perm(s.tenant_id, 'attendance')
       or exists (select 1 from classes c where c.id = s.class_id and c.tenant_id = s.tenant_id and c.class_teacher_id = auth.uid())
     ) then
    raise exception 'You can''t record a sign-out for this learner.' using errcode = '42501';
  end if;
  if not s.active then
    raise exception 'This learner is archived.' using errcode = '23514';
  end if;

  -- the same rules as earlySignOutProblem() in packages/shared/src/earlySignOut.ts
  if v_reason = '' or length(v_reason) > 200 then raise exception 'Say why the learner is leaving (up to 200 characters).' using errcode = '23514'; end if;
  if v_auth = '' or length(v_auth) > 120 then raise exception 'Say who authorised the sign-out.' using errcode = '23514'; end if;
  if v_name = '' or length(v_name) > 120 then raise exception 'Enter the name of the person collecting the learner.' using errcode = '23514'; end if;
  if v_rel = '' or length(v_rel) > 60 then raise exception 'Enter how the collector is related to the learner.' using errcode = '23514'; end if;
  if length(v_idn) < 3 or length(v_idn) > 30 then raise exception 'Enter the collector''s ID number.' using errcode = '23514'; end if;
  if v_phone !~ '^\+?[0-9][0-9 ()-]{5,19}$' then raise exception 'Enter the collector''s phone number.' using errcode = '23514'; end if;
  if v_note is not null and length(v_note) > 500 then raise exception 'The note can be up to 500 characters.' using errcode = '23514'; end if;

  select coalesce(t.timezone, 'Africa/Nairobi') into v_tz from tenants t where t.id = s.tenant_id;
  -- "time out" defaults to now; a person may give an earlier time today, never a later one (a clock a minute ahead is tolerated)
  v_today := (now() at time zone v_tz)::date;
  if p_signed_out_time is null then
    v_at := now();
  else
    v_at := (v_today + p_signed_out_time) at time zone v_tz;
    if v_at > now() + interval '2 minutes' then
      raise exception 'The time out can''t be in the future.' using errcode = '23514';
    end if;
    v_at := least(v_at, now());
  end if;
  v_local := v_at at time zone v_tz;

  -- A learner may leave, come back and leave again, so there is no one-a-day rule. A second sign-out within five minutes of a live
  -- one is a double click. The lock makes two calls for the same learner take turns, so both cannot pass this check together.
  perform pg_advisory_xact_lock(hashtextextended(s.id::text, 1));
  if exists (
    select 1 from early_sign_outs e
     where e.student_id = s.id and e.taken_on = v_today and e.voided_at is null
       and abs(extract(epoch from (e.signed_out_at - v_at))) < 300
  ) then
    raise exception '% was already signed out a moment ago.', s.full_name using errcode = '23505';
  end if;

  select c.name into v_class from classes c where c.id = s.class_id;

  insert into early_sign_outs (tenant_id, student_id, class_id, student_name, class_name, taken_on, signed_out_at, signed_out_local,
                               reason, collected_by_name, collected_by_relationship, recorded_by)
  values (s.tenant_id, s.id, s.class_id, s.full_name, v_class, v_today, v_at, date_trunc('second', v_local)::time(0),
          v_reason, v_name, v_rel, auth.uid())
  returning id into v_id;

  insert into early_sign_out_collectors (sign_out_id, tenant_id, id_number, phone, authorised_by, note)
  values (v_id, s.tenant_id, v_idn, v_phone, v_auth, v_note);

  -- No ID number, phone, note or free-text reason in the audit event: the audit log is readable by the audit area, and those are
  -- restricted or private (the log keeps leave reasons out the same way). They stay on the record itself.
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (
    s.tenant_id, auth.uid(), my_actor_label(),
    format('%s signed out early at %s, collected by %s (%s)', s.full_name, to_char(v_local, 'HH24:MI'), v_name, v_rel),
    'operations',
    jsonb_build_object('sign_out_id', v_id, 'student_id', s.id)
  );
  return v_id;
end $$;

-- ---------------------------------------------------------------- void
create or replace function void_early_sign_out(p_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare
  e record;
  v_reason text := btrim(coalesce(p_reason, ''), E' \t\r\n');
begin
  if auth.uid() is null then
    raise exception 'Sign in to void a sign-out.' using errcode = '42501';
  end if;
  select * into e from early_sign_outs where id = p_id for update;
  if not found or not (has_perm(e.tenant_id, 'attendance') or e.recorded_by = auth.uid()) then
    raise exception 'You can''t void this sign-out.' using errcode = '42501';
  end if;
  if e.voided_at is not null then
    raise exception 'This sign-out has already been voided.' using errcode = '23514';
  end if;
  if v_reason = '' or length(v_reason) > 200 then
    raise exception 'Say why the sign-out is being voided (up to 200 characters).' using errcode = '23514';
  end if;

  update early_sign_outs set voided_at = now(), voided_by = auth.uid() where id = p_id;
  -- the free-text reason is restricted like the note: only the attendance area and the recorder read it
  update early_sign_out_collectors set void_reason = v_reason where sign_out_id = p_id;

  -- The audit event says only that it was voided: the reason is free text (it may name someone), and the audit log has a wider
  -- readership than the restricted details.
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (
    e.tenant_id, auth.uid(), my_actor_label(),
    format('Early sign-out of %s voided', e.student_name),
    'operations',
    jsonb_build_object('sign_out_id', e.id, 'student_id', e.student_id)
  );
end $$;

-- ---------------------------------------------------------------- the record is not edited
-- Only a void (once), the push marker (the notify function, service role) and the foreign keys' own "set null" on a deleted profile
-- or class may change a row. Everything else, including what was written by the definer functions above, stays as recorded.
create or replace function early_sign_outs_immutable() returns trigger
language plpgsql as $$
begin
  if (to_jsonb(new) - array['voided_at', 'voided_by', 'parent_pushed_at', 'recorded_by', 'class_id'])
     is distinct from (to_jsonb(old) - array['voided_at', 'voided_by', 'parent_pushed_at', 'recorded_by', 'class_id']) then
    raise exception 'A sign-out record cannot be edited. Void it and record a new one.' using errcode = '42501';
  end if;
  if (new.recorded_by is distinct from old.recorded_by and new.recorded_by is not null)
     or (new.class_id is distinct from old.class_id and new.class_id is not null) then
    raise exception 'A sign-out record cannot be edited. Void it and record a new one.' using errcode = '42501';
  end if;
  if old.voided_at is not null and new.voided_at is distinct from old.voided_at then
    raise exception 'A voided sign-out cannot be changed.' using errcode = '42501';
  end if;
  if new.voided_by is distinct from old.voided_by and new.voided_by is not null
     and not (old.voided_at is null and new.voided_at is not null) then
    raise exception 'A sign-out record cannot be edited. Void it and record a new one.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger early_sign_outs_immutable before update on early_sign_outs
  for each row execute function early_sign_outs_immutable();

-- The restricted details are written once with the sign-out and never changed (they go with it if the sign-out is removed by a
-- cascade), with one exception: the void reason is set once, when the sign-out is voided, and then it is final too.
create or replace function early_sign_out_collectors_immutable() returns trigger
language plpgsql as $$
begin
  if (to_jsonb(new) - 'void_reason') is distinct from (to_jsonb(old) - 'void_reason')
     or old.void_reason is not null
     or new.void_reason is null then
    raise exception 'A sign-out record cannot be edited. Void it and record a new one.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger early_sign_out_collectors_immutable before update on early_sign_out_collectors
  for each row execute function early_sign_out_collectors_immutable();

-- ---------------------------------------------------------------- who can call
revoke execute on function
  record_early_sign_out(uuid, text, text, text, text, text, text, text, time),
  void_early_sign_out(uuid, text),
  early_sign_outs_immutable(),
  early_sign_out_collectors_immutable()
  from public, anon;
grant execute on function
  record_early_sign_out(uuid, text, text, text, text, text, text, text, time),
  void_early_sign_out(uuid, text)
  to authenticated;
