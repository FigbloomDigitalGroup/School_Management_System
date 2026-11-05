-- Schools -> HR one-click sign-in ("handoff"), Schools' part (SCHOOLS_HR_HANDOFF_CONTRACT.md section 3).
--
--   The "HR & Payroll" item in the web console's sidebar, and the open-hr function behind it: open-hr asks the
--   platform for a one-time HR sign-in link (POST /handoffs) for the person clicking, and the browser opens it.
--
--   Switch: platform_settings 'PLATFORM_HANDOFF_ENABLED' (off). While off nobody sees the item and open-hr refuses.
--
--   Who: a school's own admin, an org admin for a school of their organisation (acting inside it), or a teacher or
--     other staff member holding the fees area (the bursar). Figbloom staff (super_admin) don't: HR has no account for
--     them. HR decides real access; Schools only hides the item from people who can't use it.
--
--   Whether HR is on for a school. The platform doesn't relay platform.module.enabled to Schools, and its tenant
--     lookup (GET /tenants/{id}) is console-only, so Schools learns it from POST /handoffs itself: 201 means HR is
--     on and linked, 409 target_not_enabled / target_not_linked / target_no_handoff_url means it isn't (yet).
--     open-hr records each answer in platform_module_status. The item shows while the answer is unknown or yes,
--     and hides for an hour after a no; after the hour it shows again and the next click asks again. A school the
--     platform doesn't know yet (its registration hasn't been delivered: platform_links) never shows it.
--
--   hr_handoff_status(school) is the one rule, for the web (as the signed-in person) and for open-hr (which calls
--   it with the caller's own JWT). Someone who may not have the item at that school is refused (42501), so the
--   answer says nothing about another school; for everyone else it is 'off' | 'not_linked' | 'not_enabled' |
--   'available'.
--
-- supabase/rls-checks/platform_hr_handoff.sql checks it.

insert into platform_settings (key, value) values ('PLATFORM_HANDOFF_ENABLED', 'false') on conflict (key) do nothing;

-- What the platform last said about a product for a school: from open-hr's POST /handoffs answers.
create table platform_module_status (
  tenant_id  uuid not null references tenants on delete cascade,
  module     text not null check (module ~ '^[a-z][a-z0-9_]{0,30}$'),
  enabled    boolean not null,
  -- the platform's refusal code when not enabled (target_not_enabled, target_not_linked, target_no_handoff_url)
  reason     text check (reason is null or length(reason) <= 64),
  checked_at timestamptz not null default now(),
  primary key (tenant_id, module)
);
alter table platform_module_status enable row level security;  -- no policies: the service role and SQL only
revoke all on platform_module_status from anon, authenticated;

create or replace function platform_handoff_enabled() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select value = 'true'::jsonb from platform_settings where key = 'PLATFORM_HANDOFF_ENABLED'), false)
$$;
revoke execute on function platform_handoff_enabled() from public, anon, authenticated;
grant execute on function platform_handoff_enabled() to service_role;

-- The rule (see the top). has_perm(school, 'fees') is the school's admin, an org admin of its (active)
-- organisation, or a teacher or other staff member holding the fees area there; Figbloom staff are left out.
-- A "no" from the platform hides the item for an hour.
create or replace function hr_handoff_status(p_tenant_id uuid) returns text
language plpgsql stable security definer set search_path = public as $
begin
  if p_tenant_id is null or auth.uid() is null or is_super() or not has_perm(p_tenant_id, 'fees') then
    raise exception 'HR & Payroll is for the school''s administrators and the bursar.' using errcode = '42501';
  end if;
  if not platform_handoff_enabled() then return 'off'; end if;
  if not exists (select 1 from platform_links where kind = 'tenant' and local_id = p_tenant_id) then return 'not_linked'; end if;
  if exists (select 1 from platform_module_status s
              where s.tenant_id = p_tenant_id and s.module = 'hr' and not s.enabled
                and s.checked_at > now() - interval '1 hour') then
    return 'not_enabled';
  end if;
  return 'available';
end $;
revoke execute on function hr_handoff_status(uuid) from public, anon;
grant execute on function hr_handoff_status(uuid) to authenticated, service_role;

-- open-hr's record of the platform's answer (service role only).
create or replace function platform_record_module_status(p_tenant_id uuid, p_module text, p_enabled boolean, p_reason text default null)
returns void
language sql security definer set search_path = public as $$
  insert into platform_module_status (tenant_id, module, enabled, reason, checked_at)
  values (p_tenant_id, p_module, p_enabled, case when p_enabled then null else left(p_reason, 64) end, now())
  on conflict (tenant_id, module) do update
    set enabled = excluded.enabled, reason = excluded.reason, checked_at = excluded.checked_at
$$;
revoke execute on function platform_record_module_status(uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function platform_record_module_status(uuid, text, boolean, text) to service_role;
