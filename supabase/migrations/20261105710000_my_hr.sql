-- "My HR" (Phase 2 step 1, view only), Schools' part (SCHOOLS_HR_PHASE2_CONTRACT.md section 3).
--
--   A My HR page in the teacher and staff consoles (and the admin console, for the school's own admins as staff):
--   payslips, leave, attendance and KPIs from Figbloom HR, read through the my-hr function, which calls HR's
--   /api/integrations/my-hr/* with Schools' platform token and the caller's own school and profile id.
--
--   Switch: platform_settings 'MY_HR_ENABLED' (off). While off nobody sees the page and my-hr refuses.
--
--   Who: an active, non-archived staff profile of a school (teacher, driver, other staff, school admin), at a
--     school that isn't suspended. Org admins acting for a school and Figbloom staff are not that school's staff
--     (HR has no employee for them). HR answers only for the employee linked to that profile (external_people).
--
--   Whether HR is on for the school: the same knowledge #254 (20261105700000) has, nothing new is stored:
--     - the school must be known to the platform (platform_links 'tenant'), or nothing can be resolved in HR;
--     - platform_module_status ('hr'), written by open-hr from the platform's answer to POST /handoffs: a
--       target_not_enabled / target_not_linked "no" in the last hour hides the page. target_no_handoff_url does
--       not: it only means HR can't take sign-ins yet, and My HR doesn't sign anyone in.
--     Whether this person's HR record is ready (linked, approved) is HR's answer, per person, on the page itself.
--
--   my_hr_status() is the one rule, for the web (as the signed-in person) and for my-hr (which calls it with the
--   caller's own JWT). It takes no arguments: the school and the person are the caller's own, so it can say
--   nothing about anyone else. 'not_staff' | 'off' | 'not_linked' | 'not_enabled' | 'available'.
--
-- No new table. supabase/rls-checks/my_hr.sql checks it.

insert into platform_settings (key, value) values ('MY_HR_ENABLED', 'false') on conflict (key) do nothing;

create or replace function my_hr_enabled() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select value = 'true'::jsonb from platform_settings where key = 'MY_HR_ENABLED'), false)
$$;
revoke execute on function my_hr_enabled() from public, anon, authenticated;
grant execute on function my_hr_enabled() to service_role;

create or replace function my_hr_status() returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid;
begin
  select p.tenant_id into v_tenant
    from profiles p
    join tenants t on t.id = p.tenant_id
   where p.id = auth.uid()
     and platform_is_staff_role(p.role)
     and p.archived_at is null
     and t.status is distinct from 'suspended';
  if v_tenant is null then return 'not_staff'; end if;
  if not my_hr_enabled() then return 'off'; end if;
  if not exists (select 1 from platform_links where kind = 'tenant' and local_id = v_tenant) then return 'not_linked'; end if;
  if exists (select 1 from platform_module_status s
              where s.tenant_id = v_tenant and s.module = 'hr' and not s.enabled
                and s.reason in ('target_not_enabled', 'target_not_linked')
                and s.checked_at > now() - interval '1 hour') then
    return 'not_enabled';
  end if;
  return 'available';
end $$;
revoke execute on function my_hr_status() from public, anon;
grant execute on function my_hr_status() to authenticated, service_role;
