-- FIG-1338: the first-sign-in flag is cleared by choosing a password, not
-- by asking for it to be cleared.
--
-- While profiles.must_change_password is set, the apps show only "choose
-- your password". But the flag was cleared by a separate, plain update of
-- the profile after the password call, which the user's own session was
-- allowed to make on its own: a direct update of the flag, with the
-- temporary password still in place, skipped the change for good.
--
-- Now:
--   * a trigger on auth.users clears the flag when the account's password
--     actually changes (encrypted_password), whoever changes it. The admin
--     reset (reset-user-password) sets the new temporary password first and
--     the flag after, so it still ends up set;
--   * a person editing their own profile can't clear it: the guard keeps it
--     set, quietly, so an older app that still sends the clear after
--     changing the password carries on (by then the trigger has cleared it).
--
-- The 8-character rule the form asks for is Auth's own setting
-- (minimum_password_length = 8 in supabase/config.toml for the local stack;
-- set the same under Authentication > Providers > Email on hosted).
--
-- Not done: refusing every other request while the flag is set. Whoever
-- holds the temporary password can choose a new one first anyway, so that
-- would stop nobody (see the issue).

create or replace function clear_first_password_flag() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password then
    update profiles set must_change_password = false where id = new.id and must_change_password;
  end if;
  return new;
end $$;
revoke execute on function clear_first_password_flag() from public, anon, authenticated;

drop trigger if exists on_auth_password_changed on auth.users;
create trigger on_auth_password_changed after update of encrypted_password on auth.users
  for each row execute function clear_first_password_flag();

-- The guard: added to its current body, before the driver's photo rule; the
-- migration stops if that line isn't there.
do $$
declare
  def text := pg_get_functiondef('guard_profile_self_edit'::regproc);
  -- no line ending in the anchor: a body applied from a Windows checkout ends its lines in \r\n
  anchor text := '  if old.role = ''driver'' and new.avatar_url is distinct from old.avatar_url then';
begin
  if def ~ 'FIG-1338' then return; end if;
  if position(anchor in def) = 0 then
    raise exception 'guard_profile_self_edit() has changed shape; add the first-password rule by hand';
  end if;
  def := replace(def, anchor, $add$  -- the first-sign-in flag clears when the password changes (FIG-1338), never on its own
  if old.must_change_password and not new.must_change_password then
    new.must_change_password := true;
  end if;

$add$ || anchor);
  execute def;
end $$;
