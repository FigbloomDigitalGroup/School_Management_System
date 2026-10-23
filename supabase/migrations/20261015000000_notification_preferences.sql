-- Real backing table for the parent "how we reach you" channel toggles
-- (FIG-872) — previously a purely decorative <Switch> with no persistence
-- anywhere, on both mobile and web.
--
-- One row per profile, created lazily on first write (no row = defaults,
-- same defaults the old hardcoded CHANNELS array used).
create table notification_preferences (
  profile_id        uuid primary key references profiles on delete cascade,
  fee_reminders     boolean not null default true,
  absence_today     boolean not null default true,
  results_published boolean not null default true,
  general_notices   boolean not null default false,
  updated_at        timestamptz not null default now()
);

alter table notification_preferences enable row level security;

-- A signed-in user only ever reads/writes their own row — same shape as
-- device_tokens_own (20260914020000_device_tokens.sql).
create policy notification_preferences_own on notification_preferences for all
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());
