-- Leave run by Figbloom HR (Phase 2 step 2a), Schools' part (SCHOOLS_HR_LEAVE_CONTRACT.md section 3).
--
--   At a school where HR leave is on, staff apply for leave in Schools but HR keeps it: the leave page uses HR's
--   form, balances and approval chain through the my-hr function, approvers decide on a "Leave to approve" page
--   (my-hr, as their own HR user), and HR's decision comes back as an event: hr.leave.approved / hr.leave.cancelled,
--   through the platform relay, to the platform-events function. That event writes the same leave_requests row the
--   office's approval writes today (status 'approved'), so everything that reads approved leave runs unchanged:
--   cover planning (apps/web/src/lib/coverage.ts reads approved leave_requests), the affected lessons, the
--   Dashboard's "Needs cover" card and the timetable's flags. The teacher gets the same in-app notice the office's
--   approval sends ("Your leave request was approved"), and a cancellation the matching one.
--
--   Switch: platform_settings 'HR_LEAVE_ENABLED' (off). HR leave is on for a school when the switch is on AND HR is
--   on for the school: the platform knows the school (platform_links 'tenant') and the platform's latest answer
--   about HR for it (platform_module_status, written by open-hr) is not a target_not_enabled / target_not_linked
--   "no". Unlike the HR & Payroll item and My HR, that "no" doesn't wear off after an hour: which leave form a
--   school uses must not flip back and forth; the next answer (a click on HR & Payroll) changes it.
--   While it's on for a school, nobody there can file a Schools-only request (the old form is hidden, and the
--   database refuses one from an older app). Schools without HR keep the old form and the office's review exactly
--   as before.
--
--   leave_requests holds HR's rows too: source 'hr', hr_application_id (unique per school), HR's employee number,
--   leave type, half day and days. Only the definer functions below write them (called by platform-events with the
--   service role); nobody signed in can insert a row with source 'hr', change one, or set the export mark.
--
--   hr_leave_access() is the one rule for the web and for my-hr (as the caller): the leave page's mode and whether
--   the person gets "Leave to approve" (the school's admins, and staff holding the leave or the fees area: the
--   head teacher, deputy, bursar). HR decides who actually has applications to approve.
--
--   platform_hr_leave_event() applies one delivery: each delivery id once (platform_event_deliveries), and each
--   application in order (an advisory lock per application, and the event's occurred_at: an older event than the
--   last one applied is acknowledged as 'stale'). A date change is cancelled (old dates) + approved (new dates)
--   with the same application id: a cancel naming dates the row no longer has is stale too, so the two can arrive
--   in either order. A cancel for an application Schools hasn't seen is kept as a cancelled row, so a late
--   approval of it is stale. Switch: PLATFORM_EVENTS_ENABLED and HR_LEAVE_ENABLED: until both are on, verified,
--   recorded and acknowledged, not applied.
--
--   History export (platform-sync leave_history_import): platform_leave_history() lists a school's approved
--   Schools leave not exported yet, for staff HR knows (their schools.staff event was delivered);
--   platform_leave_history_mark() marks what HR accepted, so a second run sends nothing twice.
--
-- No new table. supabase/rls-checks/leave_via_hr.sql checks it.

insert into platform_settings (key, value) values ('HR_LEAVE_ENABLED', 'false') on conflict (key) do nothing;

create or replace function hr_leave_enabled() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select value = 'true'::jsonb from platform_settings where key = 'HR_LEAVE_ENABLED'), false)
$$;

