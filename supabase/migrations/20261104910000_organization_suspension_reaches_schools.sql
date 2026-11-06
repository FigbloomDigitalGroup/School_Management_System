-- Suspending an organisation locks out all its schools (Mike, 2026-11-03).
--
-- Until now an organisation's status reached only its admins
-- (my_organization_tenant_ids(), administersOrganization()): a suspended
-- organisation's teachers, parents and learners carried on. Now, when an
-- organisation becomes 'suspended' or 'rejected' (from a Figbloom platform
-- decision, or from Schools' own console before switch-on), each of its
-- schools that isn't already suspended is suspended through Schools' own
-- school suspension: tenants.status = 'suspended', so tenants_sync_suspension
-- bans its users in Auth, my_tenant() answers the no-match id, and
-- tenants_status_bookkeeping remembers the status it had. Exactly as for a
-- single suspended school.
--
-- organization_suspended_schools records which schools the organisation's
-- suspension touched. When the organisation is no longer suspended or
-- rejected, only those schools are reactivated, each to the status it had
-- before. A school that was suspended on its own before (it isn't recorded),
-- or that Figbloom staff suspend on their own while the organisation is
-- suspended (the console takes the school's suspension over: the record goes),
-- stays suspended.
--
-- The edges:
--   * a school added to a suspended organisation starts suspended;
--   * a school moved to another organisation follows it: into a suspended
--     one it is suspended (or stays suspended, now for that organisation);
--     out of one into a working one, a suspension the old organisation
--     caused is lifted; a suspension of its own stays;
--   * a repeated or older decision changes nothing (only a change of
--     organisation status between locked and not locked does anything, and
--     the decision function already drops repeats and stale decisions);
--   * suspended <-> rejected changes nothing for the schools;
--   * reactivating one school of a suspended organisation from the Figbloom
--     console is refused (reactivate the organisation).
--
-- Audit: each school reads "Figbloom" and the reason; who decided is only in
-- staff-only events (no school): the platform decision's own (decided_by),
-- or, for a change made in Schools' own console, one written here.
--
-- supabase/rls-checks/organization_suspension.sql checks it.

create table organization_suspended_schools (
  tenant_id       uuid primary key references tenants on delete cascade,
  organization_id uuid not null references organizations on delete cascade,
  suspended_at    timestamptz not null default now()
);
create index on organization_suspended_schools (organization_id);
alter table organization_suspended_schools enable row level security;  -- no policies: definer functions only
revoke all on organization_suspended_schools from anon, authenticated;

create or replace function organization_locks_schools(p_status text) returns boolean
language sql immutable as $$ select p_status in ('suspended', 'rejected') $$;

-- One school, because of its organisation: suspended, recorded, audited for the school.
create or replace function suspend_school_with_organization(p_tenant_id uuid, p_organization_id uuid, p_why text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  t tenants;
  o organizations;
  v_platform boolean := coalesce(current_setting('figbloom.platform_decision', true), '') = 'true';
  v_reason text;
begin
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

-- One school whose organisation no longer locks it: back to the status it had.
create or replace function restore_school_from_organization(p_tenant_id uuid, p_why text) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  t tenants;
  v_platform boolean := coalesce(current_setting('figbloom.platform_decision', true), '') = 'true';
  v_to tenant_status;
begin
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

-- ------------------------------------------------------------ the organisation changes status
create or replace function organizations_status_reaches_schools() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_platform boolean := coalesce(current_setting('figbloom.platform_decision', true), '') = 'true';
  v_ids uuid[] := '{}';
  r record;
begin
  if organization_locks_schools(new.status) = organization_locks_schools(old.status) then return null; end if;

  if organization_locks_schools(new.status) then
    for r in select id from tenants where organization_id = new.id order by id loop
      if suspend_school_with_organization(r.id, new.id, 'organization_' || new.status) then v_ids := v_ids || r.id; end if;
    end loop;
  else
    for r in select s.tenant_id from organization_suspended_schools s join tenants t on t.id = s.tenant_id
              where s.organization_id = new.id and t.organization_id = new.id order by s.tenant_id loop
      if restore_school_from_organization(r.tenant_id, 'organization_' || new.status) then v_ids := v_ids || r.tenant_id; end if;
    end loop;
    delete from organization_suspended_schools where organization_id = new.id;  -- anything left over
  end if;

  -- who did it, for Figbloom staff only (a platform decision has written its own, with decided_by)
  if not v_platform and cardinality(v_ids) > 0 then
    insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
    values (null, auth.uid(), case when auth.uid() is null then 'System' else my_actor_label() end,
            format('Organization "%s" %s: %s school(s) %s with it', new.name, new.status, cardinality(v_ids),
                   case when organization_locks_schools(new.status) then 'suspended' else 'reactivated' end),
            'access',
            jsonb_build_object('table', 'organizations', 'op', 'update', 'via', 'Schools console', 'organization_id', new.id,
                               'schools', to_jsonb(v_ids),
                               'changes', jsonb_build_object('status', jsonb_build_object('from', old.status, 'to', new.status))));
  end if;
  return null;
end $$;

create trigger organizations_status_reaches_schools after update of status on organizations
  for each row when (old.status is distinct from new.status)
  execute function organizations_status_reaches_schools();

-- ------------------------------------------------------------ a school joins, moves, or is reactivated otherwise
create or replace function tenants_follow_organization_lock() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_locked boolean := exists (select 1 from organizations o where o.id = new.organization_id and organization_locks_schools(o.status));
  v_by_org boolean := exists (select 1 from organization_suspended_schools s where s.tenant_id = new.id);
begin
  if tg_op = 'INSERT' then
    -- a new school in a suspended organisation starts suspended
    if v_locked then perform suspend_school_with_organization(new.id, new.organization_id, 'added_to_suspended_organization'); end if;
  elsif old.organization_id is distinct from new.organization_id then
    if v_locked then
      perform suspend_school_with_organization(new.id, new.organization_id, 'moved_to_suspended_organization');
    elsif v_by_org then
      -- the suspension came from the organisation it left
      perform restore_school_from_organization(new.id, 'moved_from_suspended_organization');
    end if;
  elsif old.status = 'suspended' and new.status <> 'suspended' then
    -- reactivated some other way (Schools' own console): the organisation no longer holds it
    delete from organization_suspended_schools where tenant_id = new.id;
  end if;
  return null;
end $$;

create trigger tenants_follow_organization_lock_ins after insert on tenants
  for each row execute function tenants_follow_organization_lock();
create trigger tenants_follow_organization_lock_upd after update of organization_id, status on tenants
  for each row execute function tenants_follow_organization_lock();

do $$
declare f text;
begin
  foreach f in array array[
    'suspend_school_with_organization(uuid, uuid, text)', 'restore_school_from_organization(uuid, text)',
    'organizations_status_reaches_schools()', 'tenants_follow_organization_lock()'
  ] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;

-- ------------------------------------------------------------ organisations already suspended today
-- (their schools have carried on until now: lock them, so every suspended organisation means the same)
do $$
declare r record;
begin
  for r in select t.id as tenant_id, o.id as organization_id
             from tenants t join organizations o on o.id = t.organization_id
            where organization_locks_schools(o.status) loop
    perform suspend_school_with_organization(r.tenant_id, r.organization_id, 'organization_already_suspended');
  end loop;
end $$;

-- ------------------------------------------------------------ the Figbloom console, one school at a time
-- As 20261104800000, and: suspending a school its organisation's suspension
-- holds makes the suspension the school's own (it stays suspended when the
-- organisation is reactivated), and reactivating a school whose organisation
-- is suspended or rejected is refused (organization_suspended, 422).
create or replace function platform_console_set_school_status(
  p_school_id uuid, p_status text, p_reason text, p_actor_email text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_reason text := nullif(trim(p_reason), '');
  v_actor text := nullif(trim(p_actor_email), '');
  v_old tenant_status;
  v_before tenant_status;
  v_new tenant_status;
  v_name text;
  v_org uuid;
  v_changes jsonb;
begin
  perform set_config('figbloom.self_audited', 'true', true);  -- its own audit events (FIG-1326)

  if p_status is null or p_status not in ('active', 'suspended') then
    return jsonb_build_object('outcome', 'not_settable');
  end if;
  if v_actor is null then
    raise exception 'actor_email is required' using errcode = '22023';
  end if;
  if p_status = 'suspended' and v_reason is null then
    raise exception 'a reason is required to suspend a school' using errcode = '22023';
  end if;
  if char_length(v_reason) > 500 then
    raise exception 'the reason is longer than 500 characters' using errcode = '22023';
  end if;

  select t.status, t.status_before_suspension, t.name, t.organization_id into v_old, v_before, v_name, v_org
    from tenants t where t.id = p_school_id for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if p_status = 'suspended' and v_old = 'suspended' then
    if not exists (select 1 from organization_suspended_schools where tenant_id = p_school_id) then
      return jsonb_build_object('outcome', 'already');
    end if;
    -- held by its organisation's suspension: now its own, so it stays when the organisation comes back
    delete from organization_suspended_schools where tenant_id = p_school_id;
    update tenants set status_reason = v_reason where id = p_school_id;
    v_changes := jsonb_build_object('status', jsonb_build_object('from', 'suspended', 'to', 'suspended'), 'held_by', jsonb_build_object('from', 'organization', 'to', 'school'));
    v_new := 'suspended';
  else
    -- only a working school: one still being set up isn't the console's to suspend
    if p_status = 'suspended' and v_old not in ('active', 'trial', 'overdue') then
      return jsonb_build_object('outcome', 'not_settable');
    end if;
    if p_status = 'active' and v_old <> 'suspended' then
      return jsonb_build_object('outcome', 'not_suspended');
    end if;
    if p_status = 'active' and exists (select 1 from organizations o where o.id = v_org and organization_locks_schools(o.status)) then
      return jsonb_build_object('outcome', 'organization_suspended');
    end if;

    -- suspend, or reactivate to the status it had; tenants_sync_suspension and
    -- tenants_status_bookkeeping do the rest, exactly as for Schools' own console
    v_new := case p_status when 'suspended' then 'suspended'::tenant_status else coalesce(v_before, 'active') end;
    update tenants set status = v_new, status_reason = v_reason where id = p_school_id;
    v_changes := jsonb_build_object('status', jsonb_build_object('from', v_old::text, 'to', v_new::text));
  end if;

  -- what the school reads: Figbloom did it, and why; no staff member's name or address
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (p_school_id, null, 'Figbloom (via Figbloom console)',
          case p_status when 'suspended' then 'School suspended by Figbloom' else 'School reactivated by Figbloom' end
            || coalesce(': ' || v_reason, ''),
          'access',
          jsonb_build_object('table', 'tenants', 'op', 'update', 'via', 'Figbloom console',
                             'reason', v_reason, 'changes', v_changes));

  -- what only Figbloom staff read (no school, so only super admins): who did it
  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (null, null, v_actor || ' via Figbloom console',
          format('%s "%s" via Figbloom console', case p_status when 'suspended' then 'Suspended' else 'Reactivated' end, v_name),
          'access',
          jsonb_build_object('table', 'tenants', 'op', 'update', 'via', 'Figbloom console', 'school_id', p_school_id,
                             'actor_email', v_actor, 'reason', v_reason, 'changes', v_changes));

  return jsonb_build_object('outcome', 'ok', 'school', platform_console_schools(p_school_id) -> 0);
end $$;
revoke execute on function platform_console_set_school_status(uuid, text, text, text) from public, anon, authenticated;
grant execute on function platform_console_set_school_status(uuid, text, text, text) to service_role;
