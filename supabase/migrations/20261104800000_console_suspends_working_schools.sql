-- The Figbloom console suspends working schools only (Mike, 2026-11-02).
--
-- platform_console_set_school_status() (20261104600000) suspended a school
-- from any status. Now it suspends only a school that is active, on trial or
-- overdue: the schools whose people can sign in. A school still onboarding or
-- whose setup stalled answers not_settable (422 status_not_settable), as
-- before for a status the console can't set; an already suspended school
-- still answers already (409). Reactivating is unchanged: it restores the
-- status the school had, which tenants_status_bookkeeping records on the way
-- in, so a trial or overdue school goes back to trial or overdue.
--
-- Only this function changes; the rest of 20261104600000 is untouched.
-- supabase/rls-checks/platform_console.sql checks it.

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

  select t.status, t.status_before_suspension, t.name into v_old, v_before, v_name
    from tenants t where t.id = p_school_id for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if p_status = 'suspended' and v_old = 'suspended' then
    return jsonb_build_object('outcome', 'already');
  end if;
  -- only a working school: one still being set up isn't the console's to suspend
  if p_status = 'suspended' and v_old not in ('active', 'trial', 'overdue') then
    return jsonb_build_object('outcome', 'not_settable');
  end if;
  if p_status = 'active' and v_old <> 'suspended' then
    return jsonb_build_object('outcome', 'not_suspended');
  end if;

  -- suspend, or reactivate to the status it had; tenants_sync_suspension and
  -- tenants_status_bookkeeping do the rest, exactly as for Schools' own console
  v_new := case p_status when 'suspended' then 'suspended'::tenant_status else coalesce(v_before, 'active') end;
  update tenants set status = v_new, status_reason = v_reason where id = p_school_id;
  v_changes := jsonb_build_object('status', jsonb_build_object('from', v_old::text, 'to', v_new::text));

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
