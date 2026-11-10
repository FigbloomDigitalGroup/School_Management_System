-- FIG-1408: the group dashboard's "present today" counts the learners who arrived late, as every school screen does.
--
-- refresh_organization_tenant_summary counted attendance with mark = 'present' only. The school Dashboard, Reports, the parent screen and the
-- report cards all count present + late as here ("a late arrival still attended"), so the two dashboards disagreed about the same day: for ten
-- Kijani Ridge learners (5 present, 2 late, 2 absent, 1 excused) the group dashboard said 5 and the school's own screens said 7.
--
-- The function is otherwise as it was (same columns, same security definer, same grants: create or replace keeps them). The summary's
-- "today" is still current_date and the row is still refreshed when something is written; those are FIG-1444, a separate issue.

create or replace function refresh_organization_tenant_summary(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from tenants where id = p_tenant_id) then
    delete from organization_tenant_summary where tenant_id = p_tenant_id;
    return;
  end if;

  insert into organization_tenant_summary (
    tenant_id, organization_id, name, institution_type, higher_ed_subtype, delivery_mode, status,
    active_students, present_today, fees_billed_cents, fees_collected_cents, updated_at
  )
  select
    t.id, t.organization_id, t.name, t.institution_type, t.higher_ed_subtype, t.delivery_mode, t.status,
    (select count(*) from students s where s.tenant_id = t.id and s.active),
    (select count(*) from attendance a where a.tenant_id = t.id and a.taken_on = current_date and a.mark in ('present', 'late')),
    (select coalesce(sum(fi.total_cents), 0) from fee_invoices fi where fi.tenant_id = t.id),
    (select coalesce(sum(fi.paid_cents), 0) from fee_invoices fi where fi.tenant_id = t.id),
    now()
  from tenants t
  where t.id = p_tenant_id
  on conflict (tenant_id) do update set
    organization_id = excluded.organization_id,
    name = excluded.name,
    institution_type = excluded.institution_type,
    higher_ed_subtype = excluded.higher_ed_subtype,
    delivery_mode = excluded.delivery_mode,
    status = excluded.status,
    active_students = excluded.active_students,
    present_today = excluded.present_today,
    fees_billed_cents = excluded.fees_billed_cents,
    fees_collected_cents = excluded.fees_collected_cents,
    updated_at = now();
end $$;
