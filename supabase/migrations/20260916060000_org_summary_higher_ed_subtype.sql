-- FIG-364: surface higher_ed_subtype in the org-admin console. The summary
-- table already denormalizes institution_type for the same reason (org_admin
-- has zero direct RLS access to tenants) — this adds the one more column.
alter table organization_tenant_summary add column higher_ed_subtype higher_ed_subtype;

create or replace function refresh_organization_tenant_summary(p_tenant_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from tenants where id = p_tenant_id) then
    delete from organization_tenant_summary where tenant_id = p_tenant_id;
    return;
  end if;

  insert into organization_tenant_summary (
    tenant_id, organization_id, name, institution_type, higher_ed_subtype, status,
    active_students, present_today, fees_billed_cents, fees_collected_cents, updated_at
  )
  select
    t.id, t.organization_id, t.name, t.institution_type, t.higher_ed_subtype, t.status,
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
    status = excluded.status,
    active_students = excluded.active_students,
    present_today = excluded.present_today,
    fees_billed_cents = excluded.fees_billed_cents,
    fees_collected_cents = excluded.fees_collected_cents,
    updated_at = now();
end $$;

-- Backfill existing rows so the new column isn't null for tenants that
-- already had a summary row before this migration.
update organization_tenant_summary s
set higher_ed_subtype = t.higher_ed_subtype
from tenants t
where t.id = s.tenant_id;
