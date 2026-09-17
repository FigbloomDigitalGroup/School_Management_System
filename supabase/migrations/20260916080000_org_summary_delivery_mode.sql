-- FIG-367: surface delivery_mode in the org-admin console, same reasoning
-- and shape as FIG-364's higher_ed_subtype addition.
alter table organization_tenant_summary add column delivery_mode delivery_mode not null default 'in_person';

create or replace function refresh_organization_tenant_summary(p_tenant_id uuid) returns void
language plpgsql security definer set search_path = public as $$
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
    (select count(*) from attendance a where a.tenant_id = t.id and a.taken_on = current_date and a.mark = 'present'),
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

update organization_tenant_summary s
set delivery_mode = t.delivery_mode
from tenants t
where t.id = s.tenant_id;
