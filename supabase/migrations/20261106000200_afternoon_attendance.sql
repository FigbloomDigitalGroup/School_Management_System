-- FIG-1514: a morning and an afternoon register for the same class and day.
--
-- The school takes the register twice a day. attendance holds one row per learner per day (unique student_id, taken_on), so the
-- second roll call replaced the first.
--
-- Approved design (Ancel, 2026-11-06; Linear FIG-1514 decisions A to L):
--
--   * attendance is unchanged: same table, identity, key, rows and triggers. It IS the morning register. Nothing is backfilled or
--     rewritten; every row already stored is a morning row by definition.
--   * attendance_afternoon is a new table with the same columns and the same key, for the afternoon register. A write to one never
--     touches the other.
--   * Teacher apps already installed keep upserting attendance on (student_id, taken_on): their registers are morning registers.
--     They never name attendance_afternoon, so they cannot reach it. Nothing they send today is refused by anything added here (a
--     refusal would be permanent in their offline queue).
--   * attendance_settings, one optional row per school: whether the school takes an afternoon register (off unless turned on) and
--     how percentages count ('session': every register entry counts; 'day': a learner-day counts once, here if here in any session).
--     No row means the defaults. While the afternoon register is off, any INSERT into attendance_afternoon is refused, including the
--     apps' upsert of an entry that already exists (a BEFORE INSERT trigger fires for INSERT ... ON CONFLICT too), so no app can
--     write the afternoon register. A plain UPDATE of a stored entry is still allowed. Past entries are kept and still count
--     (decision G, I).
--   * attendance_session_at(school, time): 'afternoon' from 12:00 school time when the school takes an afternoon register, otherwise
--     'morning'. packages/shared/src/attendanceSession.ts sessionAt() is its twin; supabase/rls-checks/afternoon_attendance.sql checks
--     they agree at 11:59 and 12:00.
--   * Percentages (decision J, K): a session is an opportunity on a date only if a register entry exists for it; past dates use the
--     school's CURRENT mode; an afternoon absence (absent or excused) of a learner with a live early sign-out that day is left out
--     altogether. attendance_counted() does this once for the SQL readers (term_class_figures, the group summary);
--     packages/shared/src/attendanceSession.ts countAttendance() is the TypeScript twin.
--   * The sick bay (decision E, L): medical_mark_attendance files the mark in the session of the moment it is about (the school's own
--     time zone, no longer a fixed Africa/Nairobi), and a morning mark is carried into that day's afternoon register when the school
--     takes one. One row per learner per session (the keys).
--
-- attendance_afternoon gets everything attendance has: the day and newest-wins rule (attendance_day_and_order, FIG-1400 / FIG-1410,
-- the same function), the same-school and learner-school triggers, the audit triggers, the group-summary statement triggers (FIG-1499)
-- and the same read and write rules. The learner delete guard (20261105430000) finds it through its cascading foreign key.

-- ---------------------------------------------------------------- settings
create table attendance_settings (
  tenant_id          uuid primary key references tenants on delete cascade,
  afternoon_enabled  boolean not null default false,
  percentage_mode    text not null default 'session' check (percentage_mode in ('session', 'day')),
  updated_at         timestamptz not null default now()
);
alter table attendance_settings enable row level security;

-- everyone at the school reads it (the apps need to know whether there is an afternoon register and how to count); the attendance
-- area and full admins change it
create policy attendance_settings_read on attendance_settings for select
  using (is_super() or tenant_id = my_tenant() or has_perm(tenant_id, 'attendance'));
create policy attendance_settings_write on attendance_settings for all
  using (has_perm(tenant_id, 'attendance'))
  with check (has_perm(tenant_id, 'attendance'));

create or replace function attendance_settings_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger attendance_settings_touch before update on attendance_settings
  for each row execute function attendance_settings_touch();

-- the two settings, with the defaults when a school has no row (used by the triggers and functions below, never by a signed-in user)
create or replace function attendance_afternoon_enabled(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select s.afternoon_enabled from attendance_settings s where s.tenant_id = p_tenant), false)
$$;

