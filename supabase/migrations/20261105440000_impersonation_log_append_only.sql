-- FIG-1453: the impersonation log is append only, for everyone.
--
-- The platform page calls it "Support · immutable record", and a school's principal is asked to accept that Figbloom staff may act inside the
-- school because "schools can read their own entries". The people it records are the platform admins, and impersonation_write
-- (for all using is_super()) let a platform admin update or delete any session through the API: change the reason, set ended_at, zero
-- writes_count, or remove the row.
--
-- Now it works the way the audit trail does: there is no insert, update or delete policy, so no signed-in user, the platform admin
-- included, writes the table directly (reading is unchanged: the school's admin and Figbloom staff). A session is started and closed by
-- functions that run as the owner:
--   start_impersonation(tenant, reason, scope)  Figbloom staff only; records the caller as the person acting; a reason is required
--   note_impersonation_write(session)           adds one to writes_count of the caller's own session while it is open
--   end_impersonation(session)                  closes the caller's own session, once; nothing else about it can change
-- Nothing calls them yet: "Impersonate admin" only shows a message (FIG-1446), so making impersonation real is what will use them.
--
-- supabase/rls-checks/report_figures.sql checks it.

drop policy impersonation_write on impersonation_sessions;

create or replace function start_impersonation(p_tenant uuid, p_reason text, p_scope text default 'read_only') returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not is_super() then
    raise exception 'Only Figbloom staff can start an impersonation session.' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required to start an impersonation session.' using errcode = '22023';
  end if;
  insert into impersonation_sessions (tenant_id, staff_id, reason, scope)
    values (p_tenant, auth.uid(), btrim(p_reason), p_scope)
    returning id into v_id;
  return v_id;
end $$;

create or replace function note_impersonation_write(p_session uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  update impersonation_sessions set writes_count = writes_count + 1
   where id = p_session and staff_id = auth.uid() and ended_at is null and is_super()
   returning writes_count into v_count;
  if v_count is null then
    raise exception 'No open impersonation session of yours with that id.' using errcode = '42501';
  end if;
  return v_count;
end $$;

create or replace function end_impersonation(p_session uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update impersonation_sessions set ended_at = now()
   where id = p_session and staff_id = auth.uid() and ended_at is null and is_super();
  if not found then
    raise exception 'No open impersonation session of yours with that id.' using errcode = '42501';
  end if;
end $$;

revoke execute on function start_impersonation(uuid, text, text), note_impersonation_write(uuid), end_impersonation(uuid) from public, anon;
grant execute on function start_impersonation(uuid, text, text), note_impersonation_write(uuid), end_impersonation(uuid) to authenticated;
