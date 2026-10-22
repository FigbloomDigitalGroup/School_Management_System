-- Parents (and students) see their child's bus on the live map and should
-- know who is driving it -- name and photo -- but profile_read_self only
-- lets staff read another profile's row, so embedding the assigned driver's
-- profile from a parent is silently dropped by RLS.
--
-- Same shape as teacher_names() (20260923000000): a narrow, security-definer
-- lookup returning only what a family needs to recognise the driver (name,
-- photo, title), only for role = 'driver', only within the caller's own
-- tenant -- not a wider profile policy that would also expose a driver's
-- phone, email or login.
create or replace function driver_profiles(driver_ids uuid[])
returns table(id uuid, full_name text, avatar_url text, staff_title text)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.avatar_url, p.staff_title from profiles p
  where p.id = any(driver_ids) and p.tenant_id = my_tenant() and p.role = 'driver'
$$;

grant execute on function driver_profiles(uuid[]) to authenticated;