create or replace function attendance_percentage_mode(p_tenant uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select s.percentage_mode from attendance_settings s where s.tenant_id = p_tenant), 'session')
$$;

-- Which register a moment belongs to: from 12:00 school time it is the afternoon's, if the school takes one.
create or replace function attendance_session_at(p_tenant uuid, p_at timestamptz default now()) returns text
language sql stable security definer set search_path = public as $$
  select case
    when attendance_afternoon_enabled(p_tenant)
     and (p_at at time zone coalesce((select t.timezone from tenants t where t.id = p_tenant), 'Africa/Nairobi'))::time >= time '12:00'
    then 'afternoon' else 'morning' end
$$;

-- ---------------------------------------------------------------- the afternoon register
create table attendance_afternoon (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants on delete cascade,
  student_id  uuid not null references students on delete cascade,
  class_id    uuid not null references classes on delete cascade,
  term_id     uuid not null references terms on delete cascade,
  taken_by    uuid not null references profiles on delete restrict,
  taken_on    date not null,
  mark        attendance_mark not null default 'present',
  note        text,
  created_at  timestamptz not null default now(),
  marked_at   timestamptz not null default now(),
  unique (student_id, taken_on)                       -- one afternoon entry per learner per day
);
create index attendance_afternoon_class_day_idx on attendance_afternoon (tenant_id, class_id, taken_on);
create index attendance_afternoon_term_day_idx on attendance_afternoon (tenant_id, term_id, taken_on desc);
alter table attendance_afternoon enable row level security;

-- the same rules as attendance (20261031000001): the attendance area, a teacher of the class, the class teacher
create policy attendance_afternoon_read on attendance_afternoon for select
  using (is_super() or (student_id in (select my_students())) or has_perm(tenant_id, 'attendance'));
create policy attendance_afternoon_write on attendance_afternoon for all
  using (has_perm(tenant_id, 'attendance')
         or (tenant_id = my_tenant() and my_role() = 'teacher'::app_role
             and exists (select 1 from teaching_assignments ta where ta.teacher_id = auth.uid() and ta.class_id = attendance_afternoon.class_id))
         or (tenant_id = my_tenant()
             and exists (select 1 from classes c where c.id = attendance_afternoon.class_id and c.class_teacher_id = auth.uid())))
  with check (has_perm(tenant_id, 'attendance')
         or (tenant_id = my_tenant() and my_role() = 'teacher'::app_role
             and exists (select 1 from teaching_assignments ta where ta.teacher_id = auth.uid() and ta.class_id = attendance_afternoon.class_id))
         or (tenant_id = my_tenant()
             and exists (select 1 from classes c where c.id = attendance_afternoon.class_id and c.class_teacher_id = auth.uid())));

