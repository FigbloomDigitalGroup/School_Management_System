-- Figbloom Schools registers its organisations and schools with the Figbloom
-- platform, and follows the platform's organisation decisions (design 5.8,
-- step 2; the platform side is figbloomHR-platform PR #20).
--
--   Registration (Schools -> platform). Creating or renaming an organisation
--     or school must never wait on, or fail because of, the platform. Triggers
--     on organizations and tenants put the record's id in platform_sync_queue
--     in the same transaction; the platform-sync edge function (every minute,
--     pg_cron + pg_net below) sends what is pending, organisations before
--     their schools, with retries and backoff. A row only names the record:
--     what is sent is read when it is sent, so a rename made before the first
--     send goes in the same call, and one pending row per record is enough.
--
--   Decisions (platform -> Schools). The platform-decisions edge function
--     verifies the platform's signature and calls
--     platform_apply_organization_decision(), which sets organizations.status
--     exactly as Schools' own console does: everything that enforces an
--     organisation's status (my_organization_tenant_ids(), 20261026080000,
--     and administersOrganization() in the edge functions) reads that column.
--     Schools' own status stays the enforcement; nothing calls the platform
--     on a request. platform-sync's hourly reconcile asks the platform for
--     organisations whose last decision might have been missed.
--
--   Switch-on. platform_settings 'PLATFORM_DECISIONS_ENABLED' (off). While
--     it is off nothing changes for anyone: decisions are verified and
--     acknowledged but not applied, and Schools' own console decides. Once
--     it is on, organizations.status changes only through the platform's
--     decisions (a trigger refuses any other change), and the console shows
--     the platform's status.
--
-- Organisation statuses gain 'rejected' (the platform's fourth decision).
-- Like 'pending' and 'suspended' it is simply not 'active', so the
-- organisation's admins have no access to its schools.
--
-- Everything here is for the service role (the edge functions) only, except
-- platform_decisions_enabled(), which the staff console reads.
-- supabase/rls-checks/platform_registration.sql checks it.

-- ------------------------------------------------------------ 'rejected'
alter table organizations drop constraint organizations_status_check;
alter table organizations add constraint organizations_status_check
  check (status in ('pending', 'active', 'suspended', 'rejected'));

-- ------------------------------------------------------------ the setting
create table platform_settings (
  key   text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
insert into platform_settings (key, value) values ('PLATFORM_DECISIONS_ENABLED', 'false');
alter table platform_settings enable row level security;  -- no policies: the service role and SQL only
revoke all on platform_settings from anon, authenticated;

create or replace function platform_decisions_enabled() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select value = 'true'::jsonb from platform_settings where key = 'PLATFORM_DECISIONS_ENABLED'), false)
$$;
revoke execute on function platform_decisions_enabled() from public, anon;
grant execute on function platform_decisions_enabled() to authenticated, service_role;

-- ------------------------------------------------------------ the outbox
create table platform_sync_queue (
  id              bigint generated always as identity primary key,
  kind            text not null check (kind in ('organization', 'tenant')),
  local_id        uuid not null,
  enqueued_at     timestamptz not null default now(),
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until    timestamptz,
  last_error      text,
  done_at         timestamptz
);
-- one pending row per record: it is read when sent, so a second one would send the same thing twice
create unique index platform_sync_queue_one_pending on platform_sync_queue (kind, local_id) where done_at is null;
create index platform_sync_queue_due on platform_sync_queue (next_attempt_at) where done_at is null;
alter table platform_sync_queue enable row level security;
revoke all on platform_sync_queue from anon, authenticated;

-- What the platform knows about each record: registered when, its own id.
create table platform_links (
  kind          text not null check (kind in ('organization', 'tenant')),
  local_id      uuid not null,
  platform_id   text,
  registered_at timestamptz not null default now(),
  primary key (kind, local_id)
);
alter table platform_links enable row level security;
revoke all on platform_links from anon, authenticated;

