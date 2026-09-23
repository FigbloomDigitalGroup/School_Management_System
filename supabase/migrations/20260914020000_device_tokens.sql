-- Push notifications (FIG-293), Android first — iOS needs Apple Developer
-- push credentials that don't exist yet, deferred.
--
-- A device claims a token for whichever profile is signed in on it right
-- now (`token` is globally unique, upserted on conflict) — a device shared
-- across family members who sign out/in only gets push for the most
-- recently signed-in profile, which is an accepted v1 limitation, not a bug.
create table device_tokens (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles on delete cascade,
  token      text not null unique,
  platform   text not null check (platform in ('android', 'ios')),
  created_at timestamptz not null default now()
);
create index on device_tokens (profile_id);

alter table device_tokens enable row level security;

-- A signed-in user registers/re-claims/removes only their own device's token.
-- The send-push edge function reads across all tokens via the service role,
-- which bypasses RLS entirely.
create policy device_tokens_own on device_tokens for all
  using (profile_id = auth.uid()) with check (profile_id = auth.uid());
