-- FIG-1468: next_login_number reserves the number it hands out, so simultaneous account creations get different numbers.
--
-- next_login_number(school, role) was "the highest number among the role's accounts, plus one": it read, it did not reserve. Until the
-- caller's profile row was inserted, every other caller was handed the same number. Six provision-student calls fired at the same moment
-- for six learners made one login (ST-0004) and failed five with "Database error creating new user" (the sign-in service refusing the
-- second account with the same synthetic email); the unique keys kept the data consistent, but the person saw the raw sign-in text, and
-- the winner's number was already issued.
--
-- A counter row per school and role is now incremented in one statement (insert ... on conflict do update), so the database serialises
-- callers on that row and each gets the next number. The counter never goes down, so a number that was handed out is never handed out
-- again: when the newest account is removed the next one no longer takes its number (an old ID card, message or audit line naming the
-- old ID could otherwise mean someone else; the QA 08 note on login IDs). The counter also never falls behind the accounts that exist
-- (accounts made by the seed or an import with their own numbers): each call takes the larger of the counter and the highest number
-- in use, plus one.
--
-- The counter table is written only by this function: row-level security is on and no policy grants anyone access. The function stays
-- callable by the service role only, as before (the edge functions that create accounts call it).

create table if not exists login_counters (
  tenant_id uuid not null references tenants(id) on delete cascade,
  role text not null,
  n integer not null,
  primary key (tenant_id, role)
);
alter table login_counters enable row level security;
revoke all on login_counters from anon, authenticated;

create or replace function next_login_number(p_tenant_id uuid, p_role text) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_top integer;
  v_n integer;
begin
  select coalesce(max((substring(login_id from '[0-9]+$'))::int), 0) into v_top
    from profiles
   where tenant_id = p_tenant_id and role::text = p_role and login_id ~ '[0-9]+$';

  insert into login_counters as c (tenant_id, role, n)
  values (p_tenant_id, p_role, v_top + 1)
  on conflict (tenant_id, role) do update set n = greatest(c.n, v_top) + 1
  returning c.n into v_n;

  return v_n;
end $$;
