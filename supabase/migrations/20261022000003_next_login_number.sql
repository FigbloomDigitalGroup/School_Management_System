-- The next login ID number for a role at a school.
--
-- The edge functions that create accounts (invite-admin, provision-guardian,
-- provision-student) used to number IDs as "how many accounts of this role
-- exist, plus one". That breaks in two ways:
--   * delete-account removes staff, so after deleting one of five teachers
--     the next ID is computed as TC-0005 -- which exists -- and adding a
--     teacher fails ("That email is already in use") until someone is added
--     some other way, i.e. never;
--   * a query returns at most 1000 rows, so in a school with more than 1000
--     learners every new one is counted as the 1001st.
-- One past the highest number already issued has neither problem: it can
-- never collide with an ID that exists. (If the highest-numbered account is
-- the one deleted, its number is offered again -- to a new person, never to
-- two people at once.)
--
-- Two accounts created at the same instant can still be offered the same
-- number; the second then fails on the unique (tenant_id, login_id) and the
-- auth email, and the admin simply tries again.

create or replace function next_login_number(p_tenant_id uuid, p_role text)
returns int
language sql stable security definer set search_path = public as $$
  select coalesce(max((substring(login_id from '[0-9]+$'))::int), 0) + 1
    from profiles
   where tenant_id = p_tenant_id
     and role::text = p_role
     and login_id ~ '[0-9]+$'
$$;

revoke execute on function next_login_number(uuid, text) from public, anon, authenticated;
grant execute on function next_login_number(uuid, text) to service_role;