-- A new afternoon entry only while the school takes an afternoon register. This fires for every INSERT, including INSERT ... ON
-- CONFLICT DO UPDATE (the apps' upsert and the offline queue), so while the register is off the apps cannot write it at all, and an
-- afternoon register held on a phone and sent after the school turned it off is refused (permanently, in the queue). Only a plain
-- UPDATE of a stored entry gets through; the stored entries are kept either way.
create or replace function attendance_afternoon_allowed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not attendance_afternoon_enabled(new.tenant_id) then
    raise exception 'This school does not take an afternoon register. It can be turned on in the attendance settings.'
      using errcode = '23514';
  end if;
  return new;
end $$;

create trigger attendance_afternoon_allowed before insert on attendance_afternoon
  for each row execute function attendance_afternoon_allowed();
-- the date check and newest-wins rule of the morning register (FIG-1400, FIG-1410), the same function
create trigger attendance_afternoon_day_and_order before insert or update on attendance_afternoon
  for each row execute function attendance_day_and_order();
create trigger attendance_afternoon_student_tenant before insert or update of tenant_id, student_id on attendance_afternoon
  for each row execute function enforce_student_tenant();
create trigger zz_attendance_afternoon_same_school before insert or update on attendance_afternoon
  for each row execute function enforce_same_school_refs('class_id', 'classes', 'student_id', 'students', 'taken_by', 'profiles', 'term_id', 'terms');

-- the group summary (FIG-1499 statement triggers): the afternoon register and a change of counting both change it
create trigger refresh_org_summary_attendance_afternoon_ins after insert on attendance_afternoon
  referencing new table as new_rows for each statement execute function trg_refresh_org_summary_statement();
create trigger refresh_org_summary_attendance_afternoon_upd after update on attendance_afternoon
  referencing old table as old_rows new table as new_rows for each statement execute function trg_refresh_org_summary_statement();
create trigger refresh_org_summary_attendance_afternoon_del after delete on attendance_afternoon
  referencing old table as old_rows for each statement execute function trg_refresh_org_summary_statement();
create trigger refresh_org_summary_attendance_settings_ins after insert on attendance_settings
  referencing new table as new_rows for each statement execute function trg_refresh_org_summary_statement();
create trigger refresh_org_summary_attendance_settings_upd after update on attendance_settings
  referencing old table as old_rows new table as new_rows for each statement execute function trg_refresh_org_summary_statement();
create trigger refresh_org_summary_attendance_settings_del after delete on attendance_settings
  referencing old table as old_rows for each statement execute function trg_refresh_org_summary_statement();

-- audit, the same way 20261104000000 installs it
insert into audit_table_config (table_name, category, keep_values) values
  ('attendance_afternoon', 'academic', true), ('attendance_settings', 'academic', true);
create trigger attendance_afternoon_audit_ins after insert on attendance_afternoon
  referencing new table as new_rows for each statement execute function audit_table_change('academic', 'true', 'id');
create trigger attendance_afternoon_audit_upd after update on attendance_afternoon
  referencing old table as old_rows new table as new_rows for each statement execute function audit_table_change('academic', 'true', 'id');
create trigger attendance_afternoon_audit_del after delete on attendance_afternoon
  referencing old table as old_rows for each statement execute function audit_table_change('academic', 'true', 'id');
create trigger attendance_settings_audit_ins after insert on attendance_settings
  referencing new table as new_rows for each statement execute function audit_table_change('academic', 'true', 'tenant_id');
create trigger attendance_settings_audit_upd after update on attendance_settings
  referencing old table as old_rows new table as new_rows for each statement execute function audit_table_change('academic', 'true', 'tenant_id');
create trigger attendance_settings_audit_del after delete on attendance_settings
  referencing old table as old_rows for each statement execute function audit_table_change('academic', 'true', 'tenant_id');

-- ---------------------------------------------------------------- counting (decisions D, J, K)
-- Every counted unit of a school's attendance, for a term (or every term when p_term is null), in the school's current mode:
--   session  one unit per register entry, morning and afternoon
--   day      one unit per learner and date, here if here (present or late) in any session that day
-- An afternoon absent or excused entry of a learner with a live (not voided) early sign-out that day is left out first: leaving early
-- is not an absence. The class is the class of the morning entry when there is one.
-- packages/shared/src/attendanceSession.ts countAttendance() is the twin; keep them the same.
create or replace function attendance_counted(p_tenant uuid, p_term uuid default null)
returns table(class_id uuid, student_id uuid, taken_on date, here boolean)
language sql stable security definer set search_path = public as $$
  with entries as (
    select a.class_id, a.student_id, a.taken_on, 1 as session, a.mark
      from attendance a
     where a.tenant_id = p_tenant and (p_term is null or a.term_id = p_term)
    union all
    select p.class_id, p.student_id, p.taken_on, 2, p.mark
      from attendance_afternoon p
     where p.tenant_id = p_tenant and (p_term is null or p.term_id = p_term)
       and not (p.mark in ('absent', 'excused')
                and exists (select 1 from early_sign_outs e
                             where e.student_id = p.student_id and e.taken_on = p.taken_on and e.voided_at is null))
  ),
  mode as (select attendance_percentage_mode(p_tenant) as m)
  select e.class_id, e.student_id, e.taken_on, e.mark in ('present', 'late')
    from entries e, mode
   where mode.m = 'session'
  union all
  select (array_agg(e.class_id order by e.session))[1], e.student_id, e.taken_on, bool_or(e.mark in ('present', 'late'))
    from entries e, mode
   where mode.m = 'day'
   group by e.student_id, e.taken_on
$$;

-- Reports' per-class figures (20261105500000): the attendance part now counts both registers in the school's mode. Everything else is
-- as it was.
create or replace function term_class_figures(p_tenant_id uuid, p_term_id uuid, p_exam_id uuid default null)
returns table(class_id uuid, roster bigint, att_here bigint, att_total bigint, billed bigint, paid bigint, mark_sum bigint, mark_count bigint)
language sql stable security definer set search_path = public as $$
  with p as (
    select has_perm(p_tenant_id, 'attendance') as att, has_perm(p_tenant_id, 'fees') as fees,
           has_perm(p_tenant_id, 'academics') as acad, has_office_perm(p_tenant_id) as people
  ),
  r as (
    select s.class_id, count(*) as n
      from students s join p on p.people
     where s.tenant_id = p_tenant_id and s.active
     group by s.class_id
  ),
  a as (
    select x.class_id, count(*) filter (where x.here) as here, count(*) as total
      from attendance_counted(p_tenant_id, p_term_id) x join p on p.att
     group by x.class_id
  ),
  f as (
    select s.class_id, sum(i.total_cents)::bigint as billed, sum(i.paid_cents)::bigint as paid
      from fee_invoices i join students s on s.id = i.student_id and s.active join p on p.fees
     where i.tenant_id = p_tenant_id and i.term_id = p_term_id
     group by s.class_id
  ),
  m as (
    select s.class_id, sum(k.score)::bigint as total, count(k.score) as n
      from marks k join students s on s.id = k.student_id and s.active join p on p.acad
     where p_exam_id is not null and k.tenant_id = p_tenant_id and k.exam_id = p_exam_id
     group by s.class_id
  )
  select c.id, coalesce(r.n, 0), coalesce(a.here, 0), coalesce(a.total, 0), coalesce(f.billed, 0), coalesce(f.paid, 0),
         coalesce(m.total, 0), coalesce(m.n, 0)
    from classes c cross join p
    left join r on r.class_id = c.id
    left join a on a.class_id = c.id
    left join f on f.class_id = c.id
    left join m on m.class_id = c.id
   where c.tenant_id = p_tenant_id and (p.att or p.fees or p.acad or p.people)
$$;

-- The group summary (20260916080000): present_today follows the school's mode. 'session' keeps what it was (the morning register);
-- 'day' counts each learner once if present in either register today. present_today_pm is the afternoon register's count. The
-- summary's other figures, its "present" (not late) rule and its date are unchanged (separate findings, out of FIG-1514's scope).
alter table organization_tenant_summary add column if not exists present_today_pm bigint not null default 0;

