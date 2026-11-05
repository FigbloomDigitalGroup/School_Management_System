-- Figbloom Schools + HR, phase 1 ("Connect"), Schools' part (SCHOOLS_HR_PHASE1_CONTRACT.md section 3).
--
--   Staff events (Schools -> platform -> HR). Triggers on profiles queue a 'staff' row in the existing outbox,
--     platform_sync_queue, for teachers, drivers, other staff and school admins (org admins: not yet):
--       created  a new staff profile, or one restored from the archive (or given a staff role)
--       updated  a change of full_name, phone, staff_title, role, or of the real email (a synthetic login
--                address, *.figbloom.internal, is no email at all: it is sent as null, and changing one is no change)
--       left     archived (archive_staff(), or hr.employee.left), deleted, or no longer a staff role
--     platform-sync sends them as POST /events (type schools.staff.<event>, tenant_local_id = the school's
--     tenants.id) with the queue's retries, backoff and versions, exactly like registrations. As with
--     registrations, a row names the person and what is sent is read when it is sent; one pending row per
--     person, so a burst of edits sends one event. Each row carries its own event id (a uuid), stable across
--     retries of the same content and new whenever the content changes (the platform accepts a repeated id and
--     does not deliver it again, so a changed record needs a new one). Merging while pending: left wins;
--     a pending created stays created (HR has not heard of them yet); a restore after a pending left is created.
--
--   Two gates on sending, both checked when a row would be queued (platform_staff_enqueue):
--     platform_settings 'PLATFORM_STAFF_EVENTS_ENABLED' (off): while off nothing is queued at all, so no backlog of
--       personal data builds up (one codebase runs every environment; switch it on per database). staff_backfill
--       for real is refused while it is off; its dry run still lists.
--     only schools the platform knows: a school whose registration has been delivered (platform_links 'tenant').
--       If the platform still answers 404 for a staff event (not linked there), the row ends as
--       skipped = 'skipped_unlinked' (done, not retried) and platform-sync logs it.
--
--   Archiving staff. Schools had no staff archive (delete-account removes a profile only when nothing refers to
--     it). This adds one, the way learners are archived (20261105460000): profiles.archived_at/archived_by, and
--     the login banned (banned_until 100 years out, app_metadata flag "archived_staff", sessions ended); restoring
--     lifts exactly that ban. archive_staff()/restore_staff() are the school's own (the people area; an
--     administrator only by a full admin); platform_staff_left() is HR's (hr.employee.left, through the
--     platform-events function). Reactivating a suspended school does not lift an archived staff member's ban.
--
--   hr.employee.left (platform -> Schools). platform-events verifies the signature and calls
--     platform_staff_left(): every delivery id once (platform_event_deliveries), the profile must belong to the
--     school the delivery names, and it is archived with left_on. An archive that came from HR is not sent back
--     to HR as schools.staff.left. Switch: platform_settings 'PLATFORM_EVENTS_ENABLED' (off): verified,
--     recorded and acknowledged, not applied.
--
-- Backward compatible with the platform-sync deployed before this: platform_sync_claim(int) hands out only
-- organisations and schools, as before; the new platform-sync claims staff rows through platform_sync_claim_kinds().
-- supabase/rls-checks/platform_staff_events.sql checks it.

-- ------------------------------------------------------------ the archive
alter table profiles add column archived_at timestamptz;
alter table profiles add column archived_by uuid references profiles on delete set null;
alter table profiles add column left_on date;

-- Only the archive functions below (and the service role) set these; a person can't archive or restore themselves
-- through the profile_update_self policy, and an admin's plain profile update can't either.
create or replace function guard_profile_archive() returns trigger
language plpgsql set search_path = public as $$
begin
  if auth.uid() is null or coalesce(current_setting('figbloom.staff_archive', true), '') = 'true' then return new; end if;
  if tg_op = 'INSERT' then
    if new.archived_at is not null or new.archived_by is not null or new.left_on is not null then
      raise exception 'A new account can''t start archived.' using errcode = '42501';
    end if;
  elsif new.archived_at is distinct from old.archived_at or new.archived_by is distinct from old.archived_by
        or new.left_on is distinct from old.left_on then
    raise exception 'Archive or restore staff from Students & staff.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function guard_profile_archive() from public, anon, authenticated;