-- HR leave is on for this school (see the top).
create or replace function hr_leave_on(p_tenant_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select hr_leave_enabled()
     and exists (select 1 from platform_links where kind = 'tenant' and local_id = p_tenant_id)
     and not exists (select 1 from platform_module_status s
                      where s.tenant_id = p_tenant_id and s.module = 'hr' and not s.enabled
                        and s.reason in ('target_not_enabled', 'target_not_linked'))
$$;

-- The caller's own: {"status": not_staff | off | not_linked | not_enabled | available, "approver": boolean}.
create or replace function hr_leave_access() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_role app_role;
  v_status text;
begin
  select p.tenant_id, p.role into v_tenant, v_role
    from profiles p
    join tenants t on t.id = p.tenant_id
   where p.id = auth.uid()
     and platform_is_staff_role(p.role)
     and p.archived_at is null
     and t.status is distinct from 'suspended';
  if v_tenant is null then return jsonb_build_object('status', 'not_staff', 'approver', false); end if;
  if not hr_leave_enabled() then
    v_status := 'off';
  elsif not exists (select 1 from platform_links where kind = 'tenant' and local_id = v_tenant) then
    v_status := 'not_linked';
  elsif not hr_leave_on(v_tenant) then
    v_status := 'not_enabled';
  else
    v_status := 'available';
  end if;
  return jsonb_build_object(
    'status', v_status,
    'approver', v_role = 'school_admin' or has_perm(v_tenant, 'leave') or has_perm(v_tenant, 'fees'));
end $$;

-- ------------------------------------------------------------ leave_requests: HR's rows
alter table leave_requests
  add column source             text not null default 'schools' check (source in ('schools', 'hr')),
  add column hr_application_id  text check (hr_application_id is null or length(hr_application_id) between 1 and 100),
  add column hr_employee_number text check (hr_employee_number is null or length(hr_employee_number) <= 100),
  add column hr_leave_type      text check (hr_leave_type is null or length(hr_leave_type) <= 100),
  add column half_day           boolean not null default false,
  add column days               numeric(6, 2) check (days is null or days >= 0),
  -- the occurred_at of the last HR event applied to the row (older ones are stale)
  add column hr_event_at        timestamptz,
  -- a Schools request sent to HR's history import (platform-sync leave_history_import)
  add column hr_exported_at     timestamptz,
  add constraint leave_requests_hr_rows check ((source = 'hr') = (hr_application_id is not null)),
  add constraint leave_requests_exported_schools_only check (hr_exported_at is null or source = 'schools');
create unique index leave_requests_hr_application on leave_requests (tenant_id, hr_application_id);

-- 20261031000001's guard, plus: HR's rows, HR's columns and the export mark are written only by the functions below
-- (auth.uid() is null for them), and a school running leave through HR takes no Schools-only requests. Security
-- definer so it can ask hr_leave_on(), which signed-in people can't call.
create or replace function guard_leave_review() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;

  if tg_op = 'INSERT' then
    if new.source <> 'schools' or new.hr_application_id is not null or new.hr_employee_number is not null
       or new.hr_leave_type is not null or new.half_day or new.days is not null or new.hr_event_at is not null
       or new.hr_exported_at is not null then
      raise exception 'Leave from Figbloom HR is recorded by HR only.' using errcode = '42501';
    end if;
    if hr_leave_on(new.tenant_id) then
      raise exception 'This school handles leave in Figbloom HR. Apply from the Leave page.' using errcode = '42501';
    end if;
  else
    if old.source = 'hr' then
      raise exception 'Leave approved in Figbloom HR is changed in HR only.' using errcode = '42501';
    end if;
    if new.source is distinct from old.source or new.hr_application_id is distinct from old.hr_application_id
       or new.hr_employee_number is distinct from old.hr_employee_number or new.hr_leave_type is distinct from old.hr_leave_type
       or new.half_day is distinct from old.half_day or new.days is distinct from old.days
       or new.hr_event_at is distinct from old.hr_event_at or new.hr_exported_at is distinct from old.hr_exported_at then
      raise exception 'Leave from Figbloom HR is recorded by HR only.' using errcode = '42501';
    end if;
  end if;

  if has_perm(coalesce(old.tenant_id, new.tenant_id), 'leave') then return new; end if;

  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.reviewed_by is not null or new.reviewed_at is not null or new.review_note is not null then
      raise exception 'A leave request starts pending. Only the office reviews it.' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.reviewed_by is distinct from old.reviewed_by
     or new.reviewed_at is distinct from old.reviewed_at
     or new.review_note is distinct from old.review_note
     or new.teacher_id is distinct from old.teacher_id
     or new.tenant_id is distinct from old.tenant_id then
    raise exception 'Only the office reviews leave.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (old.status = 'pending' and new.status = 'cancelled') then
    raise exception 'You can withdraw a pending leave request, but only the office approves or rejects it.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function guard_leave_review() from public, anon, authenticated;

-- ------------------------------------------------------------ receiving hr.leave.approved / hr.leave.cancelled
-- The in-app notice to the person, as the office's approval sends it (apps/web/src/screens/admin/Leave.tsx), from
-- the school's first admin (an announcement needs an author). Nothing when the school has no admin.
create or replace function hr_leave_notice(p_tenant_id uuid, p_to uuid, p_subject text, p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_author uuid;
begin
  select id into v_author from profiles
   where tenant_id = p_tenant_id and role = 'school_admin' and archived_at is null
   order by created_at, id limit 1;
  if v_author is null then return; end if;
  insert into announcements (tenant_id, author_id, subject, body, audience, channels, published_at)
  values (p_tenant_id, v_author, p_subject, p_body, jsonb_build_object('kind', 'user', 'user_id', p_to), array['in_app'], now());
end $$;

-- outcomes: duplicate | not_enabled | not_found | tenant_mismatch | not_staff | person_mismatch | overlaps (refusals
-- are not recorded: a re-drive is looked at afresh) | approved | updated | already_approved | cancelled |
-- already_cancelled | cancelled_unseen | stale
create or replace function platform_hr_leave_event(
  p_delivery_id text, p_event_id text, p_event_type text, p_tenant_id uuid, p_profile_id uuid,
  p_application_id text, p_employee_number text, p_leave_type text, p_start date, p_end date,
  p_half_day boolean default false, p_days numeric default null, p_occurred_at timestamptz default null,
  p_apply boolean default true
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p profiles;
  r leave_requests;
  o leave_requests;
  v_exists boolean;
  v_outcome text;
  v_half boolean := coalesce(p_half_day, false);
  v_at timestamptz := coalesce(p_occurred_at, now());
  v_today date := (now() at time zone 'Africa/Nairobi')::date;
  v_type text := nullif(left(btrim(coalesce(p_leave_type, '')), 100), '');
  v_cover int := 0;
  v_detail jsonb;
  c record;
begin
  perform set_config('figbloom.self_audited', 'true', true);  -- its own audit event (FIG-1326)
  if p_event_type is null or p_event_type not in ('hr.leave.approved', 'hr.leave.cancelled') then
    raise exception 'platform_hr_leave_event: unknown event type %', p_event_type using errcode = '22023';
  end if;
  if p_application_id is null or length(p_application_id) not between 1 and 100 then
    raise exception 'platform_hr_leave_event: an application id is needed' using errcode = '22023';
  end if;
  if p_start is null or p_end is null or p_end < p_start then
    raise exception 'platform_hr_leave_event: the dates are needed, start on or before end' using errcode = '22023';
  end if;
  v_detail := jsonb_build_object('application_id', p_application_id, 'employee_number', left(p_employee_number, 100),
    'leave_type', v_type, 'start_date', p_start, 'end_date', p_end, 'half_day', v_half, 'days', p_days, 'occurred_at', p_occurred_at);

  if exists (select 1 from platform_event_deliveries where delivery_id = p_delivery_id) then
    return jsonb_build_object('outcome', 'duplicate');
  end if;

  if not (coalesce(p_apply, false) and hr_leave_enabled()) then
    if not exists (select 1 from tenants where id = p_tenant_id) then
      return jsonb_build_object('outcome', 'not_enabled', 'recorded', false);
    end if;
    insert into platform_event_deliveries (delivery_id, event_type, event_id, tenant_id, profile_id, outcome, detail)
    values (p_delivery_id, p_event_type, p_event_id, p_tenant_id,
            (select id from profiles where id = p_profile_id and tenant_id = p_tenant_id), 'not_enabled', v_detail)
    on conflict (delivery_id) do nothing;
    return jsonb_build_object('outcome', case when found then 'not_enabled' else 'duplicate' end);
  end if;

  select * into p from profiles where id = p_profile_id;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if p.tenant_id is distinct from p_tenant_id then return jsonb_build_object('outcome', 'tenant_mismatch'); end if;
  if not platform_is_staff_role(p.role) then return jsonb_build_object('outcome', 'not_staff'); end if;

  -- one delivery of one application at a time
  perform pg_advisory_xact_lock(hashtextextended('hr-leave:' || p_tenant_id::text || ':' || p_application_id, 0));

  insert into platform_event_deliveries (delivery_id, event_type, event_id, tenant_id, profile_id, outcome, detail)
  values (p_delivery_id, p_event_type, p_event_id, p_tenant_id, p.id, 'received', v_detail)
  on conflict (delivery_id) do nothing;
  if not found then return jsonb_build_object('outcome', 'duplicate'); end if;

  select * into r from leave_requests where tenant_id = p_tenant_id and hr_application_id = p_application_id for update;
  v_exists := found;

  if v_exists and r.teacher_id <> p.id then
    delete from platform_event_deliveries where delivery_id = p_delivery_id;
    return jsonb_build_object('outcome', 'person_mismatch');
  end if;

  if v_exists and r.hr_event_at is not null and v_at < r.hr_event_at then
    v_outcome := 'stale';

  elsif p_event_type = 'hr.leave.approved' then
    if v_exists and r.status = 'approved' and r.starts_on = p_start and r.ends_on = p_end
       and r.half_day = v_half and r.days is not distinct from p_days then
      update leave_requests set hr_event_at = greatest(hr_event_at, v_at) where id = r.id;
      v_outcome := 'already_approved';
    else
      -- other approved leave on these days: HR and Schools disagree, a person looks at it
      select * into o from leave_requests
       where teacher_id = p.id and status = 'approved' and id is distinct from r.id
         and starts_on <= p_end and ends_on >= p_start
       order by starts_on limit 1;
      if found then
        delete from platform_event_deliveries where delivery_id = p_delivery_id;
        return jsonb_build_object('outcome', 'overlaps', 'starts_on', o.starts_on, 'ends_on', o.ends_on, 'source', o.source);
      end if;
      -- the person's own Schools requests still waiting for these days give way to HR's decision
      update leave_requests
         set status = 'cancelled', review_note = 'Replaced by leave approved in Figbloom HR', reviewed_at = now()
       where teacher_id = p.id and source = 'schools' and status = 'pending'
         and starts_on <= p_end and ends_on >= p_start;

      if v_exists then
        update leave_requests
           set starts_on = p_start, ends_on = p_end, status = 'approved', half_day = v_half, days = p_days,
               hr_leave_type = v_type, hr_employee_number = left(p_employee_number, 100), reason = coalesce(v_type, reason),
               reviewed_by = null, reviewed_at = now(), review_note = 'Approved in Figbloom HR', hr_event_at = v_at
         where id = r.id
        returning * into r;
        v_outcome := 'updated';
      else
        insert into leave_requests (tenant_id, teacher_id, starts_on, ends_on, reason, status, reviewed_at, review_note,
                                    source, hr_application_id, hr_employee_number, hr_leave_type, half_day, days, hr_event_at)
        values (p_tenant_id, p.id, p_start, p_end, v_type, 'approved', now(), 'Approved in Figbloom HR',
                'hr', p_application_id, left(p_employee_number, 100), v_type, v_half, p_days, v_at)
        returning * into r;
        v_outcome := 'approved';
      end if;
      perform hr_leave_notice(p_tenant_id, p.id, 'Your leave request was approved',
        format('Your leave from %s to %s has been approved.', to_char(p_start, 'FMDD Mon'), to_char(p_end, 'FMDD Mon')));
    end if;

  else  -- hr.leave.cancelled
    if not v_exists then
      -- kept, so a late approval of the same application is stale
      insert into leave_requests (tenant_id, teacher_id, starts_on, ends_on, reason, status, reviewed_at, review_note,
                                  source, hr_application_id, hr_employee_number, hr_leave_type, half_day, days, hr_event_at)
      values (p_tenant_id, p.id, p_start, p_end, v_type, 'cancelled', now(), 'Cancelled in Figbloom HR',
              'hr', p_application_id, left(p_employee_number, 100), v_type, v_half, p_days, v_at)
      returning * into r;
      v_outcome := 'cancelled_unseen';
    elsif r.status = 'cancelled' then
      update leave_requests set hr_event_at = greatest(hr_event_at, v_at) where id = r.id;
      v_outcome := 'already_cancelled';
    elsif r.starts_on <> p_start or r.ends_on <> p_end then
      -- it cancels dates the row no longer has: the new dates of a date change came first
      v_outcome := 'stale';
    else
      update leave_requests
         set status = 'cancelled', reviewed_at = now(), review_note = 'Cancelled in Figbloom HR', hr_event_at = v_at
       where id = r.id
      returning * into r;
      -- cover arranged for the days still ahead is undone, and whoever was covering is told, as when the office
      -- takes a cover away (apps/web/src/lib/coverage.ts assignCoverage)
      for c in
        select ca.id, ca.date, ca.start_time, ca.covering_teacher_id, cl.name as class_name, s.name as subject_name
          from coverage_assignments ca
          join classes cl on cl.id = ca.class_id
          join subjects s on s.id = ca.subject_id
         where ca.tenant_id = p_tenant_id and ca.absent_teacher_id = p.id
           and ca.date between greatest(p_start, v_today) and p_end
      loop
        if c.covering_teacher_id is not null then
          perform hr_leave_notice(p_tenant_id, c.covering_teacher_id,
            format('Cover cancelled — %s, %s', c.subject_name, c.class_name),
            format('You are no longer covering %s for %s at %s on %s. The usual teacher''s leave was cancelled.',
                   c.subject_name, c.class_name, c.start_time, to_char(c.date, 'YYYY-MM-DD')));
        end if;
        delete from coverage_assignments where id = c.id;
        v_cover := v_cover + 1;
      end loop;
      perform hr_leave_notice(p_tenant_id, p.id, 'Your leave was cancelled',
        format('Your leave from %s to %s has been cancelled in Figbloom HR.', to_char(p_start, 'FMDD Mon'), to_char(p_end, 'FMDD Mon')));
      v_outcome := 'cancelled';
    end if;
  end if;

  if v_outcome in ('approved', 'updated', 'cancelled') then
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    values (p_tenant_id, null, 'Figbloom HR (via Figbloom platform)',
            format('Leave for %s %s: %s to %s (Figbloom HR)', p.full_name,
                   case v_outcome when 'cancelled' then 'cancelled' when 'updated' then 'changed' else 'approved' end,
                   to_char(p_start, 'DD Mon YYYY'), to_char(p_end, 'DD Mon YYYY')),
            'operations',
            jsonb_build_object('table', 'leave_requests', 'op', case when v_outcome = 'approved' then 'insert' else 'update' end,
                               'via', 'Figbloom platform', 'leave_request_id', r.id, 'profile_ids', jsonb_build_array(p.id),
                               'application_id', p_application_id, 'employee_number', left(p_employee_number, 100),
                               'cover_removed', v_cover, 'delivery_id', p_delivery_id, 'event_id', p_event_id));
  end if;

  update platform_event_deliveries
     set outcome = v_outcome, detail = v_detail || jsonb_build_object('leave_request_id', r.id)
   where delivery_id = p_delivery_id;
  return jsonb_build_object('outcome', v_outcome, 'leave_request_id', r.id, 'cover_removed', v_cover);
end $$;

-- ------------------------------------------------------------ history export (platform-sync leave_history_import)
-- The school's approved Schools leave not exported yet. HR's records only for staff HR knows (their schools.staff
-- event was delivered); the others are counted by person, so the run says who is left out and why.
create or replace function platform_leave_history(p_tenant_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_records jsonb;
  v_unlinked jsonb;
begin
  if not exists (select 1 from tenants where id = p_tenant_id) then
    raise exception 'no school %', p_tenant_id using errcode = 'P0002';
  end if;
  with mine as (
    select l.*, pr.full_name,
           exists (select 1 from platform_sync_queue q
                    where q.kind = 'staff' and q.local_id = l.teacher_id and q.tenant_id = p_tenant_id
                      and q.done_at is not null and q.skipped is null) as linked
      from leave_requests l
      join profiles pr on pr.id = l.teacher_id
     where l.tenant_id = p_tenant_id and l.source = 'schools' and l.status = 'approved' and l.hr_exported_at is null
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'source_id', m.id, 'external_id', m.teacher_id, 'full_name', m.full_name,
           'leave_type_name', 'Imported from Schools', 'start_date', m.starts_on, 'end_date', m.ends_on,
           'days', (select count(*) from generate_series(m.starts_on, m.ends_on, interval '1 day') d where extract(isodow from d) < 6),
           'status', 'approved', 'reason', m.reason) order by m.starts_on, m.id) filter (where m.linked), '[]'::jsonb),
         coalesce(jsonb_agg(jsonb_build_object('external_id', m.teacher_id, 'full_name', m.full_name, 'source_id', m.id)
                  order by m.full_name, m.starts_on) filter (where not m.linked), '[]'::jsonb)
    into v_records, v_unlinked
    from mine m;
  return jsonb_build_object(
    'school_id', p_tenant_id,
    'school_linked', exists (select 1 from platform_links where kind = 'tenant' and local_id = p_tenant_id),
    'records', v_records,
    'not_linked', v_unlinked);
end $$;

-- Marks what HR accepted as exported (only the school's own approved Schools rows not marked yet); the count marked.
create or replace function platform_leave_history_mark(p_tenant_id uuid, p_ids uuid[]) returns integer
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  perform set_config('figbloom.self_audited', 'true', true);  -- its own audit event (FIG-1326)
  update leave_requests set hr_exported_at = now()
   where tenant_id = p_tenant_id and id = any (coalesce(p_ids, '{}')) and source = 'schools' and hr_exported_at is null;
  get diagnostics n = row_count;
  if n > 0 then
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    values (p_tenant_id, null, 'Figbloom (via Figbloom platform)',
            format('%s leave record%s sent to Figbloom HR', n, case when n = 1 then '' else 's' end), 'operations',
            jsonb_build_object('table', 'leave_requests', 'op', 'update', 'via', 'Figbloom platform', 'count', n));
  end if;
  return n;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'hr_leave_enabled()', 'hr_leave_on(uuid)', 'hr_leave_notice(uuid, uuid, text, text)',
    'platform_hr_leave_event(text, text, text, uuid, uuid, text, text, text, date, date, boolean, numeric, timestamptz, boolean)',
    'platform_leave_history(uuid)', 'platform_leave_history_mark(uuid, uuid[])'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
revoke execute on function hr_leave_access() from public, anon;
grant execute on function hr_leave_access() to authenticated, service_role;