create or replace function refresh_organization_tenant_summary(p_tenant_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from tenants where id = p_tenant_id) then
    delete from organization_tenant_summary where tenant_id = p_tenant_id;
    return;
  end if;

  insert into organization_tenant_summary (
    tenant_id, organization_id, name, institution_type, higher_ed_subtype, delivery_mode, status,
    active_students, present_today, present_today_pm, fees_billed_cents, fees_collected_cents, updated_at
  )
  select
    t.id, t.organization_id, t.name, t.institution_type, t.higher_ed_subtype, t.delivery_mode, t.status,
    (select count(*) from students s where s.tenant_id = t.id and s.active),
    case when attendance_percentage_mode(t.id) = 'day' then
      (select count(*) from (
         select a.student_id from attendance a where a.tenant_id = t.id and a.taken_on = current_date and a.mark = 'present'
         union
         select p.student_id from attendance_afternoon p where p.tenant_id = t.id and p.taken_on = current_date and p.mark = 'present') x)
    else
      (select count(*) from attendance a where a.tenant_id = t.id and a.taken_on = current_date and a.mark = 'present')
    end,
    (select count(*) from attendance_afternoon p where p.tenant_id = t.id and p.taken_on = current_date and p.mark = 'present'),
    (select coalesce(sum(fi.total_cents), 0) from fee_invoices fi where fi.tenant_id = t.id),
    (select coalesce(sum(fi.paid_cents), 0) from fee_invoices fi where fi.tenant_id = t.id),
    now()
  from tenants t
  where t.id = p_tenant_id
  on conflict (tenant_id) do update set
    organization_id = excluded.organization_id,
    name = excluded.name,
    institution_type = excluded.institution_type,
    higher_ed_subtype = excluded.higher_ed_subtype,
    delivery_mode = excluded.delivery_mode,
    status = excluded.status,
    active_students = excluded.active_students,
    present_today = excluded.present_today,
    present_today_pm = excluded.present_today_pm,
    fees_billed_cents = excluded.fees_billed_cents,
    fees_collected_cents = excluded.fees_collected_cents,
    updated_at = now();