create trigger profiles_guard_archive before insert or update on profiles
  for each row execute function guard_profile_archive();

create or replace function set_staff_login_ban(p_profile_ids uuid[], p_ban boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_profile_ids is null or cardinality(p_profile_ids) = 0 then return; end if;
  if p_ban then
    update auth.users u
       set banned_until = now() + interval '100 years',
           raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb) || '{"archived_staff": true}'::jsonb
     where u.id = any (p_profile_ids);
    delete from auth.sessions where user_id = any (p_profile_ids);
  else
    update auth.users u
       set raw_app_meta_data = u.raw_app_meta_data - 'archived_staff',
           banned_until = case when u.raw_app_meta_data ->> 'suspended_with_school' = 'true' then u.banned_until else null end
     where u.id = any (p_profile_ids)
       and u.raw_app_meta_data ->> 'archived_staff' = 'true';
  end if;
end $$;
revoke execute on function set_staff_login_ban(uuid[], boolean) from public, anon, authenticated;

-- The school's own: staff it may manage (the people area; an administrator only by a full admin), never oneself.
create or replace function archive_staff(p_ids uuid[], p_left_on date default null) returns integer
language plpgsql security definer set search_path = public as $$
declare
  n int;
  v_ids uuid[];
begin
  perform set_config('figbloom.self_audited', 'true', true);  -- its own audit event (FIG-1326)
  if p_ids is null or cardinality(p_ids) = 0 then return 0; end if;
  if exists (select 1 from profiles p where p.id = any (p_ids)
              and (p.role not in ('teacher', 'driver', 'staff', 'school_admin')
                   or not has_perm(p.tenant_id, 'people')
                   or (p.role = 'school_admin' and not may_administer(p.tenant_id))
                   or p.id = auth.uid()))
     or (select count(*) from profiles where id = any (p_ids)) <> (select count(distinct x) from unnest(p_ids) x) then
    raise exception 'You can only archive staff at a school you administer.' using errcode = '42501';
  end if;

  perform set_config('figbloom.staff_archive', 'true', true);
  with changed as (
    update profiles
       set archived_at = now(), archived_by = auth.uid(),
           left_on = coalesce(p_left_on, (now() at time zone 'Africa/Nairobi')::date)
     where id = any (p_ids) and archived_at is null
    returning id, tenant_id, full_name
  ), logged as (
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    select tenant_id, auth.uid(), my_actor_label(),
           format('%s staff member%s archived', count(*), case when count(*) = 1 then '' else 's' end), 'provisioning',
           jsonb_build_object('profile_ids', jsonb_agg(id), 'names', jsonb_agg(full_name))
      from changed group by tenant_id
    returning 1
  )
  select count(*), array_agg(id) into n, v_ids from changed;
  perform set_config('figbloom.staff_archive', '', true);
  perform set_staff_login_ban(v_ids, true);
  return n;
end $$;

create or replace function restore_staff(p_ids uuid[]) returns integer
language plpgsql security definer set search_path = public as $$
declare
  n int;
  v_ids uuid[];