-- The last decision applied to each organisation, and when it was last checked.
create table platform_organization_decisions (
  organization_id uuid primary key references organizations on delete cascade,
  status          text not null,
  status_reason   text,
  decided_at      timestamptz,
  applied_at      timestamptz not null default now(),
  last_checked_at timestamptz,
  needs_check     boolean not null default false
);
alter table platform_organization_decisions enable row level security;
revoke all on platform_organization_decisions from anon, authenticated;

-- Every webhook delivery seen, so a repeated one is acknowledged and not applied twice.
create table platform_webhook_deliveries (
  delivery_id     text primary key,
  organization_id uuid,
  outcome         text not null,
  received_at     timestamptz not null default now()
);
alter table platform_webhook_deliveries enable row level security;
revoke all on platform_webhook_deliveries from anon, authenticated;

-- ------------------------------------------------------------ queueing (never blocks the change itself)
create or replace function platform_sync_enqueue(p_kind text, p_local_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into platform_sync_queue (kind, local_id) values (p_kind, p_local_id)
  on conflict (kind, local_id) where done_at is null do nothing;
end $$;
revoke execute on function platform_sync_enqueue(text, uuid) from public, anon, authenticated;
grant execute on function platform_sync_enqueue(text, uuid) to service_role;

create or replace function platform_sync_queue_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform platform_sync_enqueue(case tg_table_name when 'organizations' then 'organization' else 'tenant' end, new.id);
  exception when others then
    -- registering is never worth failing a sign-up or an edit for; the backfill catches anything missed
    raise warning 'platform_sync_queue: could not queue % %: %', tg_table_name, new.id, sqlerrm;
  end;
  return null;
end $$;
revoke execute on function platform_sync_queue_change() from public, anon, authenticated;

create trigger organizations_platform_sync after insert or update of name, contact_email on organizations
  for each row execute function platform_sync_queue_change();
create trigger tenants_platform_sync after insert or update of name, slug, organization_id on tenants
  for each row execute function platform_sync_queue_change();

-- ------------------------------------------------------------ sending (platform-sync)
-- Up to p_limit due rows, leased for 5 minutes so an overlapping run skips
-- them: organisations first (a school needs its organisation registered),
-- then oldest first.
create or replace function platform_sync_claim(p_limit int default 50) returns setof platform_sync_queue
language plpgsql security definer set search_path = public as $$
begin
  return query
  with due as (
    select q.id from platform_sync_queue q
     where q.done_at is null and q.next_attempt_at <= now()
       and (q.locked_until is null or q.locked_until < now())
     order by (q.kind = 'organization') desc, q.id
     limit greatest(p_limit, 0)
     for update skip locked
  )
  update platform_sync_queue q set locked_until = now() + interval '5 minutes', attempts = q.attempts + 1
    from due where q.id = due.id
  returning q.*;
end $$;

create or replace function platform_sync_done(p_id bigint, p_platform_id text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  r platform_sync_queue;
begin
  update platform_sync_queue set done_at = now(), locked_until = null, last_error = null
   where id = p_id and done_at is null returning * into r;
  if found then
    insert into platform_links (kind, local_id, platform_id) values (r.kind, r.local_id, p_platform_id)
    on conflict (kind, local_id) do update
      set platform_id = coalesce(excluded.platform_id, platform_links.platform_id), registered_at = now();
  end if;
end $$;

-- Backoff: 1, 2, 4, ... minutes, at most an hour (or the caller's delay, e.g. "after its organisation").
create or replace function platform_sync_failed(p_id bigint, p_error text, p_retry_in_seconds int default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  update platform_sync_queue
     set locked_until = null,
         last_error = left(p_error, 500),
         next_attempt_at = now() + make_interval(secs => coalesce(p_retry_in_seconds, least(3600, 60 * power(2, greatest(attempts - 1, 0)))::int))
   where id = p_id and done_at is null;
end $$;

-- The backfill sent this record's current state itself: anything queued before it started is done.
create or replace function platform_sync_mark_sent(p_kind text, p_local_id uuid, p_since timestamptz, p_platform_id text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  update platform_sync_queue set done_at = now(), locked_until = null, last_error = null
   where kind = p_kind and local_id = p_local_id and done_at is null and enqueued_at <= p_since;
  insert into platform_links (kind, local_id, platform_id) values (p_kind, p_local_id, p_platform_id)
  on conflict (kind, local_id) do update
    set platform_id = coalesce(excluded.platform_id, platform_links.platform_id), registered_at = now();
end $$;

-- ------------------------------------------------------------ a school's own organisation (backfill)
-- Every school belongs to an organisation; a single school gets its own,
-- named after it. The same two writes Schools' staff console makes
-- (createOrganization, then assignTenantOrganization), in one transaction:
-- a 'group_owner' organisation with the school's name, county and first
-- school admin's address, active (it has no admins, so its status cuts
-- nobody off), and the school moved into it. Its slug is the school's, or
-- the school's with -school (and a number) when that is taken.
create or replace function platform_create_school_organization(p_tenant_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  t tenants;
  v_slug text;
  v_try int := 1;
  v_email text;
  v_org uuid;
begin
  select * into t from tenants where id = p_tenant_id for update;
  if not found then raise exception 'no school %', p_tenant_id using errcode = 'P0002'; end if;
  if t.organization_id is not null then return t.organization_id; end if;

  v_slug := t.slug;
  while exists (select 1 from organizations where slug = v_slug) loop
    -- at most 28 + "-school-NN": the 40-character slug limit
    v_slug := rtrim(left(t.slug, 28), '-') || '-school' || case when v_try = 1 then '' else '-' || v_try end;
    v_try := v_try + 1;
  end loop;

  select coalesce(nullif(trim(p.email), ''), u.email) into v_email
    from profiles p left join auth.users u on u.id = p.id
   where p.tenant_id = t.id and p.role = 'school_admin'
     and coalesce(nullif(trim(p.email), ''), u.email) not like '%.figbloom.internal'
   order by p.created_at, p.id limit 1;

  insert into organizations (name, slug, kind, county, contact_email, status)
  values (t.name, v_slug, 'group_owner', t.county, v_email, 'active')
  returning id into v_org;
  update tenants set organization_id = v_org where id = t.id;
  return v_org;
end $$;

-- ------------------------------------------------------------ applying a decision (platform-decisions, reconcile, registration)
-- One transaction: the delivery is noted (a repeat answers 'duplicate'), a
-- decision older than the last one applied answers 'stale', and otherwise
-- organizations.status is set, with the same audit Schools gives a console
-- change: one event on each of the organisation's schools that their admins
-- can read ("Figbloom"), and one with no school, for Figbloom staff only,
-- naming who decided. Outcomes: applied | unchanged | duplicate | stale |
-- not_found | invalid.
create or replace function platform_apply_organization_decision(
  p_organization_id uuid, p_status text, p_reason text, p_decided_by text,
  p_decided_at timestamptz, p_delivery_id text default null, p_source text default 'webhook'
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  o organizations;
  v_last timestamptz;
  v_reason text := left(nullif(trim(p_reason), ''), 500);
  v_by text := left(coalesce(nullif(trim(p_decided_by), ''), 'platform'), 200);
  v_changes jsonb;
  v_verb text;
begin
  perform set_config('figbloom.self_audited', 'true', true);   -- its own audit events (FIG-1326)

  if p_delivery_id is not null then
    insert into platform_webhook_deliveries (delivery_id, organization_id, outcome)
    values (p_delivery_id, p_organization_id, 'received')
    on conflict (delivery_id) do nothing;
    if not found then return jsonb_build_object('outcome', 'duplicate'); end if;
  end if;

  if p_status is null or p_status not in ('pending', 'active', 'suspended', 'rejected') then
    if p_delivery_id is not null then
      update platform_webhook_deliveries set outcome = 'invalid' where delivery_id = p_delivery_id;
    end if;
    return jsonb_build_object('outcome', 'invalid');
  end if;

  select * into o from organizations where id = p_organization_id for update;
  if not found then
    if p_delivery_id is not null then
      update platform_webhook_deliveries set outcome = 'not_found' where delivery_id = p_delivery_id;
    end if;
    return jsonb_build_object('outcome', 'not_found');
  end if;

  select decided_at into v_last from platform_organization_decisions where organization_id = o.id;
  if v_last is not null and p_decided_at is not null and p_decided_at < v_last then
    update platform_webhook_deliveries set outcome = 'stale' where delivery_id = p_delivery_id;
    return jsonb_build_object('outcome', 'stale', 'status', o.status);
  end if;

  insert into platform_organization_decisions (organization_id, status, status_reason, decided_at, applied_at, last_checked_at, needs_check)
  values (o.id, p_status, v_reason, p_decided_at, now(), now(), false)
  on conflict (organization_id) do update
    set status = excluded.status, status_reason = excluded.status_reason,
        decided_at = coalesce(excluded.decided_at, platform_organization_decisions.decided_at),
        applied_at = now(), last_checked_at = now(), needs_check = false;

  if o.status = p_status then
    update platform_webhook_deliveries set outcome = 'unchanged' where delivery_id = p_delivery_id;
    return jsonb_build_object('outcome', 'unchanged', 'status', o.status);
  end if;

  -- Schools' own mechanism: the column every check reads. The flag lets this one
  -- update past the switch-on guard below, and is cleared at once, so nothing
  -- else later in the same transaction can use it.
  perform set_config('figbloom.platform_decision', 'true', true);
  update organizations set status = p_status where id = o.id;
  perform set_config('figbloom.platform_decision', '', true);

  v_changes := jsonb_build_object('status', jsonb_build_object('from', o.status, 'to', p_status));
  v_verb := case p_status when 'active' then case o.status when 'pending' then 'approved' else 'reactivated' end
                          when 'suspended' then 'suspended' when 'rejected' then 'not approved' else 'set to pending' end;

  -- what the organisation's schools read: Figbloom, and why; never who
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  select t.id, null, 'Figbloom (via Figbloom platform)',
         format('Organization "%s" %s by Figbloom', o.name, v_verb) || coalesce(': ' || v_reason, ''),
         'access',
         jsonb_build_object('table', 'organizations', 'op', 'update', 'via', 'Figbloom platform',
                            'organization_id', o.id, 'reason', v_reason, 'changes', v_changes)
    from tenants t where t.organization_id = o.id;

  -- what only Figbloom staff read (no school): who decided, and how it arrived
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (null, null, v_by || ' via Figbloom platform',
          format('Organization "%s" %s via Figbloom platform', o.name, v_verb),
          'access',
          jsonb_build_object('table', 'organizations', 'op', 'update', 'via', 'Figbloom platform',
                             'organization_id', o.id, 'decided_by', v_by, 'decided_at', p_decided_at,
                             'delivery_id', p_delivery_id, 'source', p_source, 'reason', v_reason, 'changes', v_changes));

  update platform_webhook_deliveries set outcome = 'applied' where delivery_id = p_delivery_id;
  return jsonb_build_object('outcome', 'applied', 'status', p_status, 'previous', o.status);
end $$;

-- Before switch-on: acknowledged, not applied, and checked first once it is on.
create or replace function platform_note_unapplied_delivery(p_delivery_id text, p_organization_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  insert into platform_webhook_deliveries (delivery_id, organization_id, outcome)
  values (p_delivery_id, p_organization_id, 'not_enabled')
  on conflict (delivery_id) do nothing;
  if exists (select 1 from organizations where id = p_organization_id) then
    insert into platform_organization_decisions (organization_id, status, needs_check)
    select p_organization_id, o.status, true from organizations o where o.id = p_organization_id
    on conflict (organization_id) do update set needs_check = true;
  end if;
  return jsonb_build_object('outcome', 'not_enabled');
end $$;

-- ------------------------------------------------------------ reconcile (platform-sync, hourly)
-- Registered organisations most worth asking about: those flagged (a
-- decision that arrived before switch-on), then never or least recently checked.
create or replace function platform_reconcile_candidates(p_limit int default 50)
returns table (organization_id uuid, status text)
language sql stable security definer set search_path = public as $$
  select o.id, o.status
    from organizations o
    join platform_links l on l.kind = 'organization' and l.local_id = o.id
    left join platform_organization_decisions d on d.organization_id = o.id
   order by coalesce(d.needs_check, false) desc, d.last_checked_at nulls first, o.created_at
   limit greatest(p_limit, 0)
$$;

create or replace function platform_mark_checked(p_organization_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into platform_organization_decisions (organization_id, status, last_checked_at, needs_check)
  select o.id, o.status, now(), false from organizations o where o.id = p_organization_id
  on conflict (organization_id) do update set last_checked_at = now(), needs_check = false;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'platform_sync_claim(int)', 'platform_sync_done(bigint, text)', 'platform_sync_failed(bigint, text, int)',
    'platform_sync_mark_sent(text, uuid, timestamptz, text)', 'platform_create_school_organization(uuid)',
    'platform_apply_organization_decision(uuid, text, text, text, timestamptz, text, text)',
    'platform_note_unapplied_delivery(text, uuid)', 'platform_reconcile_candidates(int)', 'platform_mark_checked(uuid)'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

-- ------------------------------------------------------------ after switch-on, only the platform decides
create or replace function organizations_status_from_platform_only() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status is distinct from old.status
     and platform_decisions_enabled()
     and coalesce(current_setting('figbloom.platform_decision', true), '') <> 'true' then
    raise exception 'Organisation status is decided on the Figbloom platform.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function organizations_status_from_platform_only() from public, anon, authenticated;
create trigger organizations_status_from_platform_only before update of status on organizations
  for each row execute function organizations_status_from_platform_only();

-- ------------------------------------------------------------ the schedule
-- pg_cron calls the platform-sync edge function through pg_net: every minute
-- to send the queue, hourly to reconcile. It needs two Vault secrets, set
-- once per project (README, "Figbloom platform registration"):
--   platform_functions_url   e.g. https://<ref>.supabase.co/functions/v1
--   platform_service_key     the project's service-role key
-- Without them (or without pg_cron/pg_net, e.g. a bare local Postgres) the
-- jobs do nothing and say so; the queue waits, nothing is lost.
create or replace function platform_sync_tick(p_action text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_url text;
  v_key text;
begin
  if to_regclass('vault.decrypted_secrets') is null or to_regproc('net.http_post') is null then
    raise notice 'platform_sync_tick: Vault or pg_net is not available';
    return;
  end if;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'platform_functions_url'$q$ into v_url;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'platform_service_key'$q$ into v_key;
  if v_url is null or v_key is null then
    raise notice 'platform_sync_tick: set the platform_functions_url and platform_service_key Vault secrets';
    return;
  end if;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 55000)'
    using rtrim(v_url, '/') || '/platform-sync',
          jsonb_build_object('action', p_action),
          jsonb_build_object('content-type', 'application/json', 'authorization', 'Bearer ' || v_key);
end $$;
revoke execute on function platform_sync_tick(text) from public, anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron')
     or not exists (select 1 from pg_available_extensions where name = 'pg_net') then
    raise notice 'pg_cron or pg_net is not available here: run platform-sync by hand';
    return;
  end if;
  create extension if not exists pg_cron with schema pg_catalog;
  create extension if not exists pg_net with schema extensions;
  perform cron.unschedule(jobid) from cron.job where jobname in ('platform-sync', 'platform-reconcile');
  perform cron.schedule('platform-sync', '* * * * *', $j$select public.platform_sync_tick('sync')$j$);
  perform cron.schedule('platform-reconcile', '17 * * * *', $j$select public.platform_sync_tick('reconcile')$j$);
end $$;

-- ------------------------------------------------------------ everything that exists today waits for the backfill
-- (no rows are queued here: the backfill registers every record with today's status, which a plain sync can't)
