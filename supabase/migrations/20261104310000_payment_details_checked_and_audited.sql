-- FIG-1330: the paybill, till and bank details parents pay into are checked,
-- and every change to them is a financial audit event.
--
-- set_school_payment_methods() is what the School settings screen saves
-- through. It's the one setting someone with a school admin's login would
-- change to send fees somewhere else, and it wrote no audit event and kept
-- neither the old nor the new value. (Since 20261104000000 the generic
-- trigger on tenants logs the row change, but as "provisioning", alongside
-- logo and name changes, where a school wouldn't look for it.)
--
-- Now:
--   * a paybill or till is 5 to 7 digits (spaces ignored, digits stored);
--   * a change writes one financial event, "Payment details changed:
--     paybill, bank details", with each changed field's old and new value
--     (the admins who read the log are the ones who can see them anyway);
--   * the generic tenants line is skipped for it (figbloom.self_audited), so
--     the change is logged once, where a school looks for money;
--   * saving with nothing changed writes nothing.
--
-- supabase/rls-checks/fees.sql checks it.

create or replace function set_school_payment_methods(
  p_tenant_id uuid, p_paybill text, p_till text, p_bank_details text, p_notes text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  old_t tenants;
  v_paybill text := nullif(regexp_replace(coalesce(p_paybill, ''), '\s', '', 'g'), '');
  v_till text := nullif(regexp_replace(coalesce(p_till, ''), '\s', '', 'g'), '');
  v_bank text := nullif(trim(p_bank_details), '');
  v_notes text := nullif(trim(p_notes), '');
  changed jsonb;
begin
  perform set_config('figbloom.self_audited', 'true', true);  -- its own audit event (FIG-1326)
  if not may_administer(p_tenant_id) then
    raise exception 'you do not administer this school' using errcode = '42501';
  end if;
  if v_paybill is not null and v_paybill !~ '^[0-9]{5,7}$' then
    raise exception 'The paybill number is 5 to 7 digits.' using errcode = '22023';
  end if;
  if v_till is not null and v_till !~ '^[0-9]{5,7}$' then
    raise exception 'The till number is 5 to 7 digits.' using errcode = '22023';
  end if;

  select * into old_t from tenants where id = p_tenant_id for update;

  select jsonb_object_agg(f.label, jsonb_build_object('from', f.was, 'to', f.now))
    into changed
    from (values ('paybill', old_t.payment_paybill, v_paybill),
                 ('till', old_t.payment_till, v_till),
                 ('bank details', old_t.payment_bank_details, v_bank),
                 ('payment notes', old_t.payment_notes, v_notes)) f(label, was, now)
   where f.was is distinct from f.now;
  if changed is null then return; end if;

  update tenants set
    payment_paybill      = v_paybill,
    payment_till         = v_till,
    payment_bank_details = v_bank,
    payment_notes        = v_notes
  where id = p_tenant_id;

  insert into audit_events (tenant_id, actor_id, actor_label, event, category, metadata)
  values (
    p_tenant_id, auth.uid(), case when auth.uid() is null then 'System' else my_actor_label() end,
    'Payment details changed: ' || (select string_agg(k, ', ' order by k) from jsonb_object_keys(changed) k),
    'financial',
    jsonb_build_object('changes', changed)
  );
end $$;

revoke all on function set_school_payment_methods(uuid, text, text, text, text) from public, anon;
grant execute on function set_school_payment_methods(uuid, text, text, text, text) to authenticated;