begin
  perform set_config('figbloom.self_audited', 'true', true);  -- its own audit event (FIG-1326)
  if p_ids is null or cardinality(p_ids) = 0 then return 0; end if;
  if exists (select 1 from profiles p where p.id = any (p_ids)
              and (p.role not in ('teacher', 'driver', 'staff', 'school_admin')
                   or not has_perm(p.tenant_id, 'people')
                   or (p.role = 'school_admin' and not may_administer(p.tenant_id))
                   or p.id = auth.uid())) then
    raise exception 'You can only restore staff at a school you administer.' using errcode = '42501';
  end if;

  perform set_config('figbloom.staff_archive', 'true', true);
  with changed as (
    update profiles set archived_at = null, archived_by = null, left_on = null
     where id = any (p_ids) and archived_at is not null
    returning id, tenant_id, full_name
  ), logged as (
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    select tenant_id, auth.uid(), my_actor_label(),
           format('%s staff member%s restored', count(*), case when count(*) = 1 then '' else 's' end), 'provisioning',
           jsonb_build_object('profile_ids', jsonb_agg(id), 'names', jsonb_agg(full_name))
      from changed group by tenant_id
    returning 1
  )
  select count(*), array_agg(id) into n, v_ids from changed;
  perform set_config('figbloom.staff_archive', '', true);
  perform set_staff_login_ban(v_ids, false);
  return n;
end $$;
revoke execute on function archive_staff(uuid[], date) from public, anon;
revoke execute on function restore_staff(uuid[]) from public, anon;
grant execute on function archive_staff(uuid[], date) to authenticated;
grant execute on function restore_staff(uuid[]) to authenticated;

-- Reactivating a school lifts its ban, but not the ban of a learner or a staff member archived meanwhile
-- (20261105460000, plus archived_staff).
create or replace function sync_tenant_suspension() returns trigger
language plpgsql security definer set search_path = public, auth as $$
begin
  if new.status = 'suspended' then
    update auth.users u
       set banned_until = now() + interval '100 years',
           raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb) || '{"suspended_with_school": true}'::jsonb
     where u.id in (select p.id from profiles p where p.tenant_id = new.id and p.role <> 'super_admin')
       and (u.banned_until is null or u.banned_until < now());
  else
    update auth.users u
       set banned_until = case when u.raw_app_meta_data ->> 'archived_learner' = 'true'
                                  or u.raw_app_meta_data ->> 'archived_staff' = 'true' then u.banned_until else null end,
           raw_app_meta_data = u.raw_app_meta_data - 'suspended_with_school'
     where u.id in (select p.id from profiles p where p.tenant_id = new.id)
       and u.raw_app_meta_data ->> 'suspended_with_school' = 'true';
  end if;
  return new;
end $$;

-- ------------------------------------------------------------ the outbox learns 'staff'
alter table platform_sync_queue drop constraint platform_sync_queue_kind_check;
alter table platform_sync_queue add constraint platform_sync_queue_kind_check check (kind in ('organization', 'tenant', 'staff'));
alter table platform_sync_queue
  add column event       text check (event in ('created', 'updated', 'left')),
  add column event_id    uuid,
  add column tenant_id   uuid,
  add column occurred_at timestamptz,
  add column left_on     date,
  -- why a row ended without being sent (done_at set): 'skipped_unlinked'
  add column skipped     text;
alter table platform_sync_queue add constraint platform_sync_queue_staff_event
  check ((kind = 'staff') = (event is not null and event_id is not null and tenant_id is not null and occurred_at is not null));
create unique index platform_sync_queue_event_id on platform_sync_queue (event_id) where event_id is not null;

-- 'teacher', 'driver', 'staff', 'school_admin' (org_admin: later, per school of its organisation)
create or replace function platform_is_staff_role(p_role app_role) returns boolean
language sql immutable set search_path = public as $$
  select p_role::text in ('teacher', 'driver', 'staff', 'school_admin')
$$;

-- An address HR may use: null for none, and for Schools' synthetic sign-in addresses (…@login.<slug>.figbloom.internal)
-- or anything else on a reserved, undeliverable domain.
create or replace function platform_real_email(p_email text) returns text
language sql immutable set search_path = public as $$
  select case
    when nullif(trim(p_email), '') is null then null
    when lower(trim(p_email)) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then null
    when lower(trim(p_email)) ~ '\.(internal|invalid)$' then null
    else lower(trim(p_email))
  end
