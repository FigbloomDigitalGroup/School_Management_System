-- Fix for a bug in FIG-332's trg_refresh_org_summary_for_tenant(): it
-- referenced NEW.tenant_id unconditionally, but NEW does not exist for
-- DELETE operations — every delete of a students/attendance/fee_invoices row
-- was failing outright with "record 'new' has no field 'tenant_id'" (caught
-- live: a test cleanup silently couldn't delete students it had created).
create or replace function trg_refresh_org_summary_for_tenant() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    perform refresh_organization_tenant_summary(old.tenant_id);
  else
    perform refresh_organization_tenant_summary(new.tenant_id);
  end if;
  return null;
end $$;

-- The tenants-delete trigger reused that same function, which expects a
-- .tenant_id field — a tenants row has .id, not .tenant_id, so this would
-- have hit the identical class of error the moment a tenant was deleted.
-- Unneeded regardless: organization_tenant_summary.tenant_id already
-- references tenants on delete cascade, so the summary row is removed
-- automatically without any trigger needed on the tenants side for deletes.
drop trigger if exists refresh_org_summary_tenants_delete on tenants;
