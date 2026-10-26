-- A suspended school or organization kept full access.
--
-- tenants.status = 'suspended' and organizations.status = 'suspended' were only
-- labels: nothing in RLS read them, and Supabase Auth doesn't know about them
-- either, so everyone at a suspended school could still sign in and read and
-- write everything, and a suspended organization's admins kept the console for
-- every member school.
--
-- Three layers, because a policy alone can't stop someone signing in:
--
--   1. my_tenant() answers a sentinel id that matches no school for anyone at a
--      suspended school (a super admin is unaffected). `tenant_id = my_tenant()`
--      is then false in the ~100 policies that use it, my_students() and
--      my_family_class_ids() come back empty, and may_administer() is false for
--      that school's own admin. It is a sentinel, not NULL, on purpose: NULL would
--      make `not may_administer(...)` NULL, and an `if not ... then raise` guard
--      would silently let the caller through.
--   2. my_organization_tenant_ids() is empty for a suspended organization, so its
--      admins lose the member schools (may_administer, tenant_read_own). They can
--      still read their own organization row, which is how the console says why.
--   3. Suspending a school bans its users in Supabase Auth (banned_until), and
--      reactivating it lifts the ban for exactly the users banned that way. A banned
--      user can't sign in or refresh a session, so a parent or learner, whose
--      policies read the guardians/students tables directly rather than through
--      my_tenant(), is shut out as soon as their current access token (up to an
--      hour) runs out.
--
-- What still works for a suspended school's users: nothing but their own profile
-- row, until the ban stops them reaching it. Edge functions run as the service
-- role and are unaffected, so a payment already in flight is still recorded.
-- Un-suspending is a super-admin action and needs none of this.
--
-- Only 'suspended' blocks. 'overdue', 'trial', 'onboarding' and 'setup_stalled'
-- all keep working: the school's admin needs the console to finish setup or pay.

-- ------------------------------------------------------------ 1. my_tenant()
create or replace function my_tenant() returns uuid
language sql stable security definer set search_path = public as $$
  select case
           when t.status = 'suspended' and p.role <> 'super_admin' then '00000000-0000-0000-0000-000000000000'::uuid
           else p.tenant_id
         end
    from profiles p
    left join tenants t on t.id = p.tenant_id
   where p.id = auth.uid()
$$;

-- ------------------------------------------------------------ 2. organizations
create or replace function my_organization_tenant_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select t.id
    from tenants t
    join organization_admins oa on oa.organization_id = t.organization_id
    join organizations o on o.id = oa.organization_id
   where oa.profile_id = auth.uid()
     and o.status = 'active'
$$;

-- ------------------------------------------------------------ 3. the Auth ban
-- A ban far enough away to read as permanent; GoTrue parses banned_until into a
-- Go time, which 'infinity' would not survive. Someone already banned for another
-- reason is left alone, and the users we ban carry a flag in app_metadata so that
-- lifting the suspension un-bans exactly them.
create or replace function sync_tenant_suspension() returns trigger
language plpgsql security definer set search_path = public, auth as $$
begin
  if new.status = 'suspended' then
    update auth.users u
       set banned_until = now() + interval '100 years',
           raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb) || '{"suspended_with_school": true}'::jsonb
     where u.id in (select p.id from profiles p where p.tenant_id = new.id and p.role <> 'super_admin')
       and (u.banned_until is null or u.banned_until < now());
  else
    update auth.users u
       set banned_until = null,
           raw_app_meta_data = u.raw_app_meta_data - 'suspended_with_school'
     where u.id in (select p.id from profiles p where p.tenant_id = new.id)
       and u.raw_app_meta_data ->> 'suspended_with_school' = 'true';
  end if;
  return new;
end $$;

create trigger tenants_sync_suspension after update of status on tenants
  for each row
  when (old.status is distinct from new.status and (new.status = 'suspended' or old.status = 'suspended'))
  execute function sync_tenant_suspension();

-- Schools that are already suspended when this runs.
update auth.users u
   set banned_until = now() + interval '100 years',
       raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb) || '{"suspended_with_school": true}'::jsonb
 where u.id in (select p.id from profiles p join tenants t on t.id = p.tenant_id
                 where t.status = 'suspended' and p.role <> 'super_admin')
   and (u.banned_until is null or u.banned_until < now());