$$;

-- The sending switch: off by default. Switch on per database:
--   update platform_settings set value = 'true', updated_at = now() where key = 'PLATFORM_STAFF_EVENTS_ENABLED';
insert into platform_settings (key, value) values ('PLATFORM_STAFF_EVENTS_ENABLED', 'false') on conflict (key) do nothing;

create or replace function platform_staff_events_enabled() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select value = 'true'::jsonb from platform_settings where key = 'PLATFORM_STAFF_EVENTS_ENABLED'), false)
$$;

-- A school the platform knows: its registration has been delivered (platform_sync_done / platform_record_link).
create or replace function platform_school_linked(p_tenant_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_links where kind = 'tenant' and local_id = p_tenant_id)
$$;

-- Queues one staff event, merged into the person's pending row if there is one; nothing while sending is
-- switched off or the platform doesn't know the school. Never blocks the change itself.
create or replace function platform_staff_enqueue(p_profile_id uuid, p_event text, p_tenant_id uuid, p_left_on date default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not platform_staff_events_enabled() or not platform_school_linked(p_tenant_id) then return; end if;
  insert into platform_sync_queue (kind, local_id, event, event_id, tenant_id, occurred_at, left_on)
  values ('staff', p_profile_id, p_event, gen_random_uuid(), p_tenant_id, now(), case when p_event = 'left' then p_left_on end)
  on conflict (kind, local_id) where done_at is null do update
    set version = platform_sync_queue.version + 1,
        -- new content, new id: the platform drops a repeated id without delivering it
        event_id = gen_random_uuid(),
        event = case when excluded.event = 'left' then 'left'
                     when platform_sync_queue.event in ('created', 'left') then 'created'
                     else excluded.event end,
        tenant_id = excluded.tenant_id,
        occurred_at = now(),
        left_on = case when excluded.event = 'left' then excluded.left_on end,
        next_attempt_at = least(platform_sync_queue.next_attempt_at, now());
end $$;
revoke execute on function platform_staff_enqueue(uuid, text, uuid, date) from public, anon, authenticated;
grant execute on function platform_staff_enqueue(uuid, text, uuid, date) to service_role;

create or replace function platform_staff_queue_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  was boolean;
  now_staff boolean;
  v_event text;
  v_left date;
begin
  -- an archive that came from HR (hr.employee.left) is not echoed back to HR
  if coalesce(current_setting('figbloom.platform_event', true), '') = 'true' then return null; end if;
  begin
    if tg_op = 'INSERT' then
      if new.tenant_id is not null and platform_is_staff_role(new.role) and new.archived_at is null then
        perform platform_staff_enqueue(new.id, 'created', new.tenant_id);
      end if;
    elsif tg_op = 'DELETE' then
      -- a school being deleted takes its staff with it: nothing to tell HR about each of them
      if old.tenant_id is not null and platform_is_staff_role(old.role) and old.archived_at is null
         and exists (select 1 from tenants where id = old.tenant_id) then
        perform platform_staff_enqueue(old.id, 'left', old.tenant_id, (now() at time zone 'Africa/Nairobi')::date);
      end if;
    else
      if new.tenant_id is null then return null; end if;
      was := platform_is_staff_role(old.role) and old.archived_at is null;
      now_staff := platform_is_staff_role(new.role) and new.archived_at is null;
      if was and not now_staff then
        v_event := 'left';
        v_left := coalesce(new.left_on, (coalesce(new.archived_at, now()) at time zone 'Africa/Nairobi')::date);
      elsif now_staff and not was then
        v_event := 'created';
      elsif now_staff and (new.full_name is distinct from old.full_name
                           or new.phone is distinct from old.phone
                           or new.staff_title is distinct from old.staff_title
                           or new.role is distinct from old.role
                           or platform_real_email(new.email) is distinct from platform_real_email(old.email)) then
        v_event := 'updated';
      end if;
      if v_event is not null then
        perform platform_staff_enqueue(new.id, v_event, new.tenant_id, v_left);
      end if;
    end if;
  exception when others then
    -- telling HR is never worth failing a hire or an edit for; staff_backfill catches anything missed
    raise warning 'platform_sync_queue: could not queue staff %: %', coalesce(new.id, old.id), sqlerrm;
  end;
  return null;
end $$;
revoke execute on function platform_staff_queue_change() from public, anon, authenticated;

create trigger profiles_platform_staff_insert after insert on profiles
  for each row execute function platform_staff_queue_change();
create trigger profiles_platform_staff_update after update of full_name, phone, email, staff_title, role, archived_at on profiles
  for each row execute function platform_staff_queue_change();
create trigger profiles_platform_staff_delete after delete on profiles
  for each row execute function platform_staff_queue_change();

-- What schools.staff.created / .updated carries, read when it is sent (contract section 2):
-- {tenant_id, current (a staff role and not archived), data: {person_id, full_name, phone, email, role, job_title}}.
-- null when the profile is gone.
create or replace function platform_staff_event_data(p_profile_id uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'tenant_id', p.tenant_id,
    'current', platform_is_staff_role(p.role) and p.archived_at is null,
    'data', jsonb_build_object(
      'person_id', p.id,
      'full_name', p.full_name,
      'phone', nullif(trim(p.phone), ''),
      'email', coalesce(platform_real_email(p.email), platform_real_email(u.email)),
      'role', p.role::text,
      'job_title', coalesce(nullif(trim(p.staff_title), ''),
                            case p.role::text when 'teacher' then 'Teacher' when 'driver' then 'Driver'
                                              when 'staff' then 'Staff' when 'school_admin' then 'School administrator'
                                              else initcap(replace(p.role::text, '_', ' ')) end)))
    from profiles p left join auth.users u on u.id = p.id
   where p.id = p_profile_id
$$;

-- staff_backfill: every current staff member of one school. A dry run lists them (and says whether it could
-- run); otherwise each gets a schools.staff.created in the queue (sent by the next sync, with its retries), merged
-- into any pending row. Refused while sending is switched off, or for a school the platform doesn't know yet.
create or replace function platform_staff_backfill(p_tenant_id uuid, p_dry_run boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_staff jsonb;
  r record;
begin
  if not exists (select 1 from tenants where id = p_tenant_id) then
    raise exception 'no school %', p_tenant_id using errcode = 'P0002';
  end if;
  select coalesce(jsonb_agg(platform_staff_event_data(p.id) -> 'data' order by p.created_at, p.id), '[]'::jsonb) into v_staff
    from profiles p
   where p.tenant_id = p_tenant_id and platform_is_staff_role(p.role) and p.archived_at is null;
  if not p_dry_run and not platform_staff_events_enabled() then
    raise exception 'staff_events_disabled: sending staff events is switched off (platform_settings PLATFORM_STAFF_EVENTS_ENABLED); nothing was queued'
      using errcode = 'P0001';
  end if;
  if not p_dry_run and not platform_school_linked(p_tenant_id) then
    raise exception 'school_not_linked: the platform does not know this school yet (its registration has not been delivered); nothing was queued'
      using errcode = 'P0001';
  end if;
  if not p_dry_run then
    for r in select p.id from profiles p
              where p.tenant_id = p_tenant_id and platform_is_staff_role(p.role) and p.archived_at is null
              order by p.created_at, p.id loop
      perform platform_staff_enqueue(r.id, 'created', p_tenant_id);
    end loop;
  end if;
  return jsonb_build_object('school_id', p_tenant_id, 'dry_run', p_dry_run, 'count', jsonb_array_length(v_staff), 'staff', v_staff,
                            'sending_enabled', platform_staff_events_enabled(), 'school_linked', platform_school_linked(p_tenant_id));
end $$;

-- ------------------------------------------------------------ claiming and completing, kind by kind
-- Organisations first (a school needs its organisation registered), then schools, then staff events; oldest first.
create or replace function platform_sync_claim_kinds(p_limit int default 50, p_kinds text[] default array['organization', 'tenant', 'staff'])
returns setof platform_sync_queue
language plpgsql security definer set search_path = public as $$
begin
  return query
  with due as (
    select q.id from platform_sync_queue q
     where q.done_at is null and q.next_attempt_at <= now()
       and (q.locked_until is null or q.locked_until < now())
       and q.kind = any (p_kinds)
     order by case q.kind when 'organization' then 0 when 'tenant' then 1 else 2 end, q.id
     limit greatest(p_limit, 0)
     for update skip locked
  ), claimed as (
    update platform_sync_queue q set locked_until = now() + interval '5 minutes', attempts = q.attempts + 1
      from due where q.id = due.id
    returning q.*
  )
  select * from claimed c order by case c.kind when 'organization' then 0 when 'tenant' then 1 else 2 end, c.id;
end $$;

-- What the platform-sync deployed before this migration calls: registrations only, as before, so it never
-- mistakes a staff row for a school.
create or replace function platform_sync_claim(p_limit int default 50) returns setof platform_sync_queue
language sql security definer set search_path = public as $$
  select * from platform_sync_claim_kinds(p_limit, array['organization', 'tenant'])
$$;

-- As before for registrations. A staff event has no platform link; when it changed while on its way, the
-- version that was sent is on the platform, so a pending 'created' goes again as 'updated'.
create or replace function platform_sync_done(p_id bigint, p_version int, p_platform_id text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  r platform_sync_queue;
begin
  update platform_sync_queue set done_at = now(), locked_until = null, last_error = null
   where id = p_id and version = p_version and done_at is null returning * into r;
  if not found then
    update platform_sync_queue
       set locked_until = null, next_attempt_at = now(),
           event = case when kind = 'staff' and event = 'created' then 'updated' else event end
     where id = p_id and done_at is null returning * into r;
    if r.id is not null and r.kind <> 'staff' then
      perform platform_record_link(r.kind, r.local_id, p_platform_id);
    end if;
    return false;
  end if;
  if r.kind <> 'staff' then
    perform platform_record_link(r.kind, r.local_id, p_platform_id);
  end if;
  return true;
end $$;

-- A staff event the platform can't place (404: the school isn't linked there): done, not retried, and why.
create or replace function platform_sync_skipped(p_id bigint, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update platform_sync_queue set done_at = now(), locked_until = null, skipped = left(p_reason, 100), last_error = null
   where id = p_id and done_at is null and kind = 'staff';
end $$;

-- ------------------------------------------------------------ receiving hr.employee.left (platform-events)
insert into platform_settings (key, value) values ('PLATFORM_EVENTS_ENABLED', 'false') on conflict (key) do nothing;

create or replace function platform_events_enabled() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select value = 'true'::jsonb from platform_settings where key = 'PLATFORM_EVENTS_ENABLED'), false)
$$;

-- Every event delivery applied or acknowledged, so a repeated one is not applied twice. Rejections
-- (unknown person, another school's) are not recorded here: the platform alarms on them, and a re-drive is
-- looked at afresh.
create table platform_event_deliveries (
  delivery_id     text primary key,
  event_type      text not null,
  event_id        text,
  tenant_id       uuid,
  profile_id      uuid,
  outcome         text not null,
  detail          jsonb,
  received_at     timestamptz not null default now()
);
alter table platform_event_deliveries enable row level security;  -- no policies: the service role and SQL only
revoke all on platform_event_deliveries from anon, authenticated;

-- hr.employee.left: outcomes duplicate | not_enabled | archived | already_archived | not_found | tenant_mismatch | not_staff.
create or replace function platform_staff_left(
  p_delivery_id text, p_event_id text, p_tenant_id uuid, p_profile_id uuid, p_left_on date,
  p_employee_number text default null, p_apply boolean default true
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  p profiles;
  v_detail jsonb := jsonb_build_object('employee_number', left(p_employee_number, 100), 'left_on', p_left_on);
begin
  if exists (select 1 from platform_event_deliveries where delivery_id = p_delivery_id) then
    return jsonb_build_object('outcome', 'duplicate');
  end if;

  if not p_apply then
    insert into platform_event_deliveries (delivery_id, event_type, event_id, tenant_id, profile_id, outcome, detail)
    values (p_delivery_id, 'hr.employee.left', p_event_id, p_tenant_id, p_profile_id, 'not_enabled', v_detail)
    on conflict (delivery_id) do nothing;
    return jsonb_build_object('outcome', case when found then 'not_enabled' else 'duplicate' end);
  end if;

  select * into p from profiles where id = p_profile_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if p.tenant_id is distinct from p_tenant_id then return jsonb_build_object('outcome', 'tenant_mismatch'); end if;
  if not platform_is_staff_role(p.role) then return jsonb_build_object('outcome', 'not_staff'); end if;

  insert into platform_event_deliveries (delivery_id, event_type, event_id, tenant_id, profile_id, outcome, detail)
  values (p_delivery_id, 'hr.employee.left', p_event_id, p_tenant_id, p_profile_id, 'received', v_detail)
  on conflict (delivery_id) do nothing;
  if not found then return jsonb_build_object('outcome', 'duplicate'); end if;

  if p.archived_at is not null then
    update platform_event_deliveries set outcome = 'already_archived' where delivery_id = p_delivery_id;
    return jsonb_build_object('outcome', 'already_archived');
  end if;

  perform set_config('figbloom.self_audited', 'true', true);   -- its own audit event (FIG-1326)
  perform set_config('figbloom.staff_archive', 'true', true);
  perform set_config('figbloom.platform_event', 'true', true);  -- HR knows: not sent back as schools.staff.left
  update profiles set archived_at = now(), archived_by = null,
                      left_on = coalesce(p_left_on, (now() at time zone 'Africa/Nairobi')::date)
   where id = p.id;
  perform set_config('figbloom.platform_event', '', true);
  perform set_config('figbloom.staff_archive', '', true);
  perform set_staff_login_ban(array[p.id], true);

  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (p.tenant_id, null, 'Figbloom HR (via Figbloom platform)',
          format('Staff member %s archived: left on %s (recorded in Figbloom HR)', p.full_name,
                 to_char(coalesce(p_left_on, (now() at time zone 'Africa/Nairobi')::date), 'DD Mon YYYY')),
          'provisioning',
          jsonb_build_object('table', 'profiles', 'op', 'update', 'via', 'Figbloom platform', 'profile_ids', jsonb_build_array(p.id),
                             'names', jsonb_build_array(p.full_name), 'left_on', p_left_on,
                             'employee_number', left(p_employee_number, 100), 'delivery_id', p_delivery_id, 'event_id', p_event_id));

  update platform_event_deliveries set outcome = 'archived' where delivery_id = p_delivery_id;
  return jsonb_build_object('outcome', 'archived');
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'platform_sync_claim_kinds(int, text[])', 'platform_sync_claim(int)', 'platform_sync_done(bigint, int, text)',
    'platform_staff_event_data(uuid)', 'platform_staff_backfill(uuid, boolean)',
    'platform_staff_left(text, text, uuid, uuid, date, text, boolean)', 'platform_events_enabled()',
    'platform_staff_events_enabled()', 'platform_school_linked(uuid)', 'platform_sync_skipped(bigint, text)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- (nothing is queued for today's staff here: platform-sync's staff_backfill does it, school by school, once HR is on)
