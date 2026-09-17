-- Backing table for the platform console's Health page (FIG-288). Narrow on
-- purpose: this only tracks the external services the app actually depends
-- on, checked live when a super_admin opens the page (no cron/pg_net
-- infrastructure needed for a v1) — not a multi-region uptime model that
-- doesn't match how this app is actually deployed.

create type service_check_status as enum ('ok', 'degraded', 'down', 'not_configured');

create table service_status (
  id          uuid primary key default gen_random_uuid(),
  service     text not null,
  status      service_check_status not null,
  latency_ms  int,
  detail      text,
  checked_at  timestamptz not null default now()
);
create index on service_status (service, checked_at desc);

alter table service_status enable row level security;

create policy service_status_super on service_status for all
  using (is_super()) with check (is_super());
