-- The two functions of 20261104910000 that suspend or restore one school because of its organisation write their own
-- audit event (the school reads "Figbloom" and the reason) and update tenants, an audited table, so like every such
-- function (FIG-1326, 20261104100000) they set figbloom.self_audited: the school gets their line, not a second, generic
-- "Schools" line for the same change. supabase/rls-checks/audit_log.sql checks every such function.

create or replace function suspend_school_with_organization(p_tenant_id uuid, p_organization_id uuid, p_why text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  t tenants;
  o organizations;
  v_platform boolean := coalesce(current_setting('figbloom.platform_decision', true), '') = 'true';
  v_reason text;
begin
  perform set_config('figbloom.self_audited', 'true', true);  -- its own audit event (FIG-1326)
  select * into t from tenants where id = p_tenant_id for update;
  select * into o from organizations where id = p_organization_id;
  if t.id is null or o.id is null then return false; end if;
  if t.status = 'suspended' then
    -- already suspended: only if the old organisation caused it does the new one take it over
    update organization_suspended_schools set organization_id = o.id, suspended_at = now() where tenant_id = t.id;
    return false;
  end if;
  if v_platform then
    select d.status_reason into v_reason from platform_organization_decisions d where d.organization_id = o.id;
  end if;
  insert into organization_suspended_schools (tenant_id, organization_id) values (t.id, o.id)
  on conflict (tenant_id) do update set organization_id = excluded.organization_id, suspended_at = now();
  update tenants
     set status = 'suspended',
         status_reason = left(format('Organization "%s" %s', o.name, case o.status when 'rejected' then 'not approved' else 'suspended' end)
                              || coalesce(': ' || v_reason, ''), 500)
   where id = t.id;
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (t.id, null, case when v_platform then 'Figbloom (via Figbloom platform)' else 'Figbloom' end,
          format('School suspended with its organization "%s"', o.name) || coalesce(': ' || v_reason, ''),
          'access',
          jsonb_build_object('table', 'tenants', 'op', 'update', 'via', case when v_platform then 'Figbloom platform' else 'Schools console' end,
                             'organization_id', o.id, 'reason', v_reason, 'why', p_why,
                             'changes', jsonb_build_object('status', jsonb_build_object('from', t.status::text, 'to', 'suspended'))));
  return true;
end $$;

create or replace function restore_school_from_organization(p_tenant_id uuid, p_why text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  t tenants;
  v_platform boolean := coalesce(current_setting('figbloom.platform_decision', true), '') = 'true';
  v_to tenant_status;
begin
  perform set_config('figbloom.self_audited', 'true', true);  -- its own audit event (FIG-1326)
  delete from organization_suspended_schools where tenant_id = p_tenant_id;
  select * into t from tenants where id = p_tenant_id for update;
  if t.id is null or t.status <> 'suspended' then return false; end if;
  v_to := coalesce(t.status_before_suspension, 'active');
  update tenants set status = v_to, status_reason = null where id = t.id;
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (t.id, null, case when v_platform then 'Figbloom (via Figbloom platform)' else 'Figbloom' end,
          'School reactivated with its organization', 'access',
          jsonb_build_object('table', 'tenants', 'op', 'update', 'via', case when v_platform then 'Figbloom platform' else 'Schools console' end,
                             'organization_id', t.organization_id, 'why', p_why,
                             'changes', jsonb_build_object('status', jsonb_build_object('from', 'suspended', 'to', v_to::text))));
  return true;
end $$;
