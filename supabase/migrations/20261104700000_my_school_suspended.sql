-- "Your school's account is suspended" instead of an empty screen.
--
-- A suspended school's users are banned in Auth, but a session that was
-- already open keeps its access token for up to an hour. In that time
-- my_tenant() answers a no-match id, so the apps can't read the school's row
-- and showed an empty or broken screen, or bounced back to sign-in, with no
-- reason given.
--
-- my_school_suspended() lets the apps tell that case apart: it answers, for
-- the signed-in person only, whether their own school is suspended. It says
-- nothing about anyone else's school, and nothing about why (the reason is
-- for the school's console, not for these screens). Signed-in users only.
--
-- supabase/rls-checks/suspended.sql checks it.

create or replace function my_school_suspended() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select t.status = 'suspended'
       from profiles p
       join tenants t on t.id = p.tenant_id
      where p.id = auth.uid()),
    false)
$$;
revoke execute on function my_school_suspended() from public, anon;
grant execute on function my_school_suspended() to authenticated;