end $$;

-- ---------------------------------------------------------------- the sick bay (decisions E, L)
-- As 20261101300000, except: the day and the session come from the school's own time zone; an afternoon mark goes to the afternoon
-- register; a morning mark is also carried into that day's afternoon register when the school takes one (sent home, to hospital or
-- admitted, the learner is not back for the afternoon). Each register keeps one entry per learner (the keys), so marking again
-- updates, never duplicates.
create or replace function medical_mark_attendance(p_visit_id uuid, p_mark attendance_mark) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_visit   sick_bay_visits%rowtype;
  v_class   uuid;
  v_term    uuid;
  v_at      timestamptz;
  v_day     date;
  v_session text;
  v_note    text;
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
  v_at := coalesce(v_visit.time_out, v_visit.time_in);
  v_day := (v_at at time zone coalesce((select t.timezone from tenants t where t.id = v_visit.tenant_id), 'Africa/Nairobi'))::date;
  v_session := attendance_session_at(v_visit.tenant_id, v_at);
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

  if v_session = 'morning' then
    insert into attendance (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark, note)
    values (v_visit.tenant_id, v_visit.student_id, v_class, v_term, auth.uid(), v_day, p_mark, v_note)
    on conflict (student_id, taken_on) do update set mark = excluded.mark, note = excluded.note, taken_by = excluded.taken_by;
  end if;
  -- the afternoon: the mark's own session, or carried over from the morning
  if v_session = 'afternoon' or attendance_afternoon_enabled(v_visit.tenant_id) then
    insert into attendance_afternoon (tenant_id, student_id, class_id, term_id, taken_by, taken_on, mark, note)
    values (v_visit.tenant_id, v_visit.student_id, v_class, v_term, auth.uid(), v_day, p_mark, v_note)
    on conflict (student_id, taken_on) do update set mark = excluded.mark, note = excluded.note, taken_by = excluded.taken_by;
  end if;

  perform set_config('figbloom.medical_attendance', 'on', true);
  update sick_bay_visits set attendance_mark = p_mark, attendance_marked_at = now() where id = v_visit.id;
  perform set_config('figbloom.medical_attendance', 'off', true);
end $$;

-- ---------------------------------------------------------------- who may call what
-- The helpers answer for any school id they are given: only the database itself (triggers, the functions above) runs them.
revoke execute on function
  attendance_afternoon_enabled(uuid), attendance_percentage_mode(uuid), attendance_session_at(uuid, timestamptz),
  attendance_counted(uuid, uuid), attendance_afternoon_allowed(), attendance_settings_touch()
  from public, anon, authenticated;
grant execute on function attendance_session_at(uuid, timestamptz), attendance_counted(uuid, uuid) to service_role;
