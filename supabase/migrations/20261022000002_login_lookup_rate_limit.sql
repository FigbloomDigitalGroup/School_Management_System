-- Rate limit for the public resolve-login-id lookup.
--
-- That function answers anyone, signed in or not, with whether a login ID
-- exists at a school (and a masked name). IDs are sequential (PT-0001,
-- PT-0002, ...), so without a limit a script can walk a school's whole
-- roll. Each call records a hashed caller key here and gets back whether
-- it's still within the allowance. Called only by the edge function, with
-- the service role: no policies, no grants to anon or authenticated.

create table login_lookups (
  caller_key text        not null,
  looked_up_at timestamptz not null default now()
);
create index on login_lookups (caller_key, looked_up_at);
alter table login_lookups enable row level security;
-- Supabase grants new public tables to anon/authenticated by default; nobody but the service role has any use for this one.
revoke all on login_lookups from anon, authenticated;

create or replace function note_login_lookup(p_key text, p_limit int, p_window interval)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  insert into login_lookups (caller_key) values (p_key);

  -- keep the table small without a scheduled job: now and then, drop what no window needs any more
  if random() < 0.02 then
    delete from login_lookups where looked_up_at < now() - interval '1 day';
  end if;

  select count(*) into n from login_lookups
   where caller_key = p_key and looked_up_at > now() - p_window;
  return n <= p_limit;
end $$;

revoke execute on function note_login_lookup(text, int, interval) from public, anon, authenticated;
grant execute on function note_login_lookup(text, int, interval) to service_role;
